import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-memory-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-memory-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;

const { confirmMemory, createMemory, deleteMemory, deleteTurn, getDb, getMemoryHistory, getMemoryStats, getSession, insertTurn, listMemories, pinTurnAsMemory, supersedeMemory, upsertSession } = await import("../src/db.ts");
const { formatRecallResults, paginateRecallResults, recallMemories, recallTurns, RECALL_PAGE_SIZE } = await import("../src/retriever.ts");
const { HISTORY_SCHEMA_REFERENCE_VERSIONS, backfillAll } = await import("../src/backfill.ts");
const { migrateCodexProjectSessions } = await import("../src/session-migration.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

/** Remove the temporary SQLite database and its WAL sidecar files after this test. */
function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
  if (existsSync(historyHome)) rmSync(historyHome, { recursive: true });
}

cleanup();

upsertSession({
  session_id: "pi:test",
  source: "pi",
  cwd: "/tmp",
  started_at: 1,
  model_id: null,
  jsonl_path: "/tmp/test.jsonl",
});

assert.equal(insertTurn({
  turn_id: "pi:test:user-1",
  session_id: "pi:test",
  turn_index: 0,
  ts: 1,
  user_text: "literal 100% and a_b",
  reply_text: "first reply",
  tool_names: null,
  user_message_id: "user-1",
}), true);

assert.equal(insertTurn({
  turn_id: "pi:test:user-2",
  session_id: "pi:test",
  turn_index: 1,
  ts: 2,
  user_text: "wildcard 100x and acb",
  reply_text: "second reply",
  tool_names: null,
  user_message_id: "user-2",
}), true);

assert.equal(insertTurn({
  turn_id: "pi:test:user-1",
  session_id: "pi:test",
  turn_index: 0,
  ts: 1,
  user_text: "duplicate",
  reply_text: "duplicate",
  tool_names: null,
  user_message_id: "user-1",
}), false);

assert.throws(() => insertTurn({
  turn_id: "pi:test:invalid-message-id",
  session_id: "pi:test",
  turn_index: 2,
  ts: 3,
  user_text: "invalid SQLite parameter",
  reply_text: "",
  tool_names: null,
  user_message_id: undefined as unknown as string,
}), /SQLite parameter 8 must be string, number, bigint, Uint8Array, or null; received undefined/);

mkdirSync(join(historyHome, ".pi", "agent", "sessions"), { recursive: true });
mkdirSync(join(historyHome, ".claude", "projects"), { recursive: true });
mkdirSync(join(historyHome, ".codex", "sessions"), { recursive: true });
writeFileSync(join(historyHome, ".pi", "agent", "sessions", "invalid.jsonl"), [
  JSON.stringify({ type: "session", id: "pi-invalid", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
  JSON.stringify({ type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "invalid Pi id" }] } }),
].join("\n"));
writeFileSync(join(historyHome, ".pi", "agent", "sessions", "valid.jsonl"), [
  JSON.stringify({ type: "session", id: "pi-compatible", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
  JSON.stringify({ type: "message", id: "pi-user", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "schema normal Pi request" }] } }),
  JSON.stringify({ type: "message", id: "pi-assistant", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "schema normal Pi reply" }] } }),
].join("\n"));
writeFileSync(join(historyHome, ".claude", "projects", "invalid.jsonl"), [
  JSON.stringify({ type: "user", sessionId: "claude-invalid", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "invalid Claude id" } }),
].join("\n"));
writeFileSync(join(historyHome, ".claude", "projects", "valid-old-schema.jsonl"), [
  JSON.stringify({ type: "user", id: "claude-user", sessionId: "claude-compatible", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "schema normal Claude request" } }),
  JSON.stringify({ type: "assistant", id: "claude-assistant", sessionId: "claude-compatible", cwd: "/tmp", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "schema normal Claude reply" }] } }),
].join("\n"));
writeFileSync(join(historyHome, ".codex", "sessions", "invalid.jsonl"), [
  JSON.stringify({ type: "session_meta", payload: { session_id: "codex-invalid", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "invalid Codex id" }] } }),
].join("\n"));
writeFileSync(join(historyHome, ".codex", "sessions", "valid.jsonl"), [
  JSON.stringify({ type: "session_meta", payload: { session_id: "codex-compatible", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "message", id: "codex-user", role: "user", content: [{ type: "input_text", text: "schema normal Codex request" }] } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "message", id: "codex-assistant", role: "assistant", content: [{ type: "output_text", text: "schema normal Codex reply" }] } }),
].join("\n"));
writeFileSync(join(historyHome, ".codex", "sessions", "valid-legacy.jsonl"), [
  JSON.stringify({ type: "session_meta", payload: { session_id: "codex-legacy", cwd: "/tmp", timestamp: "2026-07-17T03:03:23.000Z" } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-07-17T03:03:24.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "schema legacy Codex request" }], internal_chat_message_metadata_passthrough: { turn_id: "legacy-codex-turn" } } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-07-17T03:03:25.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "schema legacy Codex reply" }], internal_chat_message_metadata_passthrough: { turn_id: "legacy-codex-turn" } } }),
].join("\n"));
writeFileSync(join(historyHome, ".codex", "sessions", "other-project.jsonl"), [
  JSON.stringify({ type: "session_meta", payload: { session_id: "codex-other-project", cwd: "/other-project", timestamp: "2026-01-01T00:00:00.000Z" } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "message", id: "codex-other-user", role: "user", content: [{ type: "input_text", text: "other project request" }] } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "message", id: "codex-other-assistant", role: "assistant", content: [{ type: "output_text", text: "other project reply" }] } }),
].join("\n"));
const migrationStats = migrateCodexProjectSessions("/tmp");
assert.deepEqual({ scannedFiles: migrationStats.scannedFiles, migratedSessions: migrationStats.migratedSessions, skippedSessions: migrationStats.skippedSessions, migratedMessages: migrationStats.migratedMessages, issues: migrationStats.issues.length }, { scannedFiles: 4, migratedSessions: 2, skippedSessions: 0, migratedMessages: 4, issues: 1 });
assert.match(migrationStats.issues[0].error, /no stable native ID/);
const migratedSessionFiles = [...(await SessionManager.list("/tmp"))].filter((session) => session.name?.startsWith("Migrated from Codex:"));
assert.deepEqual(migratedSessionFiles.map((session) => session.name).sort(), ["Migrated from Codex: codex-compatible", "Migrated from Codex: codex-legacy"]);
const migrated = SessionManager.open(migratedSessionFiles.find((session) => session.name === "Migrated from Codex: codex-compatible")!.path);
assert.deepEqual(migrated.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message.role), ["user", "assistant"]);
assert.equal(migrateCodexProjectSessions("/tmp").skippedSessions, 2);
assert.equal((await SessionManager.list("/other-project")).some((session) => session.name === "Migrated from Codex: codex-other-project"), false);
const backfillStats = backfillAll();
assert.deepEqual({ pi: backfillStats.pi, claude: backfillStats.claude, codex: backfillStats.codex, turns: backfillStats.turns }, { pi: 3, claude: 1, codex: 3, turns: 7 });
assert.deepEqual(backfillStats.issues.map((issue) => issue.source), ["pi", "claude", "codex"]);
for (const issue of backfillStats.issues) {
  assert.match(issue.error, new RegExp(`${issue.source} history import failed[\\s\\S]*supported reference ${HISTORY_SCHEMA_REFERENCE_VERSIONS[issue.source]}`));
}
assert.deepEqual(HISTORY_SCHEMA_REFERENCE_VERSIONS, { pi: "0.85.1", claude: "2.1.234", codex: "0.154.0" });
assert.deepEqual(recallTurns(["schema normal"]).map((result) => result.turn_id).filter((turnId) => !turnId.startsWith("pi:") || turnId === "pi:pi-compatible:pi-user"), [
  "claude:claude-compatible:claude-user",
  "codex:codex-compatible:codex-user",
  "pi:pi-compatible:pi-user",
]);
assert.equal(recallTurns(["schema legacy Codex"]).some((result) => result.turn_id === "codex:codex-legacy:legacy-codex-turn"), true);

assert.deepEqual(recallTurns(["100%"]).map((result) => result.turn_id), ["pi:test:user-1"]);
assert.deepEqual(recallTurns(["a_b"]).map((result) => result.turn_id), ["pi:test:user-1"]);
const thinRecall = formatRecallResults(recallMemories({ query: "literal" }));
assert.match(thinRecall, /\*\*Session:\*\* pi:test · \*\*Turn:\*\* 0[\s\S]*\*\*Excerpt:\*\* literal 100% and a_b[\s\S]*Use `fetch_session`/);
assert.doesNotMatch(thinRecall, /\*\*Assistant:\*\* first reply/);
assert.match(
  formatRecallResults([], { query: "SAP BTP", entities: ["BTP", "Business Technology Platform"], sources: ["pi"], cwd: "/tmp" }),
  /\*\*Search query:\*\* `SAP BTP`[\s\S]*\*\*Filters:\*\* entities: `BTP`, `Business Technology Platform` · sources: pi · cwd: `\/tmp`[\s\S]*No relevant past conversations found\./,
);
upsertSession({
  session_id: "claude:project-a",
  source: "claude",
  cwd: "/workspace/project-a",
  started_at: 10,
  model_id: null,
  jsonl_path: "/tmp/project-a.jsonl",
});
upsertSession({
  session_id: "codex:project-b",
  source: "codex",
  cwd: "/workspace/project-b",
  started_at: 20,
  model_id: null,
  jsonl_path: "/tmp/project-b.jsonl",
});
for (const [turnId, sessionId, index, ts, text] of [
  ["claude:project-a:user-1", "claude:project-a", 0, 1_000, "deploy memory ranking"],
  ["claude:project-a:user-2", "claude:project-a", 1, 2_000, "deploy memory testing"],
  ["claude:project-a:user-3", "claude:project-a", 2, 3_000, "deploy memory release"],
  ["codex:project-b:user-1", "codex:project-b", 0, 4_000, "deploy memory ranking"],
] as Array<[string, string, number, number, string]>) {
  assert.equal(insertTurn({
    turn_id: turnId,
    session_id: sessionId,
    turn_index: index,
    ts,
    user_text: text,
    reply_text: "confirmed",
    tool_names: null,
    user_message_id: turnId.split(":").at(-1)!,
  }), true);
}

assert.deepEqual(
  recallMemories({ query: "deploy memory", cwd: "/workspace/project-a" }).map((result) => result.turn_id),
  ["claude:project-a:user-3", "claude:project-a:user-2", "claude:project-a:user-1"],
);
assert.deepEqual(
  recallMemories({ query: "deploy memory", sources: ["codex"], after: 4_000 }).map((result) => result.turn_id),
  ["codex:project-b:user-1"],
);
const allDeployResults = recallMemories({ query: "deploy memory" });
assert.deepEqual(
  allDeployResults.map((result) => result.type === "turn" ? result.turn_id : result.memory_id),
  ["codex:project-b:user-1", "claude:project-a:user-3", "claude:project-a:user-2", "claude:project-a:user-1"],
);
const firstDeployPage = paginateRecallResults(allDeployResults);
assert.equal(RECALL_PAGE_SIZE, 5);
assert.deepEqual(firstDeployPage.results, allDeployResults);
assert.deepEqual({ offset: firstDeployPage.offset, totalResults: firstDeployPage.totalResults, nextOffset: firstDeployPage.nextOffset }, { offset: 0, totalResults: 4, nextOffset: null });
assert.throws(() => paginateRecallResults(allDeployResults, -1), /non-negative integer/);

const explicitMemory = createMemory({
  memory_id: "memory:explicit",
  kind: "decision",
  content: "Use SQLite durable memory for deploy decisions.",
  project_key: "/workspace/project-a",
  source_turn_id: null,
  importance: 2,
  created_at: 5_000,
});
const pinnedMemory = pinTurnAsMemory("claude:project-a:user-1");
assert.equal(pinnedMemory.source_turn_id, "claude:project-a:user-1");
assert.equal(pinnedMemory.source_session_id, "claude:project-a");
assert.ok(pinnedMemory.source_content_hash);
assert.deepEqual(listMemories("decision").map((memory) => memory.memory_id), [explicitMemory.memory_id]);
const deployRecall = recallMemories({ query: "deploy", cwd: "/workspace/project-a" });
assert.deepEqual(
  deployRecall.map((result) => result.type === "memory" ? result.memory_id : result.turn_id),
  [explicitMemory.memory_id, pinnedMemory.memory_id, "claude:project-a:user-3", "claude:project-a:user-2"],
);
const pinnedDeployMemory = deployRecall.find((result) => result.type === "memory" && result.memory_id === pinnedMemory.memory_id)!;
assert.equal(pinnedDeployMemory.source_session_changed, true);
assert.equal(pinnedDeployMemory.freshness_candidate, true);
assert.deepEqual(pinnedDeployMemory.freshness_evidence.map((evidence) => [evidence.turn_id, evidence.relation]), [
  ["claude:project-a:user-3", "same_source_session_later"],
  ["claude:project-a:user-2", "same_source_session_later"],
]);
const crossSessionDeployMemory = recallMemories({ query: "deploy" }).find((result) => result.type === "memory" && result.memory_id === pinnedMemory.memory_id)!;
assert.deepEqual(crossSessionDeployMemory.freshness_evidence.map((evidence) => [evidence.turn_id, evidence.relation]), [
  ["codex:project-b:user-1", "newer_cross_session"],
  ["claude:project-a:user-3", "same_source_session_later"],
  ["claude:project-a:user-2", "same_source_session_later"],
]);
assert.match(
  formatRecallResults([crossSessionDeployMemory]),
  /\*\*Source session changed:\*\* later turns exist; this alone does not mean the memory is stale\.[\s\S]*\*\*Newer evidence to compare:\*\*[\s\S]*newer cross session[\s\S]*Compare this evidence with the durable memory[\s\S]*Do not change the memory without the user's explicit choice\./,
);
const pagedDeployResults = [...deployRecall, ...deployRecall];
const deployPage = paginateRecallResults(pagedDeployResults);
assert.equal(deployPage.results.length, 5);
assert.equal(deployPage.totalResults, 8);
assert.equal(deployPage.nextOffset, 5);
assert.match(
  formatRecallResults(deployPage.results, { query: "deploy" }, deployPage),
  /\*\*Results:\*\* 1–5 of 8 \(five results per page\)[\s\S]*More matching results exist\. To retrieve the next five, call `recall_memory` again with every same search\/filter parameter and `offset: 5`\./,
);
const finalDeployPage = paginateRecallResults(pagedDeployResults, 5);
assert.equal(finalDeployPage.results.length, 3);
assert.equal(finalDeployPage.nextOffset, null);

upsertSession({
  session_id: "pi:source-activity",
  source: "pi",
  cwd: "/workspace/source-activity",
  started_at: 7_000,
  model_id: null,
  jsonl_path: "/tmp/source-activity.jsonl",
});
assert.equal(insertTurn({
  turn_id: "pi:source-activity:user-1",
  session_id: "pi:source-activity",
  turn_index: 0,
  ts: 7_000,
  user_text: "source activity baseline",
  reply_text: "recorded decision",
  tool_names: null,
  user_message_id: "user-1",
}), true);
const sourceActivityMemory = pinTurnAsMemory("pi:source-activity:user-1");
assert.equal(insertTurn({
  turn_id: "pi:source-activity:user-2",
  session_id: "pi:source-activity",
  turn_index: 1,
  ts: 8_000,
  user_text: "unrelated later activity",
  reply_text: "no matching evidence",
  tool_names: null,
  user_message_id: "user-2",
}), true);
const sourceActivityRecall = recallMemories({ query: "source activity baseline", cwd: "/workspace/source-activity" });
const sourceActivityResult = sourceActivityRecall.find((result) => result.type === "memory" && result.memory_id === sourceActivityMemory.memory_id)!;
assert.equal(sourceActivityResult.source_session_changed, true);
assert.deepEqual(sourceActivityResult.freshness_evidence, []);

const confirmedMemory = confirmMemory(pinnedMemory.memory_id);
assert.ok(confirmedMemory.last_confirmed_at >= pinnedMemory.last_confirmed_at);
const replacementMemory = createMemory({
  memory_id: "memory:replacement",
  kind: "decision",
  content: "Use reviewed SQLite durable memory for deploy decisions.",
  project_key: "/workspace/project-a",
  source_turn_id: null,
  importance: 2,
});
supersedeMemory(explicitMemory.memory_id, replacementMemory.memory_id);
assert.deepEqual(getMemoryHistory(replacementMemory.memory_id).map((memory) => memory.memory_id), [explicitMemory.memory_id, replacementMemory.memory_id]);
assert.deepEqual(
  recallMemories({ query: "SQLite durable memory", cwd: "/workspace/project-a" }).filter((result) => result.type === "memory").map((result) => result.memory_id),
  [replacementMemory.memory_id],
);
assert.throws(() => supersedeMemory(explicitMemory.memory_id, replacementMemory.memory_id), /already superseded/);
upsertSession({
  session_id: "pi:provenance",
  source: "pi",
  cwd: "/workspace/provenance",
  started_at: 6_000,
  model_id: null,
  jsonl_path: "/tmp/provenance.jsonl",
});
assert.equal(insertTurn({
  turn_id: "pi:provenance:user-1",
  session_id: "pi:provenance",
  turn_index: 0,
  ts: 6_000,
  user_text: "provenance deduplication",
  reply_text: "original source evidence",
  tool_names: null,
  user_message_id: "user-1",
}), true);
const provenanceMemory = pinTurnAsMemory("pi:provenance:user-1");
assert.deepEqual(
  recallMemories({ query: "provenance deduplication", cwd: "/workspace/provenance" }).map((result) => result.type === "memory" ? result.memory_id : result.turn_id),
  [provenanceMemory.memory_id],
);
getDb().prepare("UPDATE turns SET reply_text = ? WHERE turn_id = ?").run("changed source evidence", "pi:provenance:user-1");
assert.deepEqual(
  recallMemories({ query: "provenance deduplication", cwd: "/workspace/provenance" }).map((result) => result.type === "memory" ? result.memory_id : result.turn_id),
  [provenanceMemory.memory_id, "pi:provenance:user-1"],
);
assert.deepEqual(
  getSession("claude:project-a", 1, 2).turns.map((turn) => [turn.turn_index, turn.turn_id]),
  [[1, "claude:project-a:user-2"], [2, "claude:project-a:user-3"]],
);
assert.throws(() => getSession("missing:session"), /Memory session not found/);
assert.equal(deleteTurn("claude:project-a:user-1"), true);
assert.equal(listMemories().some((memory) => memory.memory_id === pinnedMemory.memory_id), true);
assert.equal(deleteMemory(pinnedMemory.memory_id), true);
assert.equal(deleteMemory(pinnedMemory.memory_id), false);

const stats = getMemoryStats();
assert.equal(stats.sessions, 12);
assert.equal(stats.turns, 15);
assert.deepEqual([...stats.sources].map(({ source, sessions, turns }) => ({ source, sessions, turns })), [
  { source: "claude", sessions: 2, turns: 3 },
  { source: "codex", sessions: 4, turns: 4 },
  { source: "pi", sessions: 6, turns: 8 },
]);
assert.equal(deleteTurn("codex:project-b:user-1"), true);
assert.equal(deleteTurn("codex:project-b:user-1"), false);
assert.equal(getDb().prepare("SELECT count(*) AS count FROM sessions WHERE session_id = 'codex:project-b'").get().count, 0);
assert.equal(getDb().prepare("SELECT count(*) AS count FROM turns").get().count, 14);

cleanup();
console.log("core.test.ts: passed");
