import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRecallQuery } from "../src/recall-query.ts";

const home = mkdtempSync(join(tmpdir(), "pi-primary-entity-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const directory = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(directory, { recursive: true });
const configPath = join(directory, "config.json");
writeFileSync(configPath, JSON.stringify({ recallLimit: 20 }));
const { getDb, upsertSession, insertTurn } = await import("../src/db.ts");
const { recallTurns, formatRecallResults } = await import("../src/retriever.ts");
const { recallProjectMemory } = await import("../src/project-retriever.ts");
const { recallSequentially } = await import("../src/recall-workflow.ts");
const query = { primary_entity: "joule engagement layer", entities: ["joule engagement layer", "joule", "engagement"], question: "How did we design joule engagement layer?" };
try {
  validateRecallQuery(query);
  validateRecallQuery({ ...query, primary_entity: " JOULE ENGAGEMENT LAYER " });
  for (const [input, message] of [
    [{ ...query, primary_entity: undefined }, /primary_entity must be a non-empty string/],
    [{ ...query, primary_entity: "  " }, /primary_entity must be a non-empty string/],
    [{ ...query, primary_entity: "layer" }, /primary_entity must be included/],
    [{ ...query, question: "Explain Joule's engagement architecture" }, /verbatim phrase/],
    [{ ...query, entities: ["joule engagement layer", " "] }, /2-8 non-empty/],
    [{ ...query, entities: ["joule engagement layer"] }, /2-8 non-empty/],
    [{ ...query, question: " " }, /question must be a non-empty/],
  ] as const) assert.throws(() => validateRecallQuery(input as any), message);
  for (const source of ["pi", "claude", "codex"] as const) {
    const session_id = `${source}:primary`;
    upsertSession({ session_id, source, cwd: "/work/joule-engagement-layer", started_at: 1, model_id: null, jsonl_path: join(home, `${source}.jsonl`) });
    const add = (id: string, ts: number, user_text: string, reply_text = "") => insertTurn({ turn_id: `${session_id}:${id}`, session_id, turn_index: ts, ts, user_text, reply_text, user_message_id: id, tool_names: null });
    add("phrase", 1, "JOULE ENGAGEMENT LAYER appears twice: joule engagement layer");
    add("reply", 2, "What is the name?", "joule engagement layer");
    add("loose", 100, "joule has an engagement component");
    add("single", 200, "joule alone");
    add("punctuation", 300, "joule engagement-layer");
    const results = recallTurns({ ...query, sources: [source] });
    assert.deepEqual(results.map(turn => [turn.turn_id.split(":").at(-1), turn.score]), [["reply", 13], ["phrase", 13], ["punctuation", 2], ["loose", 2], ["single", 1]]);
    assert.deepEqual(recallTurns({ ...query, entities: [...query.entities, "JOULE", " joule engagement layer "], sources: [source] }), results, "duplicates must not inflate base score or bonus");
  }
  assert.match(formatRecallResults(recallTurns(query), query), /Primary entity:[\s\S]*bonus: \+10/);
  assert.throws(() => recallTurns({ entities: ["joule"], primary_entity: "engagement" }), /included in entities/);
  writeFileSync(configPath, JSON.stringify({ recallLimit: 1 }));
  const first = recallTurns(query);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.score, 13, "bonus applies before LIMIT and defeats newer partial matches");
  assert.equal(recallProjectMemory(query).results[0]!.score, 13, "project transcript search uses the same bonus");
  const calls: any[] = [];
  const workflow = await recallSequentially(query, async (question, results) => {
    calls.push({ question, results });
    return { results, filteredOut: [], stats: { status: "disabled", model: "nimble", contextWindow: 2048, reviewed: results.length, retained: results.length, filtered: 0, truncated: 0 } };
  }, () => {});
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.question === query.question && call.results[0].score === 13));
  assert.equal(workflow.project.duplicatesRemoved, 1);
  let reviewed = false;
  await assert.rejects(recallSequentially({ ...query, primary_entity: "unknown" }, async () => { reviewed = true; throw new Error("should not run"); }, () => {}), /included in entities/);
  assert.equal(reviewed, false, "invalid input fails before search review");
  console.log("primary-entity.test.ts: validation, +10 once, deduplication, three sources, ranking before LIMIT and both stages passed");
} finally {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
}
