import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-history-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-history-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;

const { getDb, getHistoryStats, getSession, insertTurn, upsertSession } = await import("../src/db.ts");
const { fetchSession } = await import("../src/fetch-session.ts");
const { formatRecallResults, recallTurns } = await import("../src/retriever.ts");
const { backfillAll, syncChangedHistory } = await import("../src/backfill.ts");
const { migrateClaudeProjectSessions, migrateCodexProjectSessions } = await import("../src/session-migration.ts");
const { getWhatsNew, showWhatsNewIfUpdated } = await import("../src/whats-new.ts");
const { SESSION_MEMORY_HELP } = await import("../src/helper.ts");

function cleanup(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true }); rmSync(historyHome, { recursive: true, force: true }); }
cleanup();

const extensionSource = readFileSync(join(process.cwd(), "extensions", "index.ts"), "utf8");
assert.match(extensionSource, /"pi-session-memory-whats-new"/);
assert.match(SESSION_MEMORY_HELP, /^pi-session-memory\n/);
assert.match(SESSION_MEMORY_HELP, /Recall past discussions/);
assert.match(SESSION_MEMORY_HELP, /\/pi-session-memory-whats-new/);
assert.doesNotMatch(SESSION_MEMORY_HELP, /[#*`]/, "TUI helper output must not contain Markdown markers");
assert.doesNotMatch(SESSION_MEMORY_HELP, /[\u4e00-\u9fff]/, "TUI helper output must be English only");
const whatsNew = getWhatsNew("0.6.1");
assert.match(whatsNew, /What.s New in pi-session-memory v0\.6\.1/);
assert.match(whatsNew, /Fetch session ID/);
assert.match(whatsNew, /pi:\/claude:\/codex:/);
assert.doesNotMatch(whatsNew, /[#*`]/, "TUI What's New output must not contain Markdown markers");
assert.equal(showWhatsNewIfUpdated("0.6.1"), whatsNew, "a newly installed version must be shown once");
assert.equal(showWhatsNewIfUpdated("0.6.1"), undefined, "an already shown version must not be shown again");
assert.equal(showWhatsNewIfUpdated("0.6.2"), "", "an unlisted version still records as shown without inventing release notes");
assert.equal(showWhatsNewIfUpdated("0.6.2"), undefined);
rmSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true, force: true });

for (const toolName of ["recall_memory", "fetch_session", "get_memory_stats", "backfill_memory", "migrate_codex_project_sessions", "migrate_claude_project_sessions"]) assert.match(extensionSource, new RegExp(`name: "${toolName}"`));
assert.match(extensionSource, /This is read-only and never creates a memory/);

upsertSession({ session_id: "claude:project-a", source: "claude", cwd: "/workspace/project-a", started_at: 1, model_id: null, jsonl_path: "/tmp/project-a.jsonl" });
for (const [index, text] of ["deploy memory testing", "deploy memory release", "literal %_\\ marker"] .entries()) {
  assert.equal(insertTurn({ turn_id: `claude:project-a:user-${index + 1}`, session_id: "claude:project-a", turn_index: index, ts: index + 1, user_text: text, reply_text: "confirmed", tool_names: null, user_message_id: `user-${index + 1}` }), true);
}
assert.deepEqual(recallTurns({ entities: ["deploy"] }).map((turn) => turn.turn_id), ["claude:project-a:user-2", "claude:project-a:user-1"]);
assert.deepEqual(recallTurns({ entities: ["%_\\"] }).map((turn) => turn.turn_id), ["claude:project-a:user-3"]);
assert.deepEqual(recallTurns({ entities: ["deploy"], cwd: "/wrong" }), []);
const deployResults = recallTurns({ entities: ["deploy"] });
assert.equal(deployResults.length, 2);
assert.match(formatRecallResults(deployResults, { entities: ["deploy"] }), /\*\*Results:\*\* 2[\s\S]*Matching raw conversation history[\s\S]*\*\*Fetch session ID:\*\* `claude:project-a`[\s\S]*Source turn ID/);
for (let index = 0; index < 6; index++) {
  assert.equal(insertTurn({ turn_id: `claude:project-a:extra-${index}`, session_id: "claude:project-a", turn_index: index + 3, ts: index + 4, user_text: "complete result set", reply_text: "", tool_names: null, user_message_id: `extra-${index}` }), true);
}
assert.equal(recallTurns({ entities: ["complete"] }).length, 6, "recall must return every match without a page cap");
const fetched = fetchSession("claude:project-a", 1, 1);
assert.deepEqual(fetched.stored.turns.map((turn) => turn.turn_id), ["claude:project-a:user-2"]);
upsertSession({ session_id: "pi:session-uuid", source: "pi", cwd: "/workspace/project-a", started_at: 10, model_id: null, jsonl_path: "/tmp/session.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:session-uuid:user-1", session_id: "pi:session-uuid", turn_index: 0, ts: 10, user_text: "Pi source-prefix test", reply_text: "confirmed", tool_names: null, user_message_id: "user-1" }), true);
const piResults = recallTurns({ entities: ["source-prefix"] });
assert.match(formatRecallResults(piResults, { entities: ["source-prefix"] }), /\*\*Fetch session ID:\*\* `pi:session-uuid`/);
assert.deepEqual(fetchSession("pi:session-uuid").stored.turns.map((turn) => turn.turn_id), ["pi:session-uuid:user-1"]);
assert.throws(() => fetchSession("session-uuid"), /session_id must include its source prefix.*pi:<id>/);
const initialStats = getHistoryStats();
assert.equal(initialStats.sessions, 2);
assert.equal(initialStats.turns, 10);
assert.equal(initialStats.oldestTs, 1);
assert.equal(initialStats.newestTs, 10);
assert.deepEqual(initialStats.sources.map((source) => ({ ...source })), [
  { source: "claude", sessions: 1, turns: 9 },
  { source: "pi", sessions: 1, turns: 1 },
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

cleanup();
console.log("core.test.ts: passed");
