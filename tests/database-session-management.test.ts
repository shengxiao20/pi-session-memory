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
const { getSessionTurnDistribution } = await import("../src/history/db.ts");
type Entry = { turn_count: number; session_count: number };

function _ui(rows = 24) {
  const state = { closed: 0, renders: 0, builds: 0, color: "31", options: [] as string[][], selection: "Database session management" as string | undefined };
  let component: Component;
  const tui = { terminal: { rows }, requestRender() { state.renders++; } };
  const context = { mode: "tui", hasUI: true, ui: {
    async select(_title: string, options: string[]) { state.options.push(options); return state.selection; },
    custom(build: any) {
      state.builds++;
      return new Promise<void>(resolve => {
        component = build(tui, {
          fg: (_role: string, text: string) => `\x1b[${state.color}m${text}\x1b[0m`,
        }, getKeybindings(), () => { state.closed++; resolve(); });
      });
    },
    notify() { throw new Error("Viewing must not notify, import, or change settings"); },
  } } as unknown as ExtensionContext;
  return { state, tui, context, view: () => component! };
}
function _sampledChart(context: ExtensionContext, readEntries: () => readonly Entry[], samples: readonly number[]) {
  const original = Math.random;
  let draws = 0;
  Math.random = () => samples[draws++]!;
  try {
    const result = showDatabaseSessionManagement(context, readEntries);
    return { result, draws };
  } finally { Math.random = original; }
}
function _plain(view: Component, width = 100): string[] { return view.render(width).map(line => stripVTControlCharacters(line).trimEnd()); }
function _chartLines(view: Component, width = 100) { return _plain(view, width).filter(line => /^(?:→ |  )\s*\d+ /.test(line)); }
function _bars(view: Component, width = 100) {
  return _chartLines(view, width).map(line => {
    const match = line.match(/^.{2}(\d+)\s+(█*) (\d+)$/)!;
    return { turns: Number(match[1]), sessions: Number(match[3]), cells: match[2].length };
  });
}
function _shades(view: Component, width = 100) {
  return view.render(width).filter(line => /^(?:→ |  )\d+ /.test(stripVTControlCharacters(line))).map(line => {
    const rgb = line.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m█*\x1b\[39m/)!;
    assert.ok(rgb, "each solid bar needs an explicit RGB foreground");
    assert.equal(rgb[1], rgb[2]);
    assert.equal(rgb[2], rgb[3]);
    assert.ok(Number(rgb[1]) >= 0 && Number(rgb[1]) <= 255, "grayscale includes black through white");
    return { turns: Number(stripVTControlCharacters(line).match(/^.{2}(\d+)/)![1]), shade: Number(rgb[1]) };
  });
}
function _selectedBar(view: Component) {
  return _bars(view)[_chartLines(view).findIndex(line => line.startsWith("→ "))];
}

try {
  assert.throws(getSessionTurnDistribution, /unable to open database/);
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
  let queries = 0;
  let closes = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql: string) {
      queries++;
      assert.throws(() => this.exec("CREATE TABLE forbidden_write (value TEXT)"), /readonly database/, "the connection must enforce read-only access");
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.close = function() { closes++; originalClose.call(this); };
    assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), expected);
    assert.equal(queries, 1, "one aggregate query reads all groups");
    assert.equal(closes, 1);
    DatabaseSync.prototype.prepare = function() { queries++; throw new Error("Injected query failure"); };
    assert.throws(getSessionTurnDistribution, /Injected query failure/);
    assert.equal(queries, 2, "failed queries must not retry");
    assert.equal(closes, 2, "failed queries still close the connection");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.close = originalClose;
  }
  assert.deepEqual(readFileSync(path), snapshot);

  const raw = Object.freeze([
    Object.freeze({ turn_count: 100, session_count: 10 }),
    Object.freeze({ turn_count: 50, session_count: 5 }),
    Object.freeze({ turn_count: 10, session_count: 1 }),
    Object.freeze({ turn_count: 0, session_count: 2 }),
  ]);
  const ui = _ui();
  let reads = 0;
  const { result: chart, draws } = _sampledChart(ui.context, () => { reads++; return raw; }, [0, 0.5, 1 - Number.EPSILON, 0.25]);
  assert.equal(draws, raw.length, "sample one color per group when opening the chart");
  assert.equal(reads, 1);
  assert.equal(ui.state.builds, 1);
  const lines = _plain(ui.view());
  assert.ok(lines.includes("Database session management"));
  assert.ok(lines.some(line => line.includes("Total sessions: 18 | Total turns: 1260 | Groups: 4 | Read-only snapshot")));
  const columnHeading = lines.find(line => line.includes("Turns per session") && line.includes("Session count"))!;
  assert.ok(columnHeading, "the numeric columns need explicit metric labels");
  const chartLines = _chartLines(ui.view());
  assert.equal(columnHeading.indexOf("Turns per session"), 2, "the metric heading starts at the numeric column");
  assert.ok(chartLines.every(line => /^.{2}\d+ /.test(line)), "numeric labels have no extra left indentation");
  assert.ok(chartLines.every(line => line.indexOf("█") === columnHeading.indexOf("Session count")), "bars align with the session-count heading");
  const renderedRows = ui.view().render(100);
  const rowIndexes = renderedRows.flatMap((line, index) => /^(?:→ |  )\d+ /.test(stripVTControlCharacters(line)) ? [index] : []);
  assert.equal(rowIndexes.length, raw.length);
  assert.deepEqual(rowIndexes, [3, 4, 5, 6], "each group occupies one consecutive line without border rows or gaps");
  assert.doesNotMatch(renderedRows.join("\n"), /[┌┐└┘│▓▒]|\x1b\[48;/, "solid bars have no outlines, texture or background fill");
  assert.ok(rowIndexes.every(index => /\x1b\[31m\d+\x1b\[0m/.test(renderedRows[index])), "session-count annotations remain visible beside each bar");
  const shades = _shades(ui.view());
  assert.deepEqual(shades.map(row => row.shade), [0, 128, 255, 64], "sampled colors include black, gray, white and intermediate grayscale");
  assert.deepEqual(_shades(ui.view()), shades, "repainting must preserve each group's sampled color");
  assert.ok(!lines.join("\n").includes("sessionId"));
  assert.deepEqual(_bars(ui.view()).map(row => row.turns), [100, 50, 10, 0]);
  assert.deepEqual(_bars(ui.view()).map(row => row.sessions), [10, 5, 1, 2], "the number immediately after each bar is the group session count");
  const bars = _bars(ui.view());
  assert.ok(bars[0].cells > 0);
  assert.equal(bars[1].cells, Math.round(bars[0].cells / 2));
  assert.ok(bars[2].cells >= 1);
  assert.equal(bars[3].cells, Math.round(bars[0].cells / 5), "zero-turn groups have a bar for their session frequency, not a zero-length turn-count bar");
  ui.view().handleInput!("\x1b[B");
  assert.equal(_selectedBar(ui.view()).turns, 50);
  assert.deepEqual(_shades(ui.view()), shades, "moving selection preserves all sampled colors");
  ui.view().handleInput!("\x1b[F");
  assert.equal(_selectedBar(ui.view()).turns, 0);
  ui.view().handleInput!("\x1b[H");
  assert.equal(_selectedBar(ui.view()).turns, 100);
  assert.equal(reads, 1, "navigation must not reread or scan history");
  ui.view().handleInput!("\r");
  await chart;
  assert.equal(ui.state.closed, 1, "Enter only closes the view");
  const reopened = _ui();
  const fresh = _sampledChart(reopened.context, () => raw, raw.map(() => 0.75));
  assert.equal(fresh.draws, raw.length);
  assert.deepEqual(_shades(reopened.view()).map(row => row.shade), [192, 192, 192, 192], "reopening samples a fresh palette without changing the input");
  assert.deepEqual(Object.keys(raw[0]), ["turn_count", "session_count"]);
  reopened.view().handleInput!("\r");
  await fresh.result;

  const many = Object.freeze(Array.from({ length: 100 }, (_, index) => Object.freeze({ turn_count: 100 - index, session_count: index % 5 + 1 })));
  const paged = _ui(18);
  const { result: pagination, draws: pageDraws } = _sampledChart(paged.context, () => many, many.map((_, index) => index / 256));
  assert.equal(pageDraws, many.length);
  assert.ok(_chartLines(paged.view()).length < many.length);
  paged.view().handleInput!("\x1b[6~");
  assert.notEqual(_selectedBar(paged.view()).turns, many[0].turn_count);
  paged.view().handleInput!("\x1b[5~");
  assert.equal(_selectedBar(paged.view()).turns, many[0].turn_count);
  for (let i = 0; i < many.length; i++) {
    assert.equal(_selectedBar(paged.view()).turns, many[i].turn_count, "every frequency group must remain reachable, without a recall limit");
    assert.ok(_shades(paged.view()).every(row => row.shade === 100 - row.turns), "paging keeps the sampled shade for every group");
    paged.view().handleInput!("\x1b[B");
  }
  paged.view().handleInput!("\x1b[F");
  for (const width of [20, 32, 48, 80, 120]) {
    const rendered = paged.view().render(width);
    assert.ok(rendered.every(line => visibleWidth(line) <= width), `native chart rows must fit ${width} columns`);
    assert.ok(rendered.length <= paged.tui.terminal.rows);
    assert.ok(_bars(paged.view(), width).every(row => row.sessions === many.find(entry => entry.turn_count === row.turns)!.session_count), "resizing preserves exact count annotations");
    assert.ok(_shades(paged.view(), width).every(row => row.shade === 100 - row.turns), "resizing keeps each sampled shade");
  }
  assert.equal(_selectedBar(paged.view()).turns, many.at(-1)!.turn_count, "resizing must preserve the selected frequency group");
  paged.tui.terminal.rows = 12;
  assert.ok(paged.view().render(100).length <= 12);
  paged.state.color = "32";
  const themed = paged.view().render(100).join("\n");
  assert.ok(themed.includes("\x1b[32m"));
  assert.ok(!themed.includes("\x1b[31m"), "theme changes must not reuse old ANSI colors");
  assert.ok(_shades(paged.view()).every(row => row.shade === 100 - row.turns), "theme updates preserve the sampled RGB palette");
  paged.view().invalidate();
  paged.view().handleInput!("\x1b");
  await pagination;
  assert.equal(paged.state.closed, 1);

  for (const entries of [[], [{ turn_count: 0, session_count: 7 }], [{ turn_count: 100000, session_count: 100000 }, { turn_count: 1, session_count: 1 }]] as Entry[][]) {
    const view = _ui();
    const result = showDatabaseSessionManagement(view.context, () => entries);
    for (const width of [20, 32, 80, 120]) {
      assert.ok(view.view().render(width).every(line => visibleWidth(line) <= width));
      assert.deepEqual(_bars(view.view(), width).map(row => [row.turns, row.sessions]), entries.map(entry => [entry.turn_count, entry.session_count]), "numeric labels and annotations remain exact at narrow widths");
    }
    if (!entries.length) assert.ok(_plain(view.view()).includes("No sessions are indexed."));
    if (entries.length === 1) {
      assert.ok(_bars(view.view())[0].cells > 0);
      assert.ok(_plain(view.view()).some(line => line.includes("Total sessions: 7 | Total turns: 0 | Groups: 1")));
    }
    if (entries.length === 2) assert.equal(_bars(view.view())[1].cells, 1, "small nonzero frequencies need one visible cell");
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
  assert.ok(_plain(menu.view()).some(line => line.includes("Total sessions: 7 | Total turns: 112 | Groups: 5")));
  assert.deepEqual(_bars(menu.view()).map(row => ({ turn_count: row.turns, session_count: row.sessions })), expected);
  assert.equal(_chartLines(menu.view()).length, 5, "seven sessions collapse to five turn-count groups");
  assert.ok(!_plain(menu.view()).join("\n").includes("pi:"), "the menu must never display individual session IDs");
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
  assert.deepEqual(getSessionTurnDistribution().map(row => ({ ...row })), [{ turn_count: 0, session_count: 7 }], "reopening groups all zero-turn sessions together");
  const empty = new DatabaseSync(path);
  empty.exec("DELETE FROM sessions");
  empty.close();
  assert.deepEqual(getSessionTurnDistribution(), [], "an existing empty index has no synthetic group");
  const broken = new DatabaseSync(path);
  broken.exec("DROP TABLE turns");
  broken.close();
  await assert.rejects(commands[0].handler("", menu.context), /no such table: turns/);
  assert.equal(menu.state.builds, 1, "invalid schemas fail without migration or reopening a stale view");
  console.log("database session management tests passed: read-only grouped frequencies, equal turn counts merged, exact session-count annotations, frequency-based bars, explicit metric headings, compact solid bars, aligned numbers, random grayscale RGB, stable colors across redraw and paging, fresh colors on reopen, zero-turn groups, no session IDs, weighted totals, pagination, resize, theme changes, menu routing, empty and error boundaries");
} finally {
  rmSync(home, { recursive: true, force: true });
}
