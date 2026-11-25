import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deleteSessionsByTurnCount, SESSION_DELETION_LABEL, showDatabaseSessionManagement } from "../src/presentation/database-session-management.ts";

const home = mkdtempSync(join(tmpdir(), "pi-session-counts-"));
process.env.HOME = process.env.USERPROFILE = home;
const path = process.env.MEMORY_DB_PATH = join(home, "history.db");
const { getSessionTurnDistribution } = await import("../src/history/db.ts");
type Entry = { turn_count: number; session_count: number };

function _ui(rows = 24) {
  const state = { closed: 0, builds: 0, selection: "Database session management" as string | undefined };
  let component: Component;
  const tui = { terminal: { rows }, requestRender() {} };
  const context = { mode: "tui", hasUI: true, ui: {
    async select() { return state.selection; },
    custom(build: any) {
      state.builds++;
      return new Promise<void>(resolve => {
        component = build(tui, {
          fg: (_role: string, text: string) => text,
        }, getKeybindings(), () => { state.closed++; resolve(); });
      });
    },
    notify() { throw new Error("Viewing must not notify, import, or change settings"); },
  } } as unknown as ExtensionContext;
  return { state, tui, context, view: () => component! };
}
function _deletionUi(answer: string | undefined) {
  const state = { calls: [] as string[], notifications: [] as { text: string; type: string }[] };
  const context = { mode: "tui", hasUI: true, ui: {
    async select() { state.calls.push("select"); return SESSION_DELETION_LABEL; },
    async input() { state.calls.push("input"); return answer; },
    confirm() { throw new Error("Session deletion must use the requested input-only flow"); },
    custom() { throw new Error("Session deletion must use the native number input"); },
    notify(text: string, type: string) { state.calls.push("notify"); state.notifications.push({ text, type }); },
  } } as unknown as ExtensionContext;
  return { state, context };
}
try {
  assert.throws(getSessionTurnDistribution);
  assert.ok(!existsSync(path), "viewing a missing index must not create it");
  const seed = new DatabaseSync(path);
  // This legacy schema would lose turns and non-Pi rows if getDb() ran migrations.
  seed.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT NOT NULL);
    CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT, turn_index INTEGER, tool_names TEXT);
    CREATE INDEX idx_turns_session ON turns(session_id, turn_index);
    CREATE TABLE source_files (jsonl_path TEXT PRIMARY KEY, source TEXT, parser_version TEXT);
    INSERT INTO source_files VALUES ('/missing/source.jsonl', 'legacy', 'keep-parser');
    CREATE TABLE memories (content TEXT);
    INSERT INTO memories VALUES ('keep obsolete table untouched');
    PRAGMA user_version = 73;
  `);
  const addSession = seed.prepare("INSERT INTO sessions VALUES (?, ?)");
  const addTurn = seed.prepare("INSERT INTO turns VALUES (?, ?, ?, ?)");
  for (const [session, count] of [["pi:largest", 100], ["pi:tie-z", 3], ["pi:tie-a", 3], ["pi:給与🤖\x1b[31m\n\tend", 3], ["pi:one", 1], ["pi:empty", 0], ["legacy:kept", 2]] as const) {
    addSession.run(session, session.startsWith("pi:") ? "pi" : "legacy");
    for (let i = 0; i < count; i++) addTurn.run(`${session}:${i}`, session, i % 2 === 0 ? 40 : 900, '["write_okf"]');
  }
  seed.close();
  const snapshot = readFileSync(path);
  const expected: Entry[] = [
    { turn_count: 100, session_count: 1 },
    { turn_count: 3, session_count: 3 },
    { turn_count: 2, session_count: 1 },
    { turn_count: 1, session_count: 1 },
    { turn_count: 0, session_count: 1 },
  ];
  for (let i = 0; i < 3; i++) assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), expected);
  assert.ok(getSessionTurnDistribution().every(row => !Object.keys(row).includes("session_id")), "the query returns only grouped frequencies, never individual session IDs");
  assert.deepEqual(readFileSync(path), snapshot, "counts must not migrate, clean tool turns, filter legacy rows, or change source tracking");
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalClose = DatabaseSync.prototype.close;
  let failedQueryAttempts = 0;
  let closes = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql: string) {
      assert.throws(() => this.exec("CREATE TABLE forbidden_write (value TEXT)"), "the connection must enforce read-only access");
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.close = function() { closes++; originalClose.call(this); };
    assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), expected);
    assert.equal(closes, 1);
    const queryFailure = new Error("Injected query failure");
    DatabaseSync.prototype.prepare = function() { failedQueryAttempts++; throw queryFailure; };
    assert.throws(getSessionTurnDistribution, error => error === queryFailure);
    assert.equal(failedQueryAttempts, 1, "failed queries must not retry");
    assert.equal(closes, 2, "failed queries still close the connection");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.close = originalClose;
  }
  assert.deepEqual(readFileSync(path), snapshot);

  const ui = _ui();
  const chart = showDatabaseSessionManagement(ui.context, () => expected);
  assert.equal(ui.state.builds, 1);
  ui.view().handleInput!("\x1b");
  await chart;
  assert.equal(ui.state.closed, 1, "Escape closes the view");
  const unsupported = _ui();
  let unsupportedReads = 0;
  await assert.rejects(showDatabaseSessionManagement({ ...unsupported.context, mode: "json" } as ExtensionContext, () => { unsupportedReads++; return []; }));
  assert.equal(unsupportedReads, 0, "non-TUI mode must fail before database access");
  assert.equal(unsupported.state.builds, 0, "no text fallback or custom UI in non-TUI mode");
  const failed = _ui();
  let failedReads = 0;
  const readFailure = new Error("Injected read failure");
  await assert.rejects(showDatabaseSessionManagement(failed.context, () => { failedReads++; throw readFailure; }), error => error === readFailure);
  assert.equal(failedReads, 1);
  assert.equal(failed.state.builds, 0, "failed reads must not show stale results");

  for (const value of ["0", " 2 ", String(Number.MAX_SAFE_INTEGER)]) {
    const deletion = _deletionUi(value);
    await deleteSessionsByTurnCount(deletion.context, maximum => {
      deletion.state.calls.push("delete");
      assert.equal(maximum, Number(value));
      return { removed_sessions: 2, removed_turns: 0, backup_path: "temporary-backup.db" };
    });
    assert.deepEqual(deletion.state.calls, ["input", "delete", "notify"]);
    assert.equal(deletion.state.notifications[0].type, "info");
  }
  for (const value of ["", " ", "-1", "2.5", "NaN", "Infinity", "1e3", "0x10", "+2", String(Number.MAX_SAFE_INTEGER + 1)]) {
    const deletion = _deletionUi(value);
    await assert.rejects(deleteSessionsByTurnCount(deletion.context, () => { throw new Error("Invalid input must not touch the database"); }));
    assert.deepEqual(deletion.state.calls, ["input"], "invalid input must fail without retry, deletion or success notification");
  }
  const cancelledDeletion = _deletionUi(undefined);
  await deleteSessionsByTurnCount(cancelledDeletion.context, () => { throw new Error("Cancelled input must not delete"); });
  assert.deepEqual(cancelledDeletion.state.calls, ["input"]);
  const failedDeletion = _deletionUi("2");
  let attempts = 0;
  const deletionFailure = new Error("Injected deletion failure");
  await assert.rejects(deleteSessionsByTurnCount(failedDeletion.context, () => { attempts++; throw deletionFailure; }), error => error === deletionFailure);
  assert.equal(attempts, 1);
  assert.deepEqual(failedDeletion.state.calls, ["input"], "failed deletion must not retry or report stale success");
  const jsonDeletion = _deletionUi("2");
  await assert.rejects(deleteSessionsByTurnCount({ ...jsonDeletion.context, mode: "json" } as ExtensionContext, () => { throw new Error("Unsupported mode must not access SQLite"); }));
  assert.deepEqual(jsonDeletion.state.calls, []);

  const commands: any[] = [];
  const extension = (await import("../extensions/index.ts")).default;
  extension({ on() {}, registerCommand(name: string, options: any) { commands.push({ name, ...options }); }, registerTool() {}, sendUserMessage() { throw new Error("Database viewing must not start an Agent request"); } } as any);
  const memoryCommand = commands.find(command => command.name === "pi-session-memory")!;
  const menu = _ui();
  const menuResult = memoryCommand.handler("", menu.context);
  await Promise.resolve();
  menu.view().handleInput!("\x1b");
  await menuResult;
  assert.ok(!existsSync(join(home, ".pi", "agent", "pi-session-memory", "config.json")), "viewing does not require or create configuration");
  assert.deepEqual(readFileSync(path), snapshot, "menu viewing must not import, migrate, delete, or modify the database");
  menu.state.selection = undefined;
  await memoryCommand.handler("", menu.context);
  assert.equal(menu.state.builds, 1, "cancelling the menu does not reopen the chart");
  menu.state.selection = "Database session management";
  await assert.rejects(memoryCommand.handler("", { ...menu.context, mode: "json" }));
  assert.equal(menu.state.builds, 1);

  const cancelledMenuDeletion = _deletionUi(undefined);
  await memoryCommand.handler("", cancelledMenuDeletion.context);
  assert.deepEqual(cancelledMenuDeletion.state.calls, ["select", "input"]);
  assert.deepEqual(readFileSync(path), snapshot);
  assert.ok(!existsSync(join(home, "pi-session-memory", "backups")), "cancellation must not open or back up SQLite");
  const invalidMenuDeletion = _deletionUi("-1");
  await assert.rejects(memoryCommand.handler("", invalidMenuDeletion.context));
  assert.deepEqual(readFileSync(path), snapshot);
  const deleteMenu = _deletionUi("2");
  await memoryCommand.handler("", deleteMenu.context);
  assert.deepEqual(deleteMenu.state.calls, ["select", "input", "notify"]);
  assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), [{ turn_count: 100, session_count: 1 }, { turn_count: 3, session_count: 3 }]);
  const afterDelete = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(afterDelete.prepare("SELECT count(*) AS n FROM turns").get()!.n, 109, "deletion must not purge other package-tool turns");
    assert.equal(afterDelete.prepare("PRAGMA user_version").get()!.user_version, 73);
    assert.equal(afterDelete.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()!.n, 0);
    assert.deepEqual(afterDelete.prepare("SELECT * FROM source_files").all().map(row => ({ ...row })), [{ jsonl_path: "/missing/source.jsonl", source: "legacy", parser_version: "keep-parser" }]);
    assert.equal(afterDelete.prepare("SELECT * FROM memories").get()!.content, "keep obsolete table untouched");
  } finally { afterDelete.close(); }

  const changed = new DatabaseSync(path);
  changed.exec("DELETE FROM turns");
  changed.close();
  assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), [{ turn_count: 0, session_count: 4 }], "reopening groups all remaining zero-turn sessions together");
  const empty = new DatabaseSync(path);
  empty.exec("DELETE FROM sessions");
  empty.close();
  assert.deepEqual(getSessionTurnDistribution(), [], "an existing empty index has no synthetic group");
  const broken = new DatabaseSync(path);
  broken.exec("DROP TABLE turns");
  broken.close();
  await assert.rejects(memoryCommand.handler("", menu.context));
  assert.equal(menu.state.builds, 1, "invalid schemas fail without migration or reopening a stale view");
  console.log("database session management tests passed: read-only grouped frequencies, navigation, menu routing, inclusive deletion, cancellation, validation and errors");
} finally {
  rmSync(home, { recursive: true, force: true });
}
