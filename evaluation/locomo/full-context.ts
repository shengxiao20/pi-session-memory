import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveModel, type EvalConfig } from "./config.ts";
import { historyTurns, selectQuestions, sha256, type Sample } from "./dataset.ts";
import { summarizeAnswers, type AnswerResult } from "./metrics.ts";
import { inspectModels } from "./ollama.ts";
import { answerAndGrade } from "./scoring.ts";

export interface FullContextResult extends AnswerResult { contextTurnCount: number; }

/** Supply every raw utterance. This module never imports retrieval or database modules. */
export async function evaluateFullContext(sample: Sample, config: EvalConfig, directory: string): Promise<FullContextResult[]> {
  const home = join(resolve(directory), "home");
  const database = join(resolve(directory), "memory.db");
  assert.equal(process.env.HOME, home, "Baseline HOME must be isolated before module imports");
  assert.equal(process.env.USERPROFILE, home, "Baseline USERPROFILE must be isolated");
  assert.equal(process.env.MEMORY_DB_PATH, database, "Baseline MEMORY_DB_PATH must be isolated");
  assert(!existsSync(home) && !existsSync(database), "Baseline requires fresh output without plugin state");
  assert.equal(config.memory.jevEnable, false, "Full-context baseline requires Jev disabled");
  const turns = historyTurns(sample).map(turn => ({ turnId: turn.turnId, text: turn.text, reply: "" }));
  const serialized = JSON.stringify(turns);
  assert(serialized.length <= config.contextCharacterLimit, `Full context exceeds explicit ${config.contextCharacterLimit}-character limit`);
  const selected = selectQuestions(sample, config.categories, config.questionsPerSample);
  const models = { answer: resolveModel(config.models.answer), judge: resolveModel(config.models.judge) };
  const checks = await inspectModels(models, config.timeoutMs);
  writeFileSync(join(directory, "model-checks.json"), JSON.stringify(checks, null, 2), { flag: "wx" });
  writeFileSync(join(directory, "context.json"), serialized, { flag: "wx" });
  writeFileSync(join(directory, "context-info.json"), JSON.stringify({ sampleId: sample.sample_id, turns: turns.length,
    characters: serialized.length, sha256: sha256(serialized), order: "Session number, then utterance order",
    fields: "Date, dialogue ID, speaker, raw text, optional image caption", includedAnnotations: [],
    plannerCalls: 0, retrievalCalls: 0, databaseCreated: false }, null, 2), { flag: "wx" });
  const results: FullContextResult[] = [];
  for (const { qa, questionIndex } of selected) {
    const started = performance.now();
    const scored = await answerAndGrade(qa, questionIndex, turns, config, models, join(directory, "model-calls.jsonl"));
    const result: FullContextResult = { ...scored, sampleId: sample.sample_id, contextTurnCount: turns.length, totalMs: performance.now() - started };
    appendFileSync(join(directory, "results.jsonl"), `${JSON.stringify(result)}\n`);
    results.push(result);
    console.log(JSON.stringify({ scenario: "full-context", sampleId: sample.sample_id, questionIndex, correct: result.correct,
      answerMs: result.answerMs, judgeMs: result.judgeMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens }));
  }
  assert(!existsSync(home) && !existsSync(database), "Baseline created unexpected plugin state");
  return results;
}

export function summarizeFullContext(results: FullContextResult[]) {
  return { scenario: "full-context", ...summarizeAnswers(results),
    contextTurnCounts: [...new Set(results.map(result => result.contextTurnCount))],
    contextCharacterCounts: [...new Set(results.map(result => result.contextCharacters))],
    retrievalMetrics: "Not applicable: full raw conversation, without retrieval" };
}
