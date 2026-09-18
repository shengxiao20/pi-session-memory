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

function cleanup(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true }); rmSync(historyHome, { recursive: true, force: true }); }
cleanup();

const extensionSource = readFileSync(join(process.cwd(), "extensions", "index.ts"), "utf8");
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
assert.match(formatRecallResults(deployResults, { entities: ["deploy"] }), /\*\*Results:\*\* 2[\s\S]*Matching raw conversation history[\s\S]*Source turn ID/);
for (let index = 0; index < 6; index++) {
  assert.equal(insertTurn({ turn_id: `claude:project-a:extra-${index}`, session_id: "claude:project-a", turn_index: index + 3, ts: index + 4, user_text: "complete result set", reply_text: "", tool_names: null, user_message_id: `extra-${index}` }), true);
}
assert.equal(recallTurns({ entities: ["complete"] }).length, 6, "recall must return every match without a page cap");
const fetched = fetchSession("claude:project-a", 1, 1);
assert.deepEqual(fetched.stored.turns.map((turn) => turn.turn_id), ["claude:project-a:user-2"]);
const initialStats = getHistoryStats();
assert.equal(initialStats.sessions, 1);
assert.equal(initialStats.turns, 9);
assert.equal(initialStats.oldestTs, 1);
assert.equal(initialStats.newestTs, 9);
assert.deepEqual(initialStats.sources.map((source) => ({ ...source })), [{ source: "claude", sessions: 1, turns: 9 }]);

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

cleanup();
console.log("core.test.ts: passed");
