import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "pi-memory-cleanup-"));
const databasePath = join(home, "memory.db");
process.env.HOME = home; process.env.USERPROFILE = home; process.env.MEMORY_DB_PATH = databasePath;
const { cleanMemoryToolTurns, formatMemoryToolCleanup } = await import("../src/history/memory-index-cleanup.ts");
const { registerMemoryCleanupTools } = await import("../src/history/memory-index-cleanup-tools.ts");
const { SESSION_MEMORY_TOOL_NAMES } = await import("../src/history/memory-index-policy.ts");
assert.throws(() => cleanMemoryToolTurns(), /ENOENT/);
assert.equal(existsSync(databasePath), false, "cleanup must not create an empty database for a missing index");
const legacy = new DatabaseSync(databasePath);
try {
  legacy.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at INTEGER, model_id TEXT, jsonl_path TEXT);
    CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT, turn_index INTEGER, ts INTEGER, user_text TEXT, reply_text TEXT, tool_names TEXT, user_message_id TEXT);
    CREATE TABLE source_files (jsonl_path TEXT PRIMARY KEY, source TEXT, size INTEGER, mtime_ms REAL, sha256 TEXT, parser_version TEXT);`);
  const jsonlPath = join(home, "source.jsonl");
  const okfPath = join(home, "knowledge", "meetings", "saved", "minutes.md");
  mkdirSync(dirname(okfPath), { recursive: true });
  const jsonlBytes = '{"type":"session","id":"legacy"}\n';
  const okfBytes = "---\ntitle: Saved conclusion\n---\nFinal OKF\n";
  writeFileSync(jsonlPath, jsonlBytes); writeFileSync(okfPath, okfBytes);
  legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("legacy", "pi", home, 1, "model", jsonlPath);
  legacy.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?)").run(jsonlPath, "pi", 39, 1.5, "hash", "tree-turns-v1");
  const insert = legacy.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [index, name] of SESSION_MEMORY_TOOL_NAMES.entries()) insert.run(`excluded-${index}`, "legacy", index, index, "USER_POLLUTION", "FINAL_OKF_POLLUTION", JSON.stringify(["read", name]), `user-${index}`);
  insert.run("ordinary", "legacy", 99, 99, "Mention recall_memory only", "ordinary reply", '["RECALL_MEMORY", "my_recall_memory", "read"]', "ordinary-user");
  insert.run("no-tools", "legacy", 100, 100, "No recorded tools", "reply", null, "plain-user");
  const rowsBefore = legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all();
  const sessionsBefore = legacy.prepare("SELECT * FROM sessions").all();
  const trackingBefore = legacy.prepare("SELECT * FROM source_files").all();
  const backupDirectory = join(home, "pi-session-memory", "backups");
  mkdirSync(dirname(backupDirectory), { recursive: true });
  writeFileSync(backupDirectory, "blocked directory");
  assert.throws(() => cleanMemoryToolTurns(), /EEXIST|ENOTDIR/);
  assert.deepEqual(legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore, "backup setup failure must leave all legacy rows intact");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()!.n, 0);
  rmSync(backupDirectory);

  const nativePrepare = DatabaseSync.prototype.prepare;
  for (const failure of ["backup-write", "backup-check"]) {
    let integrityChecks = 0;
    try {
      DatabaseSync.prototype.prepare = function (sql: string) {
        if (failure === "backup-write" && sql === "VACUUM main INTO ?") return { run() { throw new Error("injected-backup-write-failure"); } } as any;
        if (sql === "PRAGMA integrity_check" && ++integrityChecks === 2 && failure === "backup-check") return { all() { return [{ integrity_check: "injected-backup-corruption" }]; } } as any;
        return nativePrepare.call(this, sql);
      };
      assert.throws(() => cleanMemoryToolTurns(), (error: any) => /injected-backup-/.test(error.cause.message));
    } finally { DatabaseSync.prototype.prepare = nativePrepare; }
    assert.deepEqual(legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore, `${failure} must not delete turns`);
    assert.equal(legacy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()!.n, 0, `${failure} must not install policy before backup validation`);
  }

  assert.ok(statSync(`${databasePath}-wal`).size > 32, "source writes remain in WAL before the first backup");
  const first = cleanMemoryToolTurns();
  assert.equal(first.database_path, databasePath);
  assert.deepEqual([first.before_turns, first.removed_turns, first.after_turns], [SESSION_MEMORY_TOOL_NAMES.length + 2, SESSION_MEMORY_TOOL_NAMES.length, 2]);
  assert.equal(dirname(first.backup_path), backupDirectory);
  const snapshot = new DatabaseSync(first.backup_path, { readOnly: true });
  try {
    assert.deepEqual(snapshot.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore, "backup contains every pre-cleanup row, including uncheckpointed WAL and excluded final replies");
    assert.deepEqual(snapshot.prepare("SELECT * FROM sessions").all(), sessionsBefore);
    assert.deepEqual(snapshot.prepare("SELECT * FROM source_files").all(), trackingBefore);
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { snapshot.close(); }
  assert.deepEqual(legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore.slice(-2));
  assert.deepEqual(legacy.prepare("SELECT * FROM sessions").all(), sessionsBefore);
  assert.deepEqual(legacy.prepare("SELECT * FROM source_files").all(), trackingBefore);
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()!.n, 2);
  insert.run("old-writer", "legacy", 101, 101, "user", "reply", '["clean_memory_tool_turns"]', "old-writer-user");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 2, "cleanup tool turns are excluded even through already-open older writers");
  const second = cleanMemoryToolTurns();
  assert.deepEqual([second.before_turns, second.removed_turns, second.after_turns], [2, 0, 2]);
  assert.notEqual(second.backup_path, first.backup_path, "every invocation gets a distinct snapshot, including a no-op cleanup");
  assert.match(formatMemoryToolCleanup(first), /removed \d+ package-tool turns/);
  assert.ok(formatMemoryToolCleanup(first).includes(first.backup_path));
  assert.doesNotMatch(formatMemoryToolCleanup(first), /USER_POLLUTION|FINAL_OKF_POLLUTION/);

  // Fail after trigger replacement starts: data and policy changes must roll back together.
  legacy.exec("DROP TRIGGER pi_session_memory_exclude_insert; DROP TRIGGER pi_session_memory_exclude_update;");
  insert.run("blocked", "legacy", 102, 102, "user", "reply", '["recall_memory"]', "blocked-user");
  legacy.exec("CREATE TRIGGER block_cleanup BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'blocked-delete'); END;");
  assert.throws(() => cleanMemoryToolTurns(), (error: any) => /Backup target:/.test(error.message) && /blocked-delete/.test(error.cause.message));
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 3);
  assert.deepEqual(legacy.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row => row.name), ["block_cleanup"]);
  legacy.exec("DROP TRIGGER block_cleanup;");
  insert.run("bad-metadata", "legacy", 103, 103, "user", "reply", '"recall_memory"', "bad-user");
  assert.throws(() => cleanMemoryToolTurns(), (error: any) => /array of strings/.test(error.cause.message));
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 4, "invalid metadata must not silently skip rows or partially purge");
  legacy.exec("DELETE FROM turns WHERE turn_id = 'bad-metadata';");

  const tools: any[] = []; const notices: string[] = [];
  registerMemoryCleanupTools((tool: any) => { tools.push(tool); });
  assert.equal(tools[0].name, "clean_memory_tool_turns");
  assert.match(tools[0].description, /only when the user explicitly requests/);
  const ctx = { ui: { notify(text: string) { notices.push(text); } } };
  const { notifyMemoryToolCleanup } = await import("../src/history/memory-index-cleanup-tools.ts");
  notifyMemoryToolCleanup(ctx as any);
  assert.match(notices[0], /removed 1 package-tool turns; 2 turns remain/);
  const toolResult = await tools[0].execute();
  assert.equal(toolResult.details.removed_turns, 0);
  assert.equal(existsSync(toolResult.details.backup_path), true);
  assert.match(toolResult.content[0].text, /Existing model context and compaction summaries are not cleared/);
  assert.equal(readFileSync(jsonlPath, "utf8"), jsonlBytes);
  assert.equal(readFileSync(okfPath, "utf8"), okfBytes);
  assert.deepEqual(legacy.prepare("SELECT * FROM sessions").all(), sessionsBefore);
  assert.deepEqual(legacy.prepare("SELECT * FROM source_files").all(), trackingBefore);
  console.log("memory-index-cleanup tests passed: pre-purge WAL snapshot, exact whole-turn removal, unchanged metadata/JSONL/OKF, old writers, idempotence, backup failure, rollback, invalid metadata, menu and tool");
} finally { legacy.close(); rmSync(home, { recursive: true, force: true }); }
