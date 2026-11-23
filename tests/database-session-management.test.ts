import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showDatabaseSessionManagement } from "../src/presentation/database-session-management.ts";

const home = mkdtempSync(join(tmpdir(), "pi-session-counts-"));
process.env.HOME = process.env.USERPROFILE = home;
const path = process.env.MEMORY_DB_PATH = join(home, "history.db");
const { getSessionTurnCounts } = await import("../src/history/db.ts");
type Entry = { session_id: string; turn_count: number };

function _ui(rows = 24) {
  const state = { closed: 0, renders: 0, builds: 0, color: "31", options: [] as string[][], selection: "Database session management" as string | undefined };
  let component: Component;
  const tui = { terminal: { rows }, requestRender() { state.renders++; } };
  const context = { mode: "tui", hasUI: true, ui: {
    async select(_title: string, options: string[]) { state.options.push(options); return state.selection; },
    custom(build: any) {
      state.builds++;
      return new Promise<void>(resolve => {
        component = build(tui, { fg: (_role: string, text: string) => `\x1b[${state.color}m${text}\x1b[0m` }, getKeybindings(), () => { state.closed++; resolve(); });
      });
    },
    notify() { throw new Error("Viewing must not notify, import, or change settings"); },
  } } as unknown as ExtensionContext;
  return { state, tui, context, view: () => component! };
}
function _plain(view: Component, width = 100): string[] { return view.render(width).map(line => stripVTControlCharacters(line).trimEnd()); }
function _chartLines(view: Component, width = 100) { return _plain(view, width).filter(line => /^(?:→ |  )\s*\d+ /.test(line)); }
function _bars(view: Component) { return _chartLines(view).map(line => ({ count: Number(line.match(/^.{2}\s*(\d+)/)![1]), cells: (line.match(/█/g) ?? []).length })); }

try {
  assert.throws(getSessionTurnCounts, /unable to open database/);
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
  for (const [session, count] of [["pi:largest", 100], ["pi:tie-z", 3], ["pi:tie-a", 3], ["pi:one", 1], ["pi:empty", 0], ["legacy:kept", 2]] as const) {
    addSession.run(session, session.startsWith("pi:") ? "pi" : "legacy");
    for (let i = 0; i < count; i++) addTurn.run(`${session}:${i}`, session, i % 2 === 0 ? 40 : 900, '["write_okf"]');
  }
  seed.close();
  const snapshot = readFileSync(path);
  const expected: Entry[] = [
    { session_id: "pi:largest", turn_count: 100 },
    { session_id: "pi:tie-a", turn_count: 3 },
    { session_id: "pi:tie-z", turn_count: 3 },
    { session_id: "legacy:kept", turn_count: 2 },
    { session_id: "pi:one", turn_count: 1 },
    { session_id: "pi:empty", turn_count: 0 },
  ];
  for (let i = 0; i < 3; i++) assert.deepEqual(getSessionTurnCounts().map(row => ({ ...row })), expected);
  assert.deepEqual(readFileSync(path), snapshot, "counts must not migrate, clean tool turns, filter legacy rows, or change source tracking");
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalClose = DatabaseSync.prototype.close;
  let queries = 0;
  let closes = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql: string) {
      queries++;
      assert.throws(() => this.exec("CREATE TABLE forbidden_write (value TEXT)"), /readonly database/, "the connection must enforce read-only access");
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.close = function() { closes++; originalClose.call(this); };
    assert.deepEqual(getSessionTurnCounts().map(row => ({ ...row })), expected);
    assert.equal(queries, 1, "one aggregate query reads all sessions");
    assert.equal(closes, 1);
    DatabaseSync.prototype.prepare = function() { queries++; throw new Error("Injected query failure"); };
    assert.throws(getSessionTurnCounts, /Injected query failure/);
    assert.equal(queries, 2, "failed queries must not retry");
    assert.equal(closes, 2, "failed queries still close the connection");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.close = originalClose;
  }
  assert.deepEqual(readFileSync(path), snapshot);

  const raw = Object.freeze([
    Object.freeze({ session_id: "pi:high", turn_count: 10 }),
    Object.freeze({ session_id: "pi:half", turn_count: 5 }),
    Object.freeze({ session_id: "pi:low", turn_count: 1 }),
    Object.freeze({ session_id: "pi:zero", turn_count: 0 }),
  ]);
  const ui = _ui();
  let reads = 0;
  const chart = showDatabaseSessionManagement(ui.context, () => { reads++; return raw; });
  assert.equal(reads, 1);
  assert.equal(ui.state.builds, 1);
  const lines = _plain(ui.view());
  assert.ok(lines.includes("Database session management"));
  assert.ok(lines.some(line => line.includes("4 sessions | 16 turns | Read-only snapshot | Descending turn count")));
  assert.deepEqual(_bars(ui.view()).map(row => row.count), [10, 5, 1, 0]);
  const bars = _bars(ui.view());
  assert.ok(bars[0].cells > 0);
  assert.equal(bars[1].cells, Math.round(bars[0].cells / 2));
  assert.ok(bars[2].cells >= 1);
  assert.equal(bars[3].cells, 0, "zero turns must never show a filled bar");
  ui.view().handleInput!("\x1b[B");
  assert.ok(_plain(ui.view()).includes("sessionId: pi:half"));
  ui.view().handleInput!("\x1b[F");
  assert.ok(_plain(ui.view()).includes("sessionId: pi:zero"));
  ui.view().handleInput!("\x1b[H");
  assert.ok(_plain(ui.view()).includes("sessionId: pi:high"));
  assert.equal(reads, 1, "navigation must not reread or scan history");
  ui.view().handleInput!("\r");
  await chart;
  assert.equal(ui.state.closed, 1, "Enter only closes the view");

  const many = Object.freeze(Array.from({ length: 100 }, (_, index) => Object.freeze({ session_id: `pi:00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, turn_count: 100 - index })));
  const paged = _ui(18);
  const pagination = showDatabaseSessionManagement(paged.context, () => many);
  assert.ok(_chartLines(paged.view()).length < many.length);
  paged.view().handleInput!("\x1b[6~");
  assert.ok(!_plain(paged.view()).includes(`sessionId: ${many[0].session_id}`));
  paged.view().handleInput!("\x1b[5~");
  assert.ok(_plain(paged.view()).includes(`sessionId: ${many[0].session_id}`));
  for (let i = 0; i < many.length; i++) {
    assert.ok(_plain(paged.view()).includes(`sessionId: ${many[i].session_id}`), "every session must remain reachable, without a recall limit");
    paged.view().handleInput!("\x1b[B");
  }
  paged.view().handleInput!("\x1b[F");
  for (const width of [20, 32, 48, 80, 120]) {
    const rendered = paged.view().render(width);
    assert.ok(rendered.every(line => visibleWidth(line) <= width), `native chart rows must fit ${width} columns`);
    if (width >= 48) assert.ok(rendered.length <= paged.tui.terminal.rows);
  }
  assert.ok(_plain(paged.view()).includes(`sessionId: ${many.at(-1)!.session_id}`), "resizing must preserve the selected session and its complete ID");
  paged.tui.terminal.rows = 12;
  assert.ok(paged.view().render(100).length <= 12);
  paged.state.color = "32";
  const themed = paged.view().render(100).join("\n");
  assert.ok(themed.includes("\x1b[32m"));
  assert.ok(!themed.includes("\x1b[31m"), "theme changes must not reuse old ANSI colors");
  paged.view().invalidate();
  paged.view().handleInput!("\x1b");
  await pagination;
  assert.equal(paged.state.closed, 1);

  for (const entries of [[], [{ session_id: "pi:empty", turn_count: 0 }], [{ session_id: "pi:給与🤖\x1b[31m\n\tend", turn_count: 100000 }, { session_id: "pi:tiny", turn_count: 1 }]] as Entry[][]) {
    const view = _ui();
    const result = showDatabaseSessionManagement(view.context, () => entries);
    for (const width of [20, 32, 80, 120]) assert.ok(view.view().render(width).every(line => visibleWidth(line) <= width));
    if (!entries.length) assert.ok(_plain(view.view()).includes("No sessions are indexed."));
    if (entries.length === 1) assert.equal(_bars(view.view())[0].cells, 0);
    if (entries.length === 2) {
      assert.ok(_plain(view.view()).includes("sessionId: pi:給与🤖  end"));
      assert.equal(_bars(view.view())[1].cells, 1, "small nonzero counts need one visible cell");
    }
    for (const key of ["\x1b[6~", "\x1b[5~", "\x1b[F", "\x1b[H", "\x1b[A"]) { view.view().handleInput!(key); _plain(view.view()); }
    view.view().handleInput!("\r");
    await result;
  }
  const unsupported = _ui();
  let unsupportedReads = 0;
  await assert.rejects(showDatabaseSessionManagement({ ...unsupported.context, mode: "json" } as ExtensionContext, () => { unsupportedReads++; return []; }), /requires Pi TUI mode/);
  assert.equal(unsupportedReads, 0, "non-TUI mode must fail before database access");
  assert.equal(unsupported.state.builds, 0, "no text fallback or custom UI in non-TUI mode");
  const failed = _ui();
  let failedReads = 0;
  await assert.rejects(showDatabaseSessionManagement(failed.context, () => { failedReads++; throw new Error("Injected read failure"); }), /Injected read failure/);
  assert.equal(failedReads, 1);
  assert.equal(failed.state.builds, 0, "failed reads must not show stale results");

  const commands: any[] = [];
  let registeredTools = 0;
  const extension = (await import("../extensions/index.ts")).default;
  extension({ on() {}, registerCommand(name: string, options: any) { commands.push({ name, ...options }); }, registerTool() { registeredTools++; }, sendUserMessage() { throw new Error("Database viewing must not start an Agent request"); } } as any);
  assert.equal(registeredTools, 15, "this feature adds a menu action, not an Agent tool");
  const menu = _ui();
  const menuResult = commands[0].handler("", menu.context);
  await Promise.resolve();
  assert.deepEqual(menu.state.options[0], ["Agentic setup", "Edit configuration", "Database session management", "Clean indexed tool turns", "Import history"]);
  assert.ok(_plain(menu.view()).some(line => line.includes("6 sessions | 109 turns")));
  assert.ok(_plain(menu.view()).includes("sessionId: pi:largest"));
  menu.view().handleInput!("\x1b");
  await menuResult;
  assert.ok(!existsSync(join(home, ".pi", "agent", "pi-session-memory", "config.json")), "viewing does not require or create configuration");
  assert.deepEqual(readFileSync(path), snapshot, "menu viewing must not import, migrate, delete, or modify the database");
  menu.state.selection = undefined;
  await commands[0].handler("", menu.context);
  assert.equal(menu.state.builds, 1, "cancelling the menu does not reopen the chart");
  menu.state.selection = "Database session management";
  await assert.rejects(commands[0].handler("", { ...menu.context, mode: "json" }), /requires Pi TUI mode/);
  assert.equal(menu.state.builds, 1);

  const changed = new DatabaseSync(path);
  changed.exec("DELETE FROM turns");
  changed.close();
  assert.deepEqual(getSessionTurnCounts().map(row => ({ ...row })), [...expected].sort((a, b) => a.session_id.localeCompare(b.session_id)).map(row => ({ ...row, turn_count: 0 })), "reopening reads current database counts");
  const empty = new DatabaseSync(path);
  empty.exec("DELETE FROM sessions");
  empty.close();
  assert.deepEqual(getSessionTurnCounts(), [], "an existing empty index has no synthetic session");
  const broken = new DatabaseSync(path);
  broken.exec("DROP TABLE turns");
  broken.close();
  await assert.rejects(commands[0].handler("", menu.context), /no such table: turns/);
  assert.equal(menu.state.builds, 1, "invalid schemas fail without migration or reopening a stale view");
  console.log("database session management tests passed: read-only aggregate counts, stable descending order, zero turns, no migrations or import, native bars, complete IDs, all sessions reachable, pagination, resize, Unicode, theme changes, menu routing, empty and error boundaries");
} finally {
  rmSync(home, { recursive: true, force: true });
}
