import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-history-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-history-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;
process.env.USERPROFILE = historyHome;

const { getDb, getHistoryStats, getSession, insertTurn, upsertSession } = await import("../src/history/db.ts");
const { fetchTurnContext } = await import("../src/history/fetch-turn-context.ts");
const { recallTurns } = await import("../src/recall/retriever.ts");
const { recallProjectMemory } = await import("../src/recall/project-retriever.ts");
const { backfillAll, syncChangedHistory } = await import("../src/history/backfill.ts");
const { getSessionMemoryConfig, JEV_MODELS, DEFAULT_JEV_CONNECTION } = await import("../src/settings/config.ts");

function cleanup(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true }); rmSync(historyHome, { recursive: true, force: true }); }
cleanup();
mkdirSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true });
const configPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));
assert.deepEqual(getSessionMemoryConfig(), { recallMode: "choice", recallLimit: 2, jevEnable: false, model: "nimble", jevConnection: DEFAULT_JEV_CONNECTION, knowledgePath: undefined });
for (const model of JEV_MODELS) {
  writeFileSync(configPath, JSON.stringify({ recallLimit: 2, jevEnable: true, model }));
  assert.deepEqual(getSessionMemoryConfig(), { recallMode: "choice", recallLimit: 2, jevEnable: true, model, jevConnection: DEFAULT_JEV_CONNECTION, knowledgePath: undefined });
}
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, model: "custom-decision-model" }));
assert.equal(getSessionMemoryConfig().model, "custom-decision-model");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, model: " " }));
assert.throws(() => getSessionMemoryConfig());
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, obsidianExportEnabled: true }));
assert.throws(() => getSessionMemoryConfig());
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, obsidianExportEnabled: true, obsidianVaultPath: "/vault" }));
assert.throws(() => getSessionMemoryConfig());
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, knowledgePath: "/knowledge" }));
assert.equal(getSessionMemoryConfig().knowledgePath, "/knowledge");
assert.equal(getSessionMemoryConfig().consultation, undefined);
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));

upsertSession({ session_id: "pi:project-a", source: "pi", cwd: "/workspace/project-a", started_at: 1, model_id: null, jsonl_path: "/tmp/project-a.jsonl" });
for (const [index, text] of ["deploy memory testing", "deploy memory release", "literal %_\\ marker"].entries()) {
  assert.equal(insertTurn({ turn_id: `pi:project-a:user-${index + 1}`, session_id: "pi:project-a", turn_index: index, ts: index + 1, user_text: text, reply_text: "confirmed", tool_names: null, user_message_id: `user-${index + 1}` }), true);
}
assert.deepEqual(recallTurns({ entities: ["deploy"] }).map((turn) => turn.turn_id), ["pi:project-a:user-2", "pi:project-a:user-1"]);
assert.deepEqual(recallTurns({ entities: ["%_\\"] }).map((turn) => turn.turn_id), ["pi:project-a:user-3"]);
assert.deepEqual(recallTurns({ entities: ["deploy"], cwd: "/wrong" }), []);
assert.deepEqual(recallTurns({ entities: ["deploy"], sessionIds: ["pi:missing"] }), []);
for (let index = 0; index < 6; index++) {
  assert.equal(insertTurn({ turn_id: `pi:project-a:extra-${index}`, session_id: "pi:project-a", turn_index: index + 3, ts: index + 4, user_text: "complete result set", reply_text: "", tool_names: null, user_message_id: `extra-${index}` }), true);
}
assert.equal(recallTurns({ entities: ["complete"] }).length, 2, "recall uses the configured result limit");
upsertSession({ session_id: "pi:memory-project", source: "pi", cwd: "C:\\work\\pi-session-memory\\", started_at: 11, model_id: null, jsonl_path: "/tmp/pi-session-memory.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:memory-project:user-1", session_id: "pi:memory-project", turn_index: 0, ts: 11, user_text: "设计数据库 schema", reply_text: "SQLite tables", tool_names: null, user_message_id: "memory-user-1" }), true);
const bilingualTopicEntities = ["数据库", "database"];
assert.deepEqual(recallTurns({ entities: bilingualTopicEntities }).map((turn) => turn.turn_id), ["pi:memory-project:user-1"]);
const projectEntities = ["pi session memory", "数据库", "database"];
const projectRecall = recallProjectMemory({ entities: projectEntities });
assert.deepEqual(projectRecall.results.map((turn) => turn.turn_id), ["pi:memory-project:user-1"]);
assert.equal(recallTurns({ entities: ["pi-session-memory"] }).length, 0);
const missingProjectEntities = ["pi session memory", "不存在主题", "nonexistent topic"];
const noTopicProjectRecall = recallProjectMemory({ entities: missingProjectEntities });
assert.deepEqual(noTopicProjectRecall.results, []);
assert.deepEqual(noTopicProjectRecall.sessions.map((session) => session.session_id), ["pi:memory-project"]);
assert.deepEqual(recallProjectMemory({ entities: ["pi-session-memory-fork", ...bilingualTopicEntities] }).sessions, []);
assert.deepEqual(recallProjectMemory({ entities: ["pi session", ...bilingualTopicEntities] }).sessions.map((session) => session.session_id), ["pi:memory-project"]);
for (let index = 0; index < 3; index++) {
  upsertSession({ session_id: `pi:project-candidate-${index}`, source: "pi", cwd: "/workspace/pi-session-memory", started_at: 20 + index, model_id: null, jsonl_path: `/tmp/project-candidate-${index}.jsonl` });
  assert.equal(insertTurn({ turn_id: `pi:project-candidate-${index}:user-1`, session_id: `pi:project-candidate-${index}`, turn_index: 0, ts: 20 + index, user_text: "unrelated candidate", reply_text: "", tool_names: null, user_message_id: `candidate-${index}` }), true);
}
const limitedProjectCandidates = recallProjectMemory({ entities: missingProjectEntities });
assert.deepEqual(limitedProjectCandidates.sessions.map((session) => session.session_id), ["pi:project-candidate-2", "pi:project-candidate-1"]);
const olderProjectMatch = recallProjectMemory({ entities: projectEntities });
assert.deepEqual(olderProjectMatch.results.map((turn) => turn.turn_id), ["pi:memory-project:user-1"]);
assert.deepEqual(olderProjectMatch.sessions.map((session) => session.session_id), ["pi:memory-project"]);
upsertSession({ session_id: "pi:native-app", source: "pi", cwd: "/workspace/pi-native-app", started_at: 12, model_id: null, jsonl_path: "/tmp/pi-native-app.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:native-app:user-1", session_id: "pi:native-app", turn_index: 0, ts: 12, user_text: "数据库 design", reply_text: "SQLite", tool_names: null, user_message_id: "native-app-user-1" }), true);
assert.deepEqual(recallProjectMemory({ entities: ["pi native app", ...bilingualTopicEntities] }).sessions.map((session) => session.session_id), ["pi:native-app"]);
assert.deepEqual(fetchTurnContext("pi:project-a:user-2", 0, 0).stored.turns.map((turn) => turn.turn_id), ["pi:project-a:user-2"]);
upsertSession({ session_id: "pi:session-uuid", source: "pi", cwd: "/workspace/project-a", started_at: 10, model_id: null, jsonl_path: "/tmp/session.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:session-uuid:user-1", session_id: "pi:session-uuid", turn_index: 0, ts: 10, user_text: "Pi source-prefix test", reply_text: "confirmed", tool_names: null, user_message_id: "user-1" }), true);
assert.deepEqual(fetchTurnContext("pi:session-uuid:user-1", 0, 0).stored.turns.map((turn) => turn.turn_id), ["pi:session-uuid:user-1"]);
assert.throws(() => fetchTurnContext("session-uuid", 0, 0));
const initialStats = getHistoryStats();
assert.equal(initialStats.sessions, 7);
assert.equal(initialStats.turns, 15);
assert.equal(initialStats.oldestTs, 1);
assert.equal(initialStats.newestTs, 22);
assert.deepEqual(initialStats.sources.map((source) => ({ ...source })), [{ source: "pi", sessions: 7, turns: 15 }]);

mkdirSync(join(historyHome, ".pi", "agent", "sessions"), { recursive: true });
const fixture = join(historyHome, ".pi", "agent", "sessions", "fixture.jsonl");
writeFileSync(fixture, [
  JSON.stringify({ type: "session", version: 3, id: "imported", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/imported" }),
  JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "import me" }] } }),
  JSON.stringify({ type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "imported reply" }] } }),
].join("\n"));
assert.equal(syncChangedHistory().turns, 1);
assert.equal(syncChangedHistory().skippedFiles, 1);
assert.equal(backfillAll().scannedFiles, 1);
assert.ok(getSession("pi:imported").turns.length === 1);
writeFileSync(fixture, [
  JSON.stringify({ type: "session", version: 3, id: "imported", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/reindexed" }),
  JSON.stringify({ type: "model_change", id: "model", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", modelId: "updated-model" }),
  JSON.stringify({ type: "message", id: "u-updated", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "replacement user" }] } }),
  JSON.stringify({ type: "message", id: "a-updated", parentId: "u-updated", timestamp: "2026-01-02T00:00:02.000Z", message: { role: "assistant", timestamp: 4, content: [{ type: "text", text: "replacement reply" }] } }),
].join("\n"));
assert.equal(backfillAll().turns, 1, "a force backfill replaces changed source data");
const replacedImported = getSession("pi:imported");
assert.equal(replacedImported.session.cwd, "/reindexed");
assert.equal(replacedImported.session.model_id, "updated-model");
assert.deepEqual(replacedImported.turns.map((turn) => [turn.user_message_id, turn.user_text, turn.reply_text]), [["u-updated", "replacement user", "replacement reply"]]);
getDb().close();
cleanup();
console.log("core.test.ts: passed");
