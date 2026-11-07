import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "pi-memory-index-policy-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const { SESSION_MEMORY_TOOL_NAMES, isMemoryToolTurn, installMemoryTurnExclusion } = await import("../src/history/memory-index-policy.ts");
const legacy = new DatabaseSync(process.env.MEMORY_DB_PATH);
legacy.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT NOT NULL, started_at INTEGER NOT NULL, model_id TEXT, jsonl_path TEXT NOT NULL);
CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, ts INTEGER NOT NULL, user_text TEXT NOT NULL, reply_text TEXT NOT NULL, tool_names TEXT, user_message_id TEXT);
CREATE TABLE source_files (jsonl_path TEXT PRIMARY KEY, source TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, sha256 TEXT NOT NULL, parser_version TEXT NOT NULL);`);
legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("pi:legacy", "pi", home, 0, null, "legacy.jsonl");
const rawInsert = legacy.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
for (const [index, tool] of SESSION_MEMORY_TOOL_NAMES.entries()) rawInsert.run(`legacy-${index}`, "pi:legacy", index, index, "user", "final OKF", JSON.stringify(["read", tool]), `message-${index}`);
rawInsert.run("ordinary", "pi:legacy", 20, 20, "Discuss recall_memory without calling it", "ordinary reply", '["read"]', "ordinary-message");
const { getDb, getSession, upsertSession, upsertTurn, insertTurn, replaceSourceFile } = await import("../src/history/db.ts");
const { writeTurn } = await import("../src/history/writer.ts");
const { backfillAll, syncChangedHistory } = await import("../src/history/backfill.ts");
const db = getDb();
try {
  assert.deepEqual(getSession("pi:legacy").turns.map(turn => turn.turn_id), ["ordinary"], "opening the DB purges old package-tool turns without removing ordinary turns or session metadata");
  for (const tool of SESSION_MEMORY_TOOL_NAMES) assert.equal(isMemoryToolTurn(JSON.stringify([tool])), true);
  assert.equal(isMemoryToolTurn(null), false);
  assert.equal(isMemoryToolTurn('["RECALL_MEMORY", "my_recall_memory", "read"]'), false);
  assert.throws(() => isMemoryToolTurn("invalid"), SyntaxError);
  assert.throws(() => isMemoryToolTurn('"recall_memory"'), /array of strings/);
  const row = { turn_id: "partial", session_id: "pi:legacy", turn_index: 25, ts: 25, user_text: "user", reply_text: "partial text", tool_names: null as string | null, user_message_id: "partial-user" };
  upsertTurn(row);
  assert.equal(getSession("pi:legacy").turns.length, 2);
  upsertTurn({ ...row, tool_names: '["fetch_session"]', reply_text: "final OKF" });
  assert.equal(getSession("pi:legacy").turns.length, 1, "live writes remove already-indexed partial turns");
  assert.equal(insertTurn({ ...row, tool_names: '["get_memory_stats"]' }), false);
  // Triggers apply to already-open older connections and direct SQL writes, not only modern helpers.
  rawInsert.run("old-writer", "pi:legacy", 30, 30, "user", "reply", '["backfill_memory"]', "old-user");
  assert.equal(db.prepare("SELECT count(*) AS n FROM turns WHERE turn_id = 'old-writer'").get()!.n, 0);
  legacy.prepare("UPDATE turns SET tool_names = ? WHERE turn_id = ?").run('["recall_memory"]', "ordinary");
  assert.equal(getSession("pi:legacy").turns.length, 0, "an old UPDATE removes an ordinary partial row once it calls a package tool");
  assert.throws(() => rawInsert.run("invalid", "pi:legacy", 0, 0, "user", "reply", "malformed", "invalid-user"), /malformed JSON/);
  replaceSourceFile({ jsonl_path: "replacement.jsonl", source: "pi", size: 1, mtime_ms: 1, sha256: "hash" }, {
    session: { session_id: "pi:replacement", source: "pi", cwd: home, started_at: 1, model_id: null, jsonl_path: "replacement.jsonl" },
    turns: [{ ...row, turn_id: "allowed-replacement", session_id: "pi:replacement", turn_index: 0 }, { ...row, turn_id: "excluded-replacement", session_id: "pi:replacement", turn_index: 1, tool_names: '["recall_project_memory"]' }],
  });
  assert.deepEqual(getSession("pi:replacement").turns.map(turn => turn.turn_index), [0]);
  // Import and live writes see the same full tree, including sibling assistant replies.
  const sourceRoot = join(home, ".pi", "agent", "sessions", "policy"); mkdirSync(sourceRoot, { recursive: true });
  const path = join(sourceRoot, "native.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries: any[] = [
    { type: "message", id: "u0", parentId: null, timestamp, message: { role: "user", content: "first ordinary turn", timestamp: 1 } },
    { type: "message", id: "a0", parentId: "u0", timestamp, message: { role: "assistant", content: [{ type: "text", text: "ordinary reply" }], timestamp: 2 } },
    { type: "message", id: "u1", parentId: "a0", timestamp, message: { role: "user", content: "history review", timestamp: 3 } },
    { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "inspect_memory_knowledge", arguments: {} }], timestamp: 4 } },
    { type: "message", id: "f1", parentId: "a1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Final OKF" }], timestamp: 5 } },
    { type: "message", id: "u2", parentId: "f1", timestamp, message: { role: "user", content: "last ordinary turn", timestamp: 6 } },
  ];
  const bytes = [{ type: "session", version: 3, id: "native-policy", cwd: home, timestamp }, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n";
  writeFileSync(path, bytes);
  const stats = backfillAll();
  assert.deepEqual(stats.issues, []); assert.equal(stats.turns, 2);
  assert.deepEqual(getSession("pi:native-policy").turns.map(turn => turn.turn_index), [0, 2], "indices remain source positions, not renumbered after exclusion");
  const manager: any = { getSessionId: () => "native-policy", getSessionFile: () => path, getCwd: () => home, getEntries: () => entries, getBranch: () => entries.slice(0, 5), getHeader: () => ({ timestamp }) };
  writeTurn({ sessionManager: manager } as any);
  assert.deepEqual(getSession("pi:native-policy").turns.map(turn => turn.turn_index), [0, 2]);
  assert.equal(syncChangedHistory().skippedFiles, 1);
  assert.equal(backfillAll().turns, 2);
  assert.equal(readFileSync(path, "utf8"), bytes, "cleanup/import never modify JSONL");
  installMemoryTurnExclusion(db);
  assert.deepEqual(getSession("pi:native-policy").turns.map(turn => turn.turn_index), [0, 2], "installation is idempotent");
  // A failed purge must roll back both its data deletion and trigger replacement.
  const broken = new DatabaseSync(":memory:");
  broken.exec("CREATE TABLE turns (turn_id TEXT PRIMARY KEY, tool_names TEXT); INSERT INTO turns VALUES ('bad', 'not JSON'), ('exclude', '[\"recall_memory\"]');");
  assert.throws(() => installMemoryTurnExclusion(broken), SyntaxError);
  assert.equal(broken.prepare("SELECT count(*) AS n FROM turns").get()!.n, 2);
  assert.equal(broken.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()!.n, 0);
  broken.close();
  const badPath = join(home, "malformed.db");
  const badDb = new DatabaseSync(badPath);
  badDb.exec("CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, ts INTEGER NOT NULL, user_text TEXT NOT NULL, reply_text TEXT NOT NULL, tool_names TEXT, user_message_id TEXT); INSERT INTO turns VALUES ('bad', 'session', 0, 0, 'user', 'reply', 'not JSON', NULL);");
  badDb.close();
  const failedOpen = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import assert from 'node:assert/strict'; const {getDb} = await import(${JSON.stringify(new URL("../src/history/db.ts", import.meta.url).href)}); assert.throws(() => getDb(), SyntaxError); assert.throws(() => getDb(), SyntaxError);`], { env: { ...process.env, MEMORY_DB_PATH: badPath }, encoding: "utf8" });
  assert.equal(failedOpen.status, 0, failedOpen.stderr);
  console.log("memory-index-policy tests passed: legacy purge, exact names, old connections, direct writes, partial-turn removal, import/live exclusion, stable indices, JSONL immutability and rollback");
} finally { legacy.close(); db.close(); rmSync(home, { recursive: true, force: true }); }
