import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "pi-memory-cleanup-"));
const databasePath = join(home, "memory.db");
process.env.HOME = home; process.env.USERPROFILE = home; process.env.MEMORY_DB_PATH = databasePath;
const { cleanMemoryToolTurns, deleteSessionsAtOrBelowTurnCount, formatMemoryToolCleanup } = await import("../src/history/memory-index-cleanup.ts");
const { registerMemoryCleanupTools } = await import("../src/history/memory-index-cleanup-tools.ts");
const { SESSION_MEMORY_TOOL_NAMES } = await import("../src/history/memory-index-policy.ts");
for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => deleteSessionsAtOrBelowTurnCount(invalid));
assert.throws(() => deleteSessionsAtOrBelowTurnCount(0));
assert.throws(() => cleanMemoryToolTurns());
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
  assert.throws(() => cleanMemoryToolTurns());
  assert.deepEqual(legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore, "backup setup failure must leave all legacy rows intact");
  insert.run("backup-probe", "legacy", 101, 101, "user", "reply", '["recall_memory"]', "backup-probe-user");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns WHERE turn_id = 'backup-probe'").get()!.n, 1, "a failed backup leaves writes unchanged");
  legacy.exec("DELETE FROM turns WHERE turn_id = 'backup-probe'");
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
      assert.throws(() => cleanMemoryToolTurns());
    } finally { DatabaseSync.prototype.prepare = nativePrepare; }
    assert.deepEqual(legacy.prepare("SELECT * FROM turns ORDER BY turn_index").all(), rowsBefore, `${failure} must not delete turns`);
    insert.run(`${failure}-probe`, "legacy", 101, 101, "user", "reply", '["recall_memory"]', `${failure}-probe-user`);
    assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns WHERE turn_id = ?").get(`${failure}-probe`)!.n, 1);
    legacy.prepare("DELETE FROM turns WHERE turn_id = ?").run(`${failure}-probe`);
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
  insert.run("old-writer", "legacy", 101, 101, "user", "reply", '["clean_memory_tool_turns"]', "old-writer-user");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 2, "cleanup tool turns are excluded even through already-open older writers");
  const second = cleanMemoryToolTurns();
  assert.deepEqual([second.before_turns, second.removed_turns, second.after_turns], [2, 0, 2]);
  assert.notEqual(second.backup_path, first.backup_path, "every invocation gets a distinct snapshot, including a no-op cleanup");
  assert.ok(formatMemoryToolCleanup(first).includes(first.backup_path));
  assert.doesNotMatch(formatMemoryToolCleanup(first), /USER_POLLUTION|FINAL_OKF_POLLUTION/);

  // Fail after trigger replacement starts: data and policy changes must roll back together.
  legacy.exec("DROP TRIGGER pi_session_memory_exclude_insert; DROP TRIGGER pi_session_memory_exclude_update;");
  insert.run("blocked", "legacy", 102, 102, "user", "reply", '["recall_memory"]', "blocked-user");
  legacy.exec("CREATE TRIGGER block_cleanup BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'blocked-delete'); END;");
  assert.throws(() => cleanMemoryToolTurns());
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 3);
  legacy.exec("DROP TRIGGER block_cleanup;");
  insert.run("rollback-probe", "legacy", 102, 102, "user", "reply", '["recall_memory"]', "rollback-probe-user");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns WHERE turn_id = 'rollback-probe'").get()!.n, 1, "a failed purge preserves the pre-operation write behavior");
  legacy.exec("DELETE FROM turns WHERE turn_id = 'rollback-probe'");
  insert.run("bad-metadata", "legacy", 103, 103, "user", "reply", '"recall_memory"', "bad-user");
  assert.throws(() => cleanMemoryToolTurns());
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns").get()!.n, 4, "invalid metadata must not silently skip rows or partially purge");
  legacy.exec("DELETE FROM turns WHERE turn_id = 'bad-metadata';");

  const tools: any[] = []; const notices: string[] = [];
  registerMemoryCleanupTools((tool: any) => { tools.push(tool); });
  const cleanupTool = tools.find(tool => tool.name === "clean_memory_tool_turns");
  assert.ok(cleanupTool);
  const ctx = { ui: { notify(text: string) { notices.push(text); } } };
  const { notifyMemoryToolCleanup } = await import("../src/history/memory-index-cleanup-tools.ts");
  notifyMemoryToolCleanup(ctx as any);
  const toolResult = await cleanupTool.execute();
  assert.equal(toolResult.details.removed_turns, 0);
  assert.equal(readFileSync(jsonlPath, "utf8"), jsonlBytes);
  assert.equal(readFileSync(okfPath, "utf8"), okfBytes);
  assert.deepEqual(legacy.prepare("SELECT * FROM sessions").all(), sessionsBefore);
  assert.deepEqual(legacy.prepare("SELECT * FROM source_files").all(), trackingBefore);
  // Session deletion shares backup verification but leaves exclusion policy and source tracking unchanged.
  const insertSession = legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)");
  for (const [id, count] of [["zero", 0], ["one", 1], ["two-a", 2], ["two-b", 2], ["above", 3], ["large", 5]] as const) {
    insertSession.run(id, id === "above" ? "other-source" : "pi", home, 1, "model", jsonlPath);
    for (let i = 0; i < count; i++) insert.run(`${id}:${i}`, id, 900 + i * 100, i, "keep user body", "keep reply", '["read"]', `${id}:user:${i}`);
  }
  insert.run("unrelated-orphan", "missing-session", 0, 0, "unrelated", "keep", '["read"]', "orphan-user");
  legacy.exec("CREATE TABLE memories(content TEXT); INSERT INTO memories VALUES ('keep legacy table'); PRAGMA user_version = 73;");
  const allSessions = () => legacy.prepare("SELECT * FROM sessions ORDER BY session_id").all();
  const allTurns = () => legacy.prepare("SELECT * FROM turns ORDER BY turn_id").all();
  const originalSessions = allSessions();
  const originalTurns = allTurns();
  const backupNames = () => readdirSync(backupDirectory).sort();
  const namesBeforeValidation = backupNames();
  for (const invalid of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => deleteSessionsAtOrBelowTurnCount(invalid));
  assert.deepEqual(backupNames(), namesBeforeValidation, "invalid limits must not access or back up the database");

  for (const failure of ["backup-write", "backup-check"]) {
    let checks = 0;
    let copies = 0;
    try {
      DatabaseSync.prototype.prepare = function(sql: string) {
        if (sql === "VACUUM main INTO ?") {
          copies++;
          if (failure === "backup-write") return { run() { throw new Error("injected-session-backup-write"); } } as any;
        }
        if (sql === "PRAGMA integrity_check" && ++checks === 2 && failure === "backup-check") return { all() { return [{ integrity_check: "injected-session-backup-check" }]; } } as any;
        return nativePrepare.call(this, sql);
      };
      assert.throws(() => deleteSessionsAtOrBelowTurnCount(2));
      assert.equal(copies, 1, "backup failures must not retry");
    } finally { DatabaseSync.prototype.prepare = nativePrepare; }
    assert.deepEqual(allSessions(), originalSessions);
    assert.deepEqual(allTurns(), originalTurns, "unverified backups must prevent all deletion");
  }

  legacy.exec("CREATE TRIGGER block_session_deletion BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'blocked-session-delete'); END;");
  assert.throws(() => deleteSessionsAtOrBelowTurnCount(2));
  assert.deepEqual(allSessions(), originalSessions);
  assert.deepEqual(allTurns(), originalTurns, "a session-delete failure must roll back already-deleted turns");
  legacy.exec("DROP TRIGGER block_session_deletion;");

  let lockedCopies = 0;
  let zero: ReturnType<typeof deleteSessionsAtOrBelowTurnCount>;
  try {
    DatabaseSync.prototype.prepare = function(sql: string) {
      if (sql === "VACUUM main INTO ?") {
        lockedCopies++;
        assert.throws(() => insert.run("concurrent-turn", "zero", 0, 0, "race", "race", '["read"]', "race-user"), "the deletion write lock must prevent changes between backup and target selection");
        assert.throws(() => this.exec("CREATE TABLE forbidden_source_write(n INTEGER)"), "backup reads use a read-only source connection");
      }
      return nativePrepare.call(this, sql);
    };
    zero = deleteSessionsAtOrBelowTurnCount(0);
  } finally { DatabaseSync.prototype.prepare = nativePrepare; }
  assert.equal(lockedCopies, 1);
  assert.deepEqual([zero.maximum_turns, zero.removed_sessions, zero.removed_turns], [0, 1, 0], "zero is valid and includes empty sessions");
  const zeroSnapshot = new DatabaseSync(zero.backup_path, { readOnly: true });
  try {
    assert.deepEqual(zeroSnapshot.prepare("SELECT * FROM sessions ORDER BY session_id").all(), originalSessions);
    assert.deepEqual(zeroSnapshot.prepare("SELECT * FROM turns ORDER BY turn_id").all(), originalTurns, "the verified snapshot contains every pre-deletion WAL row");
  } finally { zeroSnapshot.close(); }
  const beforeTwoSessions = allSessions();
  const beforeTwoTurns = allTurns();
  const deleted = deleteSessionsAtOrBelowTurnCount(2);
  assert.deepEqual([deleted.maximum_turns, deleted.removed_sessions, deleted.removed_turns], [2, 4, 7], "the inclusive threshold uses actual row counts, not turn_index");
  assert.deepEqual(allSessions().map(row => row.session_id), ["above", "large"], "every matched session is removed, while higher counts and other-source metadata stay intact");
  assert.equal(allTurns().length, 9);
  assert.ok(allTurns().some(row => row.turn_id === "unrelated-orphan"), "unrelated turns outside existing sessions stay unchanged");
  const deletedSnapshot = new DatabaseSync(deleted.backup_path, { readOnly: true });
  try {
    assert.deepEqual(deletedSnapshot.prepare("SELECT * FROM sessions ORDER BY session_id").all(), beforeTwoSessions);
    assert.deepEqual(deletedSnapshot.prepare("SELECT * FROM turns ORDER BY turn_id").all(), beforeTwoTurns);
  } finally { deletedSnapshot.close(); }
  const noMatch = deleteSessionsAtOrBelowTurnCount(2);
  assert.deepEqual([noMatch.removed_sessions, noMatch.removed_turns], [0, 0]);
  assert.notEqual(noMatch.backup_path, deleted.backup_path);
  const cleared = deleteSessionsAtOrBelowTurnCount(Number.MAX_SAFE_INTEGER);
  assert.deepEqual([cleared.removed_sessions, cleared.removed_turns], [2, 8]);
  assert.deepEqual(allSessions(), []);
  assert.equal(allTurns().length, 1);
  assert.deepEqual(legacy.prepare("SELECT * FROM source_files").all(), trackingBefore);
  insert.run("policy-check", "legacy", 1, 1, "user", "reply", '["recall_memory"]', "policy-check-user");
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM turns WHERE turn_id = 'policy-check'").get()!.n, 0, "session deletion preserves live tool-turn exclusion");
  assert.equal(legacy.prepare("PRAGMA user_version").get()!.user_version, 73);
  assert.deepEqual(legacy.prepare("SELECT * FROM memories").all().map(row => row.content), ["keep legacy table"]);
  assert.equal(readFileSync(jsonlPath, "utf8"), jsonlBytes);
  assert.equal(readFileSync(okfPath, "utf8"), okfBytes);
  legacy.exec("ALTER TABLE turns RENAME TO unavailable_turns;");
  const remainingSessions = legacy.prepare("SELECT * FROM sessions ORDER BY session_id").all();
  assert.throws(() => deleteSessionsAtOrBelowTurnCount(0));
  assert.deepEqual(legacy.prepare("SELECT * FROM sessions ORDER BY session_id").all(), remainingSessions);
  assert.equal(legacy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='turns'").get()!.n, 0, "unsupported schemas fail without creating missing tables");

  console.log("memory-index-cleanup tests passed: pre-purge WAL snapshot, exact whole-turn removal, unchanged metadata/JSONL/OKF, old writers, idempotence, backup failure, rollback, invalid metadata, menu and tool, inclusive session limits, zero-turn sessions, matching child-turn deletion, locked verified backups, unchanged policy, atomic failure rollback, strict input and schema errors");
} finally { legacy.close(); rmSync(home, { recursive: true, force: true }); }
