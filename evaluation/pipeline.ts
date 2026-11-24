import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { historyTurns, type Sample } from "./dataset.ts";
import { complete, parseGrade, parsePlan } from "./models.ts";
import { evidenceMetric, normalizeAnswer, tokenF1, type QuestionResult } from "./metrics.ts";
import { resolveModel, type EvalConfig } from "./config.ts";
import type { RecallReviewer } from "../src/recall/recall-workflow.ts";

/** Run only in an isolated worker: DB_PATH is captured when the production DB module is imported. */
export async function evaluateSample(sample: Sample, config: EvalConfig, directory: string): Promise<QuestionResult[]> {
  const home = join(resolve(directory), "home");
  const database = join(resolve(directory), "memory.db");
  assert.equal(process.env.HOME, home, "Worker HOME must be isolated before module imports");
  assert.equal(process.env.USERPROFILE, home, "Worker USERPROFILE must be isolated");
  assert.equal(process.env.MEMORY_DB_PATH, database, "Worker MEMORY_DB_PATH must be isolated");
  assert(!existsSync(database), "Evaluation requires a fresh database");
  mkdirSync(join(home, ".pi", "agent", "pi-session-memory"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify(config.memory), { flag: "wx" });
  const models = {
    planner: resolveModel(config.models.planner), answer: resolveModel(config.models.answer), judge: resolveModel(config.models.judge),
  };
  const questions = sample.qa.map((qa, questionIndex) => ({ qa, questionIndex })).filter(({ qa }) => config.categories.includes(qa.category));
  const selected = config.questionsPerSample === null ? questions : questions.slice(0, config.questionsPerSample);
  assert(selected.length > 0, "No questions match the configured categories");
  const turns = historyTurns(sample);
  const availableIds = new Set(turns.map(turn => turn.dialogueId));
  const dialogueByTurn = new Map(turns.map(turn => [turn.turnId, turn.dialogueId]));
  const { getDb, upsertSession, insertTurn } = await import("../src/history/db.ts");
  const { recallSequentially } = await import("../src/recall/recall-workflow.ts");
  const { filterRecallWithJev } = await import("../src/relevance/jev-filter.ts");
  const { JevRuntime } = await import("../src/relevance/jev-runtime.ts");
  const db = getDb();
  const runtime = new JevRuntime();
  try {
    db.exec("BEGIN");
    try {
      for (const turn of turns) {
        upsertSession({ session_id: turn.sessionId, source: "pi", cwd: `/locomo/${sample.sample_id}`,
          started_at: turn.timestamp - turn.turnIndex, model_id: null, jsonl_path: `locomo://${turn.sessionId}` });
        insertTurn({ turn_id: turn.turnId, session_id: turn.sessionId, turn_index: turn.turnIndex, ts: turn.timestamp,
          user_text: turn.text, reply_text: "", tool_names: null, user_message_id: turn.turnId });
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    writeFileSync(join(directory, "ingestion.json"), JSON.stringify({ sampleId: sample.sample_id, turns: turns.length,
      mapping: "One LoCoMo utterance per synthetic Pi turn; date, speaker, text and optional image caption",
      cwd: `/locomo/${sample.sample_id}`, indexedAnnotations: [] }, null, 2), { flag: "wx" });
    if (config.memory.jevEnable) {
      const status = await runtime.ensureReady(true, config.memory.model, config.memory.jevConnection);
      assert.equal(status.state, "ready", `Jev unavailable: ${status.reason}`);
    }
    const reviewer: RecallReviewer = async (question, candidates) => {
      if (config.memory.jevEnable) return filterRecallWithJev(runtime, question, candidates);
      return { results: candidates, filteredOut: [], stats: { status: "disabled", model: config.memory.model,
        contextWindow: 0, reviewed: candidates.length, retained: candidates.length, filtered: 0, truncated: 0 } };
    };
    const results: QuestionResult[] = [];
    const audit = join(directory, "model-calls.jsonl");
    for (const { qa, questionIndex } of selected) {
      const started = performance.now();
      const planned = await complete(models.planner, { role: "planner", questionIndex, input: { question: qa.question }, json: true }, config.timeoutMs, audit);
      const query = parsePlan(planned.content, qa.question);
      const retrievalStarted = performance.now();
      const recall = await recallSequentially(query, reviewer, () => {});
      const retrievalMs = performance.now() - retrievalStarted;
      const retrieved = [
        ...recall.global.results.map(turn => ({ turn, stage: "global" as const })),
        ...recall.project.results.map(turn => ({ turn, stage: "project" as const })),
      ];
      const context = retrieved.map(({ turn }) => ({ turnId: turn.turn_id, text: turn.user_text, reply: turn.reply_text }));
      const contextCharacters = JSON.stringify(context).length;
      assert(contextCharacters <= config.contextCharacterLimit, `Retrieved context exceeds explicit ${config.contextCharacterLimit}-character limit`);
      const answered = await complete(models.answer, { role: "answer", questionIndex, input: { question: qa.question, turns: context }, json: false }, config.timeoutMs, audit);
      assert(qa.answer !== undefined, "Gold answer is required for scoring");
      const goldAnswer = String(qa.answer);
      const judged = await complete(models.judge, { role: "judge", questionIndex, input: { question: qa.question, gold_answer: goldAnswer, prediction: answered.content }, json: true }, config.timeoutMs, audit);
      const completionCalls = [planned, answered, judged];
      const references = retrieved.map(({ turn, stage }) => {
        const dialogueId = dialogueByTurn.get(turn.turn_id);
        assert(dialogueId, "Retrieved a turn outside this sample");
        return { turnId: turn.turn_id, dialogueId, stage, score: turn.score };
      });
      const result: QuestionResult = {
        sampleId: sample.sample_id, questionIndex, category: qa.category, question: qa.question, goldAnswer,
        prediction: answered.content, correct: parseGrade(judged.content),
        exactMatch: normalizeAnswer(answered.content) === normalizeAnswer(goldAnswer), tokenF1: tokenF1(answered.content, goldAnswer),
        evidence: evidenceMetric(qa.evidence, references.map(ref => ref.dialogueId), availableIds),
        query: { entities: query.entities, primary_entity: query.primary_entity }, retrieved: references,
        globalCandidates: recall.global.stats.reviewed, projectCandidates: recall.project.stats.reviewed,
        duplicatesRemoved: recall.project.duplicatesRemoved, contextCharacters, retrievalMs, totalMs: performance.now() - started,
        promptTokens: completionCalls.reduce((sum, call) => sum + call.usage.promptTokens, 0),
        completionTokens: completionCalls.reduce((sum, call) => sum + call.usage.completionTokens, 0),
      };
      appendFileSync(join(directory, "results.jsonl"), `${JSON.stringify({ ...result, jev: { global: recall.global.stats, project: recall.project.stats } })}\n`);
      results.push(result);
    }
    return results;
  } finally { runtime.shutdown(); db.close(); }
}
