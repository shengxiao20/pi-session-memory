import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevFilterResult } from "../src/jev-filter.ts";
import type { RecallTurnResult } from "../src/retriever.ts";
import type { RecallWorkflowProgress } from "../src/recall-workflow.ts";

const home = mkdtempSync(join(tmpdir(), "pi-recall-workflow-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const configDir = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "config.json"), JSON.stringify({ recallLimit: 2 }));

const { getDb, getSession, insertTurn, upsertSession } = await import("../src/db.ts");
const { recallTurns } = await import("../src/retriever.ts");
const { recallProjectMemory } = await import("../src/project-retriever.ts");
const { recallSequentially } = await import("../src/recall-workflow.ts");
const options = { entities: ["target app", "needle"], question: "What did we decide about the target app needle?" };

function addSession(session_id: string, source: "pi" | "claude" | "codex", cwd: string): void {
  upsertSession({ session_id, source, cwd, started_at: 1, model_id: null, jsonl_path: join(home, `${source}.jsonl`) });
}
function addTurn(session_id: string, id: string, ts: number, text: string): string {
  const turn_id = `${session_id}:${id}`;
  insertTurn({ turn_id, session_id, turn_index: ts, ts, user_text: text, reply_text: "original answer", tool_names: null, user_message_id: id });
  return turn_id;
}
function reviewResult(candidates: RecallTurnResult[], retained = candidates, status: "disabled" | "filtered" = "disabled"): JevFilterResult {
  const retainedIds = new Set(retained.map((turn) => turn.turn_id));
  const filteredOut = candidates.filter((turn) => !retainedIds.has(turn.turn_id)).map((turn) => ({ turn, noul: 0.1 }));
  return {
    results: retained, filteredOut,
    stats: { status, model: "nimble", contextWindow: 2_050, reviewed: candidates.length, retained: retained.length, filtered: filteredOut.length, truncated: 0 },
  };
}
function ids(turns: RecallTurnResult[]): string[] { return turns.map((turn) => turn.turn_id); }
const keepAll = async (_question: string, turns: RecallTurnResult[]) => reviewResult(turns);

try {
  addSession("claude:target", "claude", "C:\\work\\target-app\\");
  addSession("codex:other", "codex", "/work/other-project");
  const otherId = addTurn("codex:other", "global", 200, "needle outside the named project");
  const sharedId = addTurn("claude:target", "shared", 100, "needle identical transcript");
  const uniqueId = addTurn("claude:target", "unique", 90, "needle identical transcript");
  const belowLimitId = addTurn("claude:target", "below-limit", 80, "needle older candidate");
  const storedBefore = getSession("claude:target");
  const literalGlobal = recallTurns(options.entities);
  const literalProject = recallProjectMemory(options);
  assert.deepEqual(ids(literalGlobal), [otherId, sharedId]);
  assert.deepEqual(ids(literalProject.results), [sharedId, uniqueId]);

  const inputs: RecallTurnResult[][] = [];
  const progress: RecallWorkflowProgress[] = [];
  const partialOverlap = await recallSequentially(options, async (question, turns, update) => {
    assert.equal(question, options.question, "both stages must receive the complete identical question");
    inputs.push(turns);
    update("reviewing candidates");
    return reviewResult(turns);
  }, (update) => progress.push(update));
  assert.deepEqual(inputs, [literalGlobal, literalProject.results], "each existing search must keep its exact candidate ordering and limit");
  assert.deepEqual(partialOverlap.global.results, literalGlobal);
  assert.deepEqual(ids(partialOverlap.project.results), [uniqueId], "deduplicate exact IDs, not identical text with a different ID");
  assert.equal(partialOverlap.project.duplicatesRemoved, 1);
  assert.equal(partialOverlap.project.stats.retained, 2, "Jev statistics must remain pre-deduplication statistics");
  assert.ok(!ids(partialOverlap.project.results).includes(belowLimitId), "deduplication must not refill from below the SQL limit");
  assert.deepEqual(partialOverlap.project.sessions, literalProject.sessions);
  assert.deepEqual(progress.map((update) => update.stage), ["global", "global", "project", "project"]);
  assert.match(progress[0]!.message, /Global recall:[\s\S]*Project recall: waiting/);
  assert.match(progress[2]!.message, /Global recall: complete — 2 turns returned.[\s\S]*Project recall:/);

  let reviews = 0;
  const rejectedGlobally = await recallSequentially(options, async (_question, turns) => {
    reviews++;
    return reviews === 1 ? reviewResult(turns, turns.filter((turn) => turn.turn_id !== sharedId), "filtered") : reviewResult(turns, turns, "filtered");
  }, () => {});
  assert.deepEqual(ids(rejectedGlobally.global.results), [otherId]);
  assert.deepEqual(ids(rejectedGlobally.project.results), [sharedId, uniqueId], "exclude only global final results, not global literal candidates or Jev rejections");
  assert.equal(rejectedGlobally.project.duplicatesRemoved, 0);
  assert.deepEqual(ids(rejectedGlobally.global.filteredOut.map((entry) => entry.turn)), [sharedId]);

  reviews = 0;
  const rejectedInProject = await recallSequentially(options, async (_question, turns) => {
    reviews++;
    return reviews === 2 ? reviewResult(turns, turns.filter((turn) => turn.turn_id !== sharedId), "filtered") : reviewResult(turns);
  }, () => {});
  assert.deepEqual(ids(rejectedInProject.project.results), [uniqueId]);
  assert.equal(rejectedInProject.project.duplicatesRemoved, 0, "deduplication must happen after project Jev filtering");
  assert.deepEqual(ids(rejectedInProject.project.filteredOut.map((entry) => entry.turn)), [sharedId], "existing Jev audit evidence must not be changed");
  assert.deepEqual(getSession("claude:target"), storedBefore, "workflow must not alter indexed originals");

  const noProject = await recallSequentially({ ...options, entities: ["missing directory", "needle"] }, keepAll, () => {});
  assert.deepEqual(ids(noProject.global.results), [otherId, sharedId], "global search must remain unconditional when no project matches");
  assert.deepEqual(noProject.project.results, []);
  assert.equal(noProject.project.duplicatesRemoved, 0);
  const emptyInputs: RecallTurnResult[][] = [];
  const empty = await recallSequentially({ ...options, entities: ["target app", "absent topic"] }, async (_question, turns) => {
    emptyInputs.push(turns);
    return reviewResult(turns);
  }, () => {});
  assert.deepEqual(emptyInputs, [[], []], "both stages run even when global candidates are empty");
  assert.deepEqual(empty.project.results, []);
  assert.deepEqual(empty.project.sessions, [], "keep the previous tool's session-output behavior when no turns survive");

  let releaseGlobal!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGlobal = resolve; });
  const orderedInputs: RecallTurnResult[][] = [];
  const orderedProgress: RecallWorkflowProgress[] = [];
  const pending = recallSequentially(options, async (_question, turns) => {
    orderedInputs.push(turns);
    if (orderedInputs.length === 1) await gate;
    return reviewResult(turns);
  }, (update) => orderedProgress.push(update));
  await Promise.resolve();
  assert.equal(orderedInputs.length, 1, "project review must not start while global review is pending");
  assert.deepEqual(orderedProgress.map((update) => update.stage), ["global"]);
  const insertedAfterGlobalSearch = addTurn("claude:target", "inserted", 95, "needle added while global review waits");
  releaseGlobal();
  const ordered = await pending;
  assert.deepEqual(ids(orderedInputs[1]!), [sharedId, insertedAfterGlobalSearch], "project retrieval itself must start only after global review completes");
  assert.deepEqual(ids(ordered.global.results), [otherId, sharedId]);
  assert.deepEqual(ids(ordered.project.results), [insertedAfterGlobalSearch]);

  getDb().prepare("DELETE FROM turns WHERE turn_id = ?").run(otherId);
  const allDuplicates = await recallSequentially(options, keepAll, () => {});
  assert.equal(allDuplicates.project.duplicatesRemoved, 2);
  assert.deepEqual(allDuplicates.project.results, []);
  assert.deepEqual(allDuplicates.project.sessions, [], "fully duplicate sessions must not remain in project final details");
  assert.equal(allDuplicates.project.stats.retained, 2);

  reviews = 0;
  await assert.rejects(recallSequentially(options, async () => {
    reviews++;
    throw new Error("global stage failed");
  }, () => {}), /global stage failed/);
  assert.equal(reviews, 1, "a failed global stage must not start a project stage");
  reviews = 0;
  await assert.rejects(recallSequentially(options, async (_question, turns) => {
    reviews++;
    if (reviews === 2) throw new Error("project stage failed");
    return reviewResult(turns);
  }, () => {}), /project stage failed/);
  assert.equal(reviews, 2, "project errors must propagate rather than silently return global-only success");
} finally {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
}
console.log("recall-workflow.test.ts: passed");
