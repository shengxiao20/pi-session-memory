import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRecallQuery } from "../src/recall/recall-query.ts";
import { Value } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-primary-entity-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const directory = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(directory, { recursive: true });
const configPath = join(directory, "config.json");
writeFileSync(configPath, JSON.stringify({ recallLimit: 20 }));
const { getDb, upsertSession, insertTurn } = await import("../src/history/db.ts");
const { recallTurns, formatRecallResults } = await import("../src/recall/retriever.ts");
const { recallProjectMemory, findProjectSessions } = await import("../src/recall/project-retriever.ts");
const { recallSequentially } = await import("../src/recall/recall-workflow.ts");
const query = { primary_entity: "joule engagement layer", entities: ["joule engagement layer", "joule", "engagement"], question: "How did we design joule engagement layer?" };
try {
  validateRecallQuery(query);
  validateRecallQuery({ ...query, primary_entity: " JOULE ENGAGEMENT LAYER " });
  const punctuationQueries = [
    { entities: ["?"], primary_entity: "?", question: 'Search "?"' },
    { entities: ["？"], primary_entity: "？", question: 'Search "？"' },
    { entities: ["?", "？"], primary_entity: "?", question: 'Search "?" and "？"' },
  ];
  const acceptedQueries = [
    { ...query, entities: [query.primary_entity] },
    { ...query, entities: [query.primary_entity, ...Array.from({ length: 16 }, (_, i) => `entity-${i}`)] },
    ...punctuationQueries,
  ];
  const { default: extension } = await import("../extensions/index.ts");
  const tools: ToolDefinition[] = [];
  extension({ on() {}, registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); } } as unknown as ExtensionAPI);
  for (const input of acceptedQueries) validateRecallQuery(input);
  for (const name of ["recall_memory", "review_jev_filtered"]) {
    const tool = tools.find(tool => tool.name === name)!;
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    assert.equal(schema.properties.entities.minItems, undefined);
    assert.equal(schema.properties.entities.maxItems, undefined);
    assert.equal(schema.properties.entities.items.minLength, 1);
    for (const input of acceptedQueries) assert.equal(Value.Check(tool.parameters, input), true, `${name}: accepts one, seventeen, and punctuation-only entities`);
    assert.equal(Value.Check(tool.parameters, { ...query, entities: [""] }), false);
    assert.equal(Value.Check(tool.parameters, { ...query, entities: [123] }), false);
  }
  for (const [input, message] of [
    [{ ...query, primary_entity: undefined }, /primary_entity must be a non-empty string/],
    [{ ...query, primary_entity: "  " }, /primary_entity must be a non-empty string/],
    [{ ...query, primary_entity: "layer" }, /primary_entity must be included/],
    [{ ...query, question: "Explain Joule's engagement architecture" }, /verbatim phrase/],
    [{ ...query, entities: ["joule engagement layer", " "] }, /non-empty literal/],
    [{ ...query, entities: [""] }, /non-empty literal/],
    [{ ...query, entities: [123] }, /non-empty literal/],
    [{ ...query, entities: undefined }, /non-empty literal/],
    [{ ...query, entities: "joule engagement layer" }, /non-empty literal/],
    [{ ...query, entities: [] }, /primary_entity must be included/],
    [{ ...query, question: " " }, /question must be a non-empty/],
  ] as const) assert.throws(() => validateRecallQuery(input as any), message);
  const source = "pi" as const;
  {
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
  const reviewAll = async (question: string, results: ReturnType<typeof recallTurns>) => {
    calls.push({ question, results });
    return { results, filteredOut: [], stats: { status: "disabled" as const, model: "nimble", contextWindow: 2048, reviewed: results.length, retained: results.length, filtered: 0, truncated: 0 } };
  };
  const workflow = await recallSequentially(query, reviewAll, () => {});
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.question === query.question && call.results[0].score === 13));
  assert.equal(workflow.project.duplicatesRemoved, 1);
  let reviewed = false;
  await assert.rejects(recallSequentially({ ...query, primary_entity: "unknown" }, async () => { reviewed = true; throw new Error("should not run"); }, () => {}), /included in entities/);
  assert.equal(reviewed, false, "invalid input fails before search review");
  for (const input of acceptedQueries.slice(0, 2)) {
    const result = await recallSequentially(input, reviewAll, () => {});
    assert.equal(result.global.results.length, 1, "removing entity count limits does not change recallLimit");
    assert.equal(result.global.results[0]!.score, 11);
    assert.equal(result.project.duplicatesRemoved, 1);
  }

  writeFileSync(configPath, JSON.stringify({ recallLimit: 20 }));
  const punctuationSession = "pi:punctuation";
  upsertSession({ session_id: punctuationSession, source, cwd: "/work/symbol-project", started_at: 1, model_id: null, jsonl_path: join(home, "symbols.jsonl") });
  for (const [index, [id, user_text, reply_text]] of [
    ["ascii", "Question?", ""],
    ["fullwidth", "Question？", ""],
    ["reply", "No question mark in the user text", "Answer?"],
    ["both", "Question?", "Answer？"],
  ].entries()) {
    insertTurn({ turn_id: `${punctuationSession}:${id}`, session_id: punctuationSession, turn_index: index, ts: 1000 + index, user_text, reply_text, user_message_id: id, tool_names: null });
  }
  const expectedIds = [
    ["ascii", "reply", "both"],
    ["fullwidth", "both"],
    ["ascii", "fullwidth", "reply", "both"],
  ];
  for (const [index, input] of punctuationQueries.entries()) {
    const literal = recallTurns(input);
    assert.deepEqual(literal.filter(turn => turn.session_id === punctuationSession).map(turn => turn.turn_id).sort(), expectedIds[index]!.map(id => `${punctuationSession}:${id}`).sort());
    assert.deepEqual(findProjectSessions(input), [], "punctuation does not match every project");
    assert.deepEqual(recallProjectMemory(input), { sessions: [], results: [] });
    calls.length = 0;
    const result = await recallSequentially(input, reviewAll, () => {});
    assert.deepEqual(result.global.results, literal, "global punctuation hits survive the complete workflow");
    assert.deepEqual(result.project.results, []);
    assert.deepEqual(result.project.sessions, []);
    assert.equal(calls.length, 2, "both stages still run");
    assert.deepEqual(calls[1]!.results, []);
    assert.ok(calls.every(call => call.question === input.question));
  }
  const mixedInput = { entities: ["?", "symbol project"], primary_entity: "?", question: 'Search "?" in symbol project' };
  assert.deepEqual(findProjectSessions(mixedInput).map(session => session.session_id), [punctuationSession], "normal project tokens still work beside punctuation");
  assert.ok(recallProjectMemory(mixedInput).results.some(turn => turn.turn_id === `${punctuationSession}:reply`), "transcript search still includes assistant replies");
  assert.equal(recallTurns(punctuationQueries[2]!).find(turn => turn.turn_id === `${punctuationSession}:both`)!.score, 12, "two unique punctuation matches plus the unchanged primary bonus");
  console.log("primary-entity.test.ts: unrestricted entity count, both tool schemas, punctuation in both transcript roles, project discovery, primary validation, ranking, limits and both stages passed");
} finally {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
}
