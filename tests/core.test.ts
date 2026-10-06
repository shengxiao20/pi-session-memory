import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-history-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-history-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;
process.env.USERPROFILE = historyHome; // os.homedir() uses USERPROFILE on Windows.

const { getDb, getHistoryStats, getSession, insertTurn, upsertSession } = await import("../src/db.ts");
const { fetchSession } = await import("../src/fetch-session.ts");
const { formatRecallResults, recallTurns } = await import("../src/retriever.ts");
const { formatProjectRecallResults, recallProjectMemory } = await import("../src/project-retriever.ts");
const { backfillAll, syncChangedHistory } = await import("../src/backfill.ts");
const { migrateClaudeProjectSessions, migrateCodexProjectSessions } = await import("../src/session-migration.ts");
const { getWhatsNew, showWhatsNewIfUpdated } = await import("../src/whats-new.ts");
const { SESSION_MEMORY_HELP } = await import("../src/helper.ts");
const { getSessionMemoryConfig, JEV_MODELS } = await import("../src/config.ts");

function cleanup(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true }); rmSync(historyHome, { recursive: true, force: true }); }
cleanup();

const extensionSource = readFileSync(join(process.cwd(), "extensions", "index.ts"), "utf8");
assert.match(extensionSource, /"pi-session-memory"/);
assert.doesNotMatch(extensionSource, /registerCommand\("(?!pi-session-memory")/);
assert.match(SESSION_MEMORY_HELP, /^pi-session-memory\n/);
assert.match(SESSION_MEMORY_HELP, /Recall past discussions/);
assert.match(SESSION_MEMORY_HELP, /Run \/pi-session-memory to open one selectable menu/);
assert.doesNotMatch(SESSION_MEMORY_HELP, /[#*`]/, "TUI helper output must not contain Markdown markers");
assert.doesNotMatch(SESSION_MEMORY_HELP, /[\u4e00-\u9fff]/, "TUI helper output must be English only");
const currentWhatsNew = getWhatsNew("0.7.0");
assert.match(currentWhatsNew, /What.s New in pi-session-memory v0\.7\.0/);
assert.match(currentWhatsNew, /One command only: use the \/pi-session-memory folded menu/);
assert.doesNotMatch(currentWhatsNew, /pi-session-memory-helper|memory-search|memory-status/);
assert.match(readFileSync(join(process.cwd(), "README.md"), "utf8"), /Current version: 0\.7\.1/);
const codexWhatsNew = getWhatsNew("0.7.1");
assert.match(codexWhatsNew, /parent and child threads separate/);
assert.match(codexWhatsNew, /reparsed once/);
const whatsNew = getWhatsNew("0.6.2");
assert.match(whatsNew, /What.s New in pi-session-memory v0\.6\.2/);
assert.match(whatsNew, /Named-project recall/);
assert.match(whatsNew, /recallLimit/);
assert.doesNotMatch(whatsNew, /[#*`]/, "TUI What's New output must not contain Markdown markers");
assert.equal(showWhatsNewIfUpdated("0.6.2"), whatsNew, "a newly installed version must be shown once");
assert.equal(showWhatsNewIfUpdated("0.6.2"), undefined, "an already shown version must not be shown again");
assert.equal(showWhatsNewIfUpdated("0.6.3"), "", "an unlisted version still records as shown without inventing release notes");
assert.equal(showWhatsNewIfUpdated("0.6.3"), undefined);
rmSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true, force: true });
mkdirSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true });
const configPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));
assert.deepEqual(getSessionMemoryConfig(), { recallLimit: 2, jevEnable: false, model: "nimble" }, "legacy config must use backward-compatible defaults");
for (const model of JEV_MODELS) {
  writeFileSync(configPath, JSON.stringify({ recallLimit: 2, jevEnable: true, model }));
  assert.deepEqual(getSessionMemoryConfig(), { recallLimit: 2, jevEnable: true, model });
}
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, model: "unsupported" }));
assert.throws(() => getSessionMemoryConfig(), /model must be one of nimble, tev1:4b, tev1:0.8b/);
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));

for (const toolName of ["recall_memory", "recall_project_memory", "fetch_session", "get_memory_stats", "backfill_memory", "migrate_project_sessions"]) assert.match(extensionSource, new RegExp(`name: "${toolName}"`));
assert.doesNotMatch(extensionSource, /name: "migrate_(claude|codex)_project_sessions"/);
assert.match(extensionSource, /Search project history/);
assert.doesNotMatch(extensionSource, /"memory-project-search"/);
assert.match(extensionSource, /also call recall_project_memory/);
assert.match(extensionSource, /identical Chinese-and-English topic entities/);
assert.match(extensionSource, /never include the project name here/);
assert.match(extensionSource, /This is read-only and never creates a memory/);

upsertSession({ session_id: "claude:project-a", source: "claude", cwd: "/workspace/project-a", started_at: 1, model_id: null, jsonl_path: "/tmp/project-a.jsonl" });
for (const [index, text] of ["deploy memory testing", "deploy memory release", "literal %_\\ marker"] .entries()) {
  assert.equal(insertTurn({ turn_id: `claude:project-a:user-${index + 1}`, session_id: "claude:project-a", turn_index: index, ts: index + 1, user_text: text, reply_text: "confirmed", tool_names: null, user_message_id: `user-${index + 1}` }), true);
}
assert.deepEqual(recallTurns({ entities: ["deploy"] }).map((turn) => turn.turn_id), ["claude:project-a:user-2", "claude:project-a:user-1"]);
assert.deepEqual(recallTurns({ entities: ["%_\\"] }).map((turn) => turn.turn_id), ["claude:project-a:user-3"]);
assert.deepEqual(recallTurns({ entities: ["deploy"], cwd: "/wrong" }), []);
assert.deepEqual(recallTurns({ entities: ["deploy"], sessionIds: ["pi:missing"] }), []);
const deployResults = recallTurns({ entities: ["deploy"] });
assert.equal(deployResults.length, 2);
assert.match(formatRecallResults(deployResults, { entities: ["deploy"] }), /\*\*Results:\*\* 2[\s\S]*Matching raw conversation history[\s\S]*\*\*Fetch session ID:\*\* `claude:project-a`[\s\S]*Source turn ID/);
for (let index = 0; index < 6; index++) {
  assert.equal(insertTurn({ turn_id: `claude:project-a:extra-${index}`, session_id: "claude:project-a", turn_index: index + 3, ts: index + 4, user_text: "complete result set", reply_text: "", tool_names: null, user_message_id: `extra-${index}` }), true);
}
assert.equal(recallTurns({ entities: ["complete"] }).length, 2, "recall must use the single configured result limit");
upsertSession({ session_id: "codex:memory-project", source: "codex", cwd: "C:\\work\\pi-session-memory\\", started_at: 11, model_id: null, jsonl_path: "/tmp/pi-session-memory.jsonl" });
assert.equal(insertTurn({ turn_id: "codex:memory-project:user-1", session_id: "codex:memory-project", turn_index: 0, ts: 11, user_text: "设计数据库 schema", reply_text: "SQLite tables", tool_names: null, user_message_id: "memory-user-1" }), true);
const bilingualTopicEntities = ["数据库", "database"];
assert.deepEqual(recallTurns({ entities: bilingualTopicEntities }).map((turn) => turn.turn_id), ["codex:memory-project:user-1"], "direct recall is the first stage when bilingual topic entities match transcript text");
const projectRecall = recallProjectMemory({ project: "pi-session-memory", entities: bilingualTopicEntities });
assert.deepEqual(projectRecall.results.map((turn) => turn.turn_id), ["codex:memory-project:user-1"], "project-scoped retrieval runs alongside direct recall with identical bilingual entities");
assert.equal(recallTurns({ entities: ["pi-session-memory"] }).length, 0, "target project name may be absent from its own transcript");
const missingBilingualTopicEntities = ["不存在主题", "nonexistent topic"];
assert.deepEqual(recallTurns({ entities: missingBilingualTopicEntities }), [], "direct recall may have no bilingual topic match while project-scoped recall still exposes candidates");
const noTopicProjectRecall = recallProjectMemory({ project: "pi-session-memory", entities: missingBilingualTopicEntities });
assert.deepEqual(noTopicProjectRecall.results, []);
assert.deepEqual(noTopicProjectRecall.sessions.map((session) => session.session_id), ["codex:memory-project"]);
assert.match(formatProjectRecallResults(noTopicProjectRecall, { project: "pi-session-memory", entities: missingBilingualTopicEntities }), /Project match:[\s\S]*Project session candidates[\s\S]*codex:memory-project/);
assert.deepEqual(recallProjectMemory({ project: "pi-session-memory-fork", entities: bilingualTopicEntities }).sessions, [], "project matching must require every normalized project token in the final CWD directory name");
assert.deepEqual(recallProjectMemory({ project: "pi session", entities: bilingualTopicEntities }).sessions.map((session) => session.session_id), ["codex:memory-project"], "space-separated project names must match hyphenated final CWD directory names");
for (let index = 0; index < 3; index++) {
  upsertSession({ session_id: `pi:project-candidate-${index}`, source: "pi", cwd: "/workspace/pi-session-memory", started_at: 20 + index, model_id: null, jsonl_path: `/tmp/project-candidate-${index}.jsonl` });
  assert.equal(insertTurn({ turn_id: `pi:project-candidate-${index}:user-1`, session_id: `pi:project-candidate-${index}`, turn_index: 0, ts: 20 + index, user_text: "unrelated candidate", reply_text: "", tool_names: null, user_message_id: `candidate-${index}` }), true);
}
const limitedProjectCandidates = recallProjectMemory({ project: "pi-session-memory", entities: missingBilingualTopicEntities });
assert.deepEqual(limitedProjectCandidates.sessions.map((session) => session.session_id), ["pi:project-candidate-2", "pi:project-candidate-1"], "project candidates without topic matches must use recallLimit");
const olderProjectMatch = recallProjectMemory({ project: "pi-session-memory", entities: bilingualTopicEntities });
assert.deepEqual(olderProjectMatch.results.map((turn) => turn.turn_id), ["codex:memory-project:user-1"], "topic search must include project sessions older than the candidate display limit");
assert.deepEqual(olderProjectMatch.sessions.map((session) => session.session_id), ["codex:memory-project"], "successful recall must return metadata only for sessions represented in ranked results");
upsertSession({ session_id: "pi:native-app", source: "pi", cwd: "/workspace/pi-native-app", started_at: 12, model_id: null, jsonl_path: "/tmp/pi-native-app.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:native-app:user-1", session_id: "pi:native-app", turn_index: 0, ts: 12, user_text: "数据库 design", reply_text: "SQLite", tool_names: null, user_message_id: "native-app-user-1" }), true);
assert.deepEqual(recallProjectMemory({ project: "pi app", entities: bilingualTopicEntities }).sessions.map((session) => session.session_id), ["pi:native-app"], "partial project names must match normalized tokens in hyphenated final CWD directory names");
const fetched = fetchSession("claude:project-a", 1, 1);
assert.deepEqual(fetched.stored.turns.map((turn) => turn.turn_id), ["claude:project-a:user-2"]);
upsertSession({ session_id: "pi:session-uuid", source: "pi", cwd: "/workspace/project-a", started_at: 10, model_id: null, jsonl_path: "/tmp/session.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:session-uuid:user-1", session_id: "pi:session-uuid", turn_index: 0, ts: 10, user_text: "Pi source-prefix test", reply_text: "confirmed", tool_names: null, user_message_id: "user-1" }), true);
const piResults = recallTurns({ entities: ["source-prefix"] });
assert.match(formatRecallResults(piResults, { entities: ["source-prefix"] }), /\*\*Fetch session ID:\*\* `pi:session-uuid`/);
assert.deepEqual(fetchSession("pi:session-uuid").stored.turns.map((turn) => turn.turn_id), ["pi:session-uuid:user-1"]);
assert.throws(() => fetchSession("session-uuid"), /session_id must include its source prefix.*pi:<id>/);
const initialStats = getHistoryStats();
assert.equal(initialStats.sessions, 7);
assert.equal(initialStats.turns, 15);
assert.equal(initialStats.oldestTs, 1);
assert.equal(initialStats.newestTs, 22);
assert.deepEqual(initialStats.sources.map((source) => ({ ...source })), [
  { source: "claude", sessions: 1, turns: 9 },
  { source: "codex", sessions: 1, turns: 1 },
  { source: "pi", sessions: 5, turns: 5 },
]);

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
  JSON.stringify({ type: "model_change", modelId: "updated-model" }),
  JSON.stringify({ type: "message", id: "u-updated", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "replacement user" }] } }),
  JSON.stringify({ type: "message", id: "a-updated", parentId: "u-updated", timestamp: "2026-01-02T00:00:02.000Z", message: { role: "assistant", timestamp: 4, content: [{ type: "text", text: "replacement reply" }] } }),
].join("\n"));
assert.equal(backfillAll().turns, 1, "a force backfill must replace changed source data");
const replacedImported = getSession("pi:imported");
assert.equal(replacedImported.session.cwd, "/reindexed");
assert.equal(replacedImported.session.model_id, "updated-model");
assert.deepEqual(replacedImported.turns.map((turn) => [turn.user_message_id, turn.user_text, turn.reply_text]), [["u-updated", "replacement user", "replacement reply"]], "replacement must delete source turns that no longer exist");

const projectCwd = join(historyHome, "project");
mkdirSync(projectCwd, { recursive: true });
assert.equal(migrateClaudeProjectSessions(projectCwd).migratedSessions, 0);
assert.equal(migrateCodexProjectSessions(projectCwd).migratedSessions, 0);

const windowsProjectCwd = "C:/Users/Michael/project";
const claudeProjectRoot = join(historyHome, ".claude", "projects", "project");
mkdirSync(claudeProjectRoot, { recursive: true });
writeFileSync(join(claudeProjectRoot, "windows-paths.jsonl"), [
  JSON.stringify({ type: "user", uuid: "windows-user", sessionId: "windows-session", cwd: "c:\\Users\\MICHAEL\\project\\", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "migrate Windows paths" } }),
  JSON.stringify({ type: "assistant", uuid: "windows-assistant", sessionId: "windows-session", cwd: "c:\\Users\\MICHAEL\\project\\", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Windows session migrated" }] } }),
].join("\n"));
const windowsMigration = migrateClaudeProjectSessions(windowsProjectCwd);
assert.equal(windowsMigration.scannedFiles, 1);
assert.deepEqual(windowsMigration.issues, []);
assert.equal(windowsMigration.migratedSessions, 1, "equivalent Windows CWD spellings must migrate");
assert.equal(windowsMigration.migratedMessages, 2);
assert.ok(existsSync(join(historyHome, ".pi", "agent", "sessions", "--C--Users-Michael-project--")));

getDb().close();
cleanup();
console.log("core.test.ts: passed");
