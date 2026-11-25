import assert from "node:assert/strict";
import { knowledgeFields } from "./helpers/knowledge-fixture.ts";
import { requestContextTool } from "./helpers/request-context-tool.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { TObject } from "typebox";

function resultTheme(foreground: string) {
  return { fg(_role: string, text: string) {
    return `${foreground}${text}\x1b[39m`;
  } };
}
const renderTheme = resultTheme("\x1b[38;2;238;238;238m");

const dbPath = join(tmpdir(), `pi-session-memory-e2e-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-memory-e2e-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
// Admit the single-hit picker fixture; default-threshold behavior has dedicated consultation tests.
process.env.PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD = "0";
process.env.HOME = historyHome;
process.env.USERPROFILE = historyHome; // isolate Windows home too.

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  rmSync(historyHome, { recursive: true, force: true });
}
cleanup();
const obsidianVault = join(historyHome, "obsidian-vault");
mkdirSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true });
mkdirSync(obsidianVault, { recursive: true });
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, recallMode: "normal", knowledgePath: join(obsidianVault, "pi-session-memory") }));

const curatedRoot = join(historyHome, ".pi", "agent", "sessions", "curated");
const curatedPath = join(curatedRoot, "history.jsonl");
const curatedSessionId = "pi:curated";
const curatedTimestamp = "2026-06-06T12:00:00Z";
const curatedRecords = [
  { type: "session", version: 3, id: "curated", timestamp: curatedTimestamp, cwd: historyHome },
  { type: "message", id: "user", parentId: null, timestamp: curatedTimestamp, message: { role: "user", timestamp: 1, content: [{ type: "text", text: "Curated historical question" }] } },
  { type: "message", id: "reply", parentId: "user", timestamp: curatedTimestamp, message: { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "Curated historical answer" }] } },
];
mkdirSync(curatedRoot, { recursive: true });
writeFileSync(curatedPath, curatedRecords.map(record => JSON.stringify(record)).join("\n") + "\n");

const extension = (await import("../extensions/index.ts")).default;
const events: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
const commands: Array<{ name: string; options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters: TObject;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
  renderResult?: (...args: any[]) => { render(width: number): string[] };
}
const tools: RegisteredTool[] = [];
const sentUserMessages: string[] = [];

extension({
  sendUserMessage(message: string) { sentUserMessages.push(message); },
  on(event: string, handler: (...args: any[]) => unknown) { events.push({ event, handler }); },
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) { commands.push({ name, options }); },
  registerTool(tool: RegisteredTool) { tools.push(requestContextTool(tool, () => events.find(entry => entry.event === "context")!.handler)); },
} as any);


const notices: Array<{ message: string; level: string }> = [];
const selections: string[] = ["Agentic setup"];
const menuOptions: string[][] = [];
const ctx = { sessionManager: {
  getBranch() { return []; },
  getCwd() { return historyHome; },
}, ui: {
  notify(message: string, level: string) { notices.push({ message, level }); },
  async select(_title: string, options: string[]) { menuOptions.push(options); return selections.shift(); },
  async input() { return undefined; },
} };
const startup = events.find(({ event }) => event === "session_start");
assert.ok(startup);
const oldStatePath = join(historyHome, ".pi", "agent", "pi-session-memory", "whats-new.json");
await startup.handler({}, ctx);
assert.equal(notices.length, 0, "startup must not show a custom release notice or history import summary");
assert.ok(!existsSync(dbPath), "startup must not create a historical index even when source files exist");
assert.ok(!existsSync(oldStatePath), "startup must not create custom release-note state");
writeFileSync(oldStatePath, "invalid legacy state");
await startup.handler({}, ctx);
assert.equal(notices.length, 0, "startup must ignore legacy custom release-note state");
assert.ok(!existsSync(dbPath), "repeated startup must not import historical source files");
assert.equal(readFileSync(oldStatePath, "utf8"), "invalid legacy state", "legacy state must remain untouched");
const menu = commands.find((command) => command.name === "pi-session-memory");
assert.ok(menu);
await menu.options.handler("", ctx);
assert.equal(notices.length, 0);
assert.equal(sentUserMessages.length, 1);
const startupDb = await import("../src/history/db.ts");
async function inspectDatabaseMenu(distribution: readonly { turn_count: number; session_count: number }[]): Promise<void> {
  const beforeStats = startupDb.getHistoryStats();
  const beforeDb = readFileSync(dbPath);
  const beforeWal = existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`) : undefined;
  const beforeSource = startupDb.getSourceFile(curatedPath);
  const beforeHistory = readFileSync(curatedPath);
  const configPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
  const beforeConfig = readFileSync(configPath);
  const beforeMessages = sentUserMessages.length;
  const beforeNotices = notices.length;
  const jevPrototype = (await import("../src/relevance/jev-runtime.ts")).JevRuntime.prototype;
  const originalReadiness = jevPrototype.ensureReady;
  let readinessCalls = 0;
  let builds = 0;
  jevPrototype.ensureReady = async () => { readinessCalls++; throw new Error("Database viewing must not check Jev readiness"); };
  try {
    selections.push("Database session management");
    await menu!.options.handler("", { ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui,
      async custom(build: any) {
        builds++;
        let closed = false;
        const component = build({ terminal: { rows: 24 }, requestRender() {} }, {
          fg: (_role: string, text: string) => `\x1b[36m${text}\x1b[0m`,
        }, getKeybindings(), () => { closed = true; });
        const lines: string[] = component.render(100);
        const text: string = lines.map((line: string) => stripVTControlCharacters(line).trimEnd()).join("\n");
        component.handleInput("\x1b[B");
        assert.doesNotMatch(text, /sessionId|pi:/, "the chart must not display individual sessions");
        const chartRows = text.split("\n").filter(line => /^(?:→ |  )\s*\d+ /.test(line));
        assert.deepEqual(chartRows.map(line => {
          const match = line.match(/^.{2}(\d+)\s+(█+) (\d+)$/)!;
          return { turn_count: Number(match[1]), session_count: Number(match[3]) };
        }), distribution, "equal turn counts share one bar with the exact session frequency beside it");
        component.handleInput("\x1b");
        assert.ok(closed, "Esc must close the view without selecting an operation");
      },
    } });
  } finally { jevPrototype.ensureReady = originalReadiness; }
  assert.equal(builds, 1);
  assert.equal(readinessCalls, 0);
  assert.deepEqual(startupDb.getHistoryStats(), beforeStats);
  assert.deepEqual(readFileSync(dbPath), beforeDb, "viewing must not write database pages");
  if (beforeWal) assert.deepEqual(readFileSync(`${dbPath}-wal`), beforeWal, "viewing must not write WAL records");
  assert.deepEqual(startupDb.getSourceFile(curatedPath), beforeSource, "viewing must not change source tracking");
  assert.deepEqual(readFileSync(curatedPath), beforeHistory);
  assert.deepEqual(readFileSync(configPath), beforeConfig);
  assert.equal(sentUserMessages.length, beforeMessages, "viewing must not start an Agent request or import confirmation");
  assert.equal(notices.length, beforeNotices, "viewing must not produce import or service notices");
}
startupDb.getDb();
assert.equal(startupDb.getHistoryStats().sessions, 0, "startup must leave newly discovered history unindexed");
assert.equal(startupDb.getSourceFile(curatedPath), undefined);
const configureTool = tools.find(tool => tool.name === "configure_memory")!;
const setupConfiguration = JSON.parse(readFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), "utf8"));
const historyBeforeConfigurationSave = startupDb.getHistoryStats();
const postSetupSave = await configureTool.execute("approved-setup-save", { configuration: setupConfiguration });
assert.deepEqual(postSetupSave.details.configuration, setupConfiguration);
assert.deepEqual(startupDb.getHistoryStats(), historyBeforeConfigurationSave, "saving setup and offering import must not import existing history");
assert.equal(startupDb.getSourceFile(curatedPath), undefined, "setup save leaves source tracking unchanged while awaiting import approval");
assert.equal(sentUserMessages.length, 1, "saving configuration does not request import automatically");
await inspectDatabaseMenu([]);
selections.push("Clean indexed tool turns");
await menu.options.handler("", ctx);
selections.push("Import history");
await menu.options.handler("", ctx);
assert.equal(startupDb.getSession(curatedSessionId).turns[0].reply_text, "Curated historical answer", "manual Import must still index historical files");
await inspectDatabaseMenu([{ turn_count: 1, session_count: 1 }]);
const distributionSeed = startupDb.getSession(curatedSessionId);
const distributionFixtures = [["pi:frequency-a", 1], ["pi:frequency-b", 1], ["pi:frequency-two", 2], ["pi:frequency-zero", 0]] as const;
try {
  for (const [sessionId, turnCount] of distributionFixtures) {
    startupDb.upsertSession({ ...distributionSeed.session, session_id: sessionId, jsonl_path: join(curatedRoot, `${sessionId.slice(3)}.jsonl`) });
    for (let index = 0; index < turnCount; index++) startupDb.upsertTurn({ ...distributionSeed.turns[0], session_id: sessionId, turn_id: `${sessionId}:turn:${index}`, turn_index: index });
  }
  await inspectDatabaseMenu([{ turn_count: 2, session_count: 1 }, { turn_count: 1, session_count: 3 }, { turn_count: 0, session_count: 1 }]);
  const beforeDeletionDb = readFileSync(dbPath);
  const beforeDeletionWal = existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`) : undefined;
  const beforeDeletionTracking = startupDb.getSourceFile(curatedPath);
  const beforeDeletionHistory = readFileSync(curatedPath);
  const deletionConfigPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
  const beforeDeletionConfig = readFileSync(deletionConfigPath);
  const beforeDeletionMessages = sentUserMessages.length;
  const beforeDeletionNotices = notices.length;
  const deletionContext = (answer: string | undefined) => ({ ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui,
    async input() { return answer; },
    async confirm() { throw new Error("Deletion must use the requested input-only flow"); },
  } });
  for (const answer of [undefined, "-1"]) {
    selections.push("Delete sessions by turn count");
    if (answer === undefined) await menu.options.handler("", deletionContext(answer));
    else await assert.rejects(menu.options.handler("", deletionContext(answer)));
    assert.deepEqual(readFileSync(dbPath), beforeDeletionDb);
    if (beforeDeletionWal) assert.deepEqual(readFileSync(`${dbPath}-wal`), beforeDeletionWal);
    assert.equal(notices.length, beforeDeletionNotices, "cancelled or invalid input must not report deletion");
  }
  selections.push("Delete sessions by turn count");
  await menu.options.handler("", deletionContext("1"));
  const deletionBackupPath = notices.at(-1)!.message.match(/\nBackup: (.+)\n/)![1];
  const deletionBackup = new DatabaseSync(deletionBackupPath, { readOnly: true });
  try {
    assert.equal(deletionBackup.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 5);
    assert.equal(deletionBackup.prepare("SELECT count(*) AS n FROM turns").get()!.n, 5, "the deletion backup contains all pre-deletion sessions and turns");
    assert.equal(deletionBackup.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { deletionBackup.close(); rmSync(deletionBackupPath); }
  assert.deepEqual(startupDb.getSessionTurnDistribution().map(row => ({ ...row })), [{ turn_count: 2, session_count: 1 }], "equal-to-limit and zero-turn sessions are deleted together");
  assert.deepEqual(startupDb.getDb().prepare("PRAGMA foreign_key_check").all(), [], "associated turns must be deleted before sessions");
  assert.deepEqual(startupDb.getSourceFile(curatedPath), beforeDeletionTracking);
  assert.deepEqual(readFileSync(curatedPath), beforeDeletionHistory);
  assert.deepEqual(readFileSync(deletionConfigPath), beforeDeletionConfig);
  assert.equal(sentUserMessages.length, beforeDeletionMessages, "deletion must not start an Agent, import or setup request");
  await inspectDatabaseMenu([{ turn_count: 2, session_count: 1 }]);
} finally {
  for (const [sessionId] of distributionFixtures) {
    startupDb.getDb().prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
    startupDb.getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }
}
function deleteCuratedSession(): void {
  startupDb.getDb().prepare("DELETE FROM turns WHERE session_id = ?").run(curatedSessionId);
  startupDb.getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(curatedSessionId);
}
deleteCuratedSession();
curatedRecords[2].message!.content[0].text = "Changed historical answer after manual database deletion";
writeFileSync(curatedPath, curatedRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
startupDb.getDb().prepare("UPDATE source_files SET parser_version = ? WHERE jsonl_path = ?").run("old-parser", curatedPath);
const curatedSourceBeforeStartup = startupDb.getSourceFile(curatedPath);
const noticesBeforeCuratedStartup = notices.length;
await startup.handler({}, ctx);
await startup.handler({}, ctx);
assert.equal(notices.length, noticesBeforeCuratedStartup, "startup must not report history import activity");
await inspectDatabaseMenu([]);
assert.equal(startupDb.getHistoryStats().sessions, 0, "startup must not restore deleted sessions even when source content and parser versions differ");
assert.deepEqual(startupDb.getSourceFile(curatedPath), curatedSourceBeforeStartup, "startup must not update source tracking");
selections.push("Import history");
await menu.options.handler("", ctx);
assert.equal(startupDb.getSession(curatedSessionId).turns[0].reply_text, curatedRecords[2].message!.content[0].text, "explicit Import must restore the changed historical session");
deleteCuratedSession();
const explicitBackfill = tools.find(tool => tool.name === "backfill_memory")!;
const explicitImportResult = await explicitBackfill.execute("explicit-import", {});
assert.equal(explicitImportResult.details.pi, 1);
assert.equal(explicitImportResult.details.turns, 1);
assert.equal(startupDb.getSession(curatedSessionId).turns[0].reply_text, curatedRecords[2].message!.content[0].text, "backfill_memory must still explicitly restore deleted sessions");
deleteCuratedSession();
startupDb.getDb().prepare("DELETE FROM source_files WHERE jsonl_path = ?").run(curatedPath);
rmSync(curatedRoot, { recursive: true });
notices.length = 0;
await assert.rejects(menu.options.handler("setup", ctx));
await assert.rejects(menu.options.handler("unexpected", ctx));
const setupConfigPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
const beforeSetup = readFileSync(setupConfigPath, "utf8");
const setupTool = tools.find(tool => tool.name === "setup_memory")!;
const startupJevPrototype = (await import("../src/relevance/jev-runtime.ts")).JevRuntime.prototype;
const originalStartupReadiness = startupJevPrototype.ensureReady;
let startupReadinessCalls = 0;
startupJevPrototype.ensureReady = async () => { startupReadinessCalls++; throw new Error("Unexpected startup with invalid configuration"); };
async function assertStartupConfigurationFailure() {
  const before = notices.length;
  await startup!.handler({}, ctx);
  assert.equal(notices.length, before + 1);
  const notice = notices.at(-1)!;
  assert.equal(notice.level, "error");
  assert.equal(startupReadinessCalls, 0, "invalid configuration must not start Jev or enable defaults");
}
try {
  rmSync(setupConfigPath);
  await assertStartupConfigurationFailure();
  assert.ok(!existsSync(setupConfigPath), "startup must not create configuration");
  writeFileSync(setupConfigPath, '{"recallLimit":0}');
  await assertStartupConfigurationFailure();
  assert.equal(readFileSync(setupConfigPath, "utf8"), '{"recallLimit":0}');
  writeFileSync(setupConfigPath, "invalid JSON");
  await assertStartupConfigurationFailure();
  assert.equal(readFileSync(setupConfigPath, "utf8"), "invalid JSON");
} finally {
  startupJevPrototype.ensureReady = originalStartupReadiness;
  writeFileSync(setupConfigPath, beforeSetup);
}
rmSync(setupConfigPath);
const missingSetup = await setupTool.execute("setup-missing", {});
assert.equal(missingSetup.details.configuration, null);
assert.equal(missingSetup.content.length, 1, "setup does not require runtime configuration summaries");
assert.ok(!existsSync(setupConfigPath), "read guide does not create a configuration");
writeFileSync(setupConfigPath, '{"recallLimit":0}');
const invalidSetup = await setupTool.execute("setup-invalid", {});
assert.equal(invalidSetup.details.configuration.recallLimit, 0, "setup can read semantically invalid configuration for explicit repair");
writeFileSync(setupConfigPath, beforeSetup);


const stats = tools.find((tool) => tool.name === "get_memory_stats");
assert.ok(stats);
const result = await stats.execute();
assert.equal(result.details.turns, 0);
assert.equal(result.details.sessions, 0);

const recall = tools.find((tool) => tool.name === "recall_memory");
assert.ok(recall);
const options = { entities: ["jev", "filter"], primary_entity: "jev", question: "Was jev filtering implemented?" };
await assert.rejects(recall.execute("missing-primary", { entities: options.entities, question: options.question } as any, undefined, () => {}));
await assert.rejects(recall.execute("missing-membership", { ...options, primary_entity: "filtering" }, undefined, () => {}));
const updates: any[] = [];
const recallResult = await recall.execute("call", options, undefined, (update: any) => updates.push(update));
assert.equal(recallResult.content.length, 3, "global, project and the two-line configuration summary must be separate blocks");
assert.deepEqual(updates.map((update) => update.details.stage), ["global", "project"]);
assert.deepEqual(recallResult.details.global.results, []);
assert.deepEqual(recallResult.details.project.results, []);
assert.equal(recallResult.details.returnedResults, 0);
const errorText = "Recall failed\nFull failure detail";
const renderedError = recall.renderResult!({ content: [{ type: "text", text: errorText }] }, { expanded: false, isPartial: false }, renderTheme, { isError: true }).render(120).join("\n");
assert.match(renderedError, /Full failure detail/, "compact rendering must not hide tool errors");
const exportedNotes = readdirSync(obsidianVault);
assert.equal(exportedNotes.length, 0, "agent recall must not export raw results before the final OKF conclusion");

const db = await import("../src/history/db.ts");
for (const [session_id, source, cwd] of [
  ["pi:project", "pi", "/work/jev"],
  ["pi:outside", "pi", "/work/outside"],
] as const) {
  db.upsertSession({ session_id, source, cwd, started_at: 1, model_id: null, jsonl_path: join(historyHome, `${source}.jsonl`) });
}
for (const [session_id, id, ts, text] of [
  ["pi:outside", "global", 30, "jev filter outside the project"],
  ["pi:project", "shared", 20, "jev filter shared result"],
  ["pi:project", "unique", 10, "jev filter additional result"],
  ["pi:project", "below-limit", 5, "jev filter excluded by original limit"],
] as const) {
  db.insertTurn({ turn_id: `${session_id}:${id}`, session_id, turn_index: ts, ts, user_text: text, reply_text: "original assistant text", tool_names: null, user_message_id: id });
}
const nonEmpty = await recall.execute("non-empty", options, undefined, () => {});
assert.deepEqual(nonEmpty.details.global.results.map((turn: any) => turn.turn_id), ["pi:outside:global", "pi:project:shared"]);
assert.deepEqual(nonEmpty.details.project.results.map((turn: any) => turn.turn_id), ["pi:project:unique"]);
assert.equal(nonEmpty.details.project.duplicatesRemoved, 1);
assert.equal(nonEmpty.details.project.jev.retained, 2, "pre-deduplication Jev statistics must remain unchanged");
assert.equal(nonEmpty.details.returnedResults, 3);
assert.match(nonEmpty.content[1]!.text, /pi:project:unique/);
const fetch = tools.find((tool) => tool.name === "fetch_session");
assert.ok(fetch);
const fetchStatsBefore = db.getHistoryStats();
const notesBeforeFetch = readdirSync(obsidianVault).length;
for (const turn of [...nonEmpty.details.global.results, ...nonEmpty.details.project.results]) {
  const text = nonEmpty.content.slice(0, 2).map((block) => block.text).join("\n");
  assert.ok(text.includes(`**Fetch turn ID:** \`${turn.turn_id}\``));
  const fetched = await fetch.execute("fetch", { turn_id: turn.turn_id, before: 0, after: 0 });
  assert.deepEqual(fetched.details.fetchedTurnIds, [turn.turn_id]);
  assert.equal(fetched.details.target_turn_index, turn.turn_index);
  assert.equal(fetched.details.session_id, turn.session_id);
  assert.equal(fetched.content.length, 2);
}
const windowFetch = await fetch.execute("window", { turn_id: "pi:project:shared", before: 10, after: 100 });
assert.deepEqual(windowFetch.details.fetchedTurnIds, ["pi:project:unique", "pi:project:shared"]);
await assert.rejects(() => fetch.execute("old", { session_id: "pi:project", from_turn_index: 20, to_turn_index: 20 }));
await assert.rejects(() => fetch.execute("missing", { turn_id: "pi:project:shared", after: 0 }));
await assert.rejects(() => fetch.execute("unknown", { turn_id: "pi:missing:2599a0a9", before: 0, after: 0 }));
assert.deepEqual(db.getHistoryStats(), fetchStatsBefore);
assert.equal(readdirSync(obsidianVault).length, notesBeforeFetch, "fetch must not export or create evidence");
assert.doesNotMatch(nonEmpty.content[1]!.text, /pi:project:shared|pi:project:below-limit/, "project text must use only the same unique results as details, with no refill");
const expanded = recall.renderResult!(nonEmpty, { expanded: true, isPartial: false }, renderTheme, { isError: false }).render(160).join("\n");
assert.match(expanded, /pi:outside:global[\s\S]*pi:project:unique/);
const nonEmptyText = nonEmpty.content.map((block) => block.text).join("\n\n");
const allNotes = readdirSync(obsidianVault).map((file) => readFileSync(join(obsidianVault, file), "utf8"));
assert.equal(allNotes.length, 0, "raw transcript evidence remains unsaved until finish_memory_recall");

db.getDb().prepare("DELETE FROM turns WHERE turn_id = ?").run("pi:outside:global");
const duplicateOnly = await recall.execute("duplicate-only", options, undefined, () => {});
assert.deepEqual(duplicateOnly.details.project.results, []);
assert.deepEqual(duplicateOnly.details.project.sessions, []);
assert.equal(duplicateOnly.details.project.duplicatesRemoved, 2);
assert.doesNotMatch(duplicateOnly.content[1]!.text, /pi:project:/, "fully duplicate results must not re-emit turns");
assert.equal(readdirSync(obsidianVault).length, 0);

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const native = SessionManager.create(join(historyHome, "native-project"), join(historyHome, "native-sessions"));
const nativeUserId = native.appendMessage({ role: "user", content: "jev filter native candidate", timestamp: 40 });
native.appendMessage({ role: "assistant", content: [{ type: "text", text: "native evidence" }], api: "test", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 41 });
const nativeId = `pi:${native.getSessionId()}`;
db.upsertSession({ session_id: nativeId, source: "pi", cwd: native.getCwd(), started_at: 40, model_id: null, jsonl_path: native.getSessionFile()! });
db.insertTurn({ turn_id: `${nativeId}:candidate`, session_id: nativeId, turn_index: 0, ts: 40, user_text: "jev filter native candidate", reply_text: "native evidence", tool_names: null, user_message_id: nativeUserId });
const configPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
const originalConfig = readFileSync(configPath, "utf8");
writeFileSync(configPath, JSON.stringify({ ...JSON.parse(originalConfig), recallMode: "discussion", knowledgePath: join(historyHome, "knowledge"), consultation: { timeoutMs: 1000 } }));
let shown = 0;
const selectionCtx = { mode: "tui", sessionManager: { getSessionId() { return "main"; } }, ui: {
  async custom(build: any) {
    shown++;
    let result: any;
    const component = build({ terminal: { rows: 30 }, requestRender() {} }, {
      fg(_role: string, text: string) { return text; },
      bg(_role: string, text: string) { return text; },
    }, { matches(data: string, action: string) { return data === "cancel" && action === "tui.select.cancel"; } }, (value: any) => { result = value; });
    component.render(90);
    component.handleInput("cancel"); component.dispose();
    return result;
  },
} };
const nativeBefore = readFileSync(native.getSessionFile()!, "utf8");
const exportBeforeSelection = readdirSync(obsidianVault).length;
const selectionResult = await recall.execute("selection", options, undefined, () => {}, selectionCtx);
assert.equal(shown, 1);
assert.equal(selectionResult.details.mode, "consultation");
assert.equal(selectionResult.details.consultation.status, "cancelled");
assert.equal(selectionResult.details.consultation.consultation_id, null);
assert.equal(selectionResult.details.fallbackReason, undefined, "participant cancellation does not return Normal evidence");
assert.equal(selectionResult.details.global, undefined);
const cancelledDisplay = recall.renderResult!(selectionResult, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(120).join("\n");
assert.doesNotMatch(cancelledDisplay, /consultation_id|"answers"/);
assert.doesNotMatch(selectionResult.content.map(block => block.text).join("\n"), /native evidence/);
assert.equal(readFileSync(native.getSessionFile()!, "utf8"), nativeBefore, "cancelled selection must not open a writer or append a question");
assert.equal(readdirSync(obsidianVault).length, exportBeforeSelection);
const independentFetch = await fetch.execute("independent-fetch", { turn_id: `${nativeId}:candidate`, before: 0, after: 0 });
assert.equal(independentFetch.details.turnCount, 1, "Discussion configuration must not block explicit main-agent fetch calls after cancellation");
const independentAudit = await tools.find(tool => tool.name === "review_jev_filtered")!.execute("independent-audit", options, undefined, () => {});
assert.equal(independentAudit.details.jev.status, "disabled", "Discussion must not block main-agent audits");
await assert.rejects(() => recall.execute("headless", options, undefined, () => {}, { ...selectionCtx, mode: "json" }));
const fetchAfterFailure = await fetch.execute("after-failure", { turn_id: `${nativeId}:candidate`, before: 0, after: 0 });
assert.equal(fetchAfterFailure.details.turnCount, 1, "failed consultation must not restrict main-agent tools");
const noCandidates = await recall.execute("no-candidates", {
  entities: ["missing-consultation-topic", "missing-history-topic"], primary_entity: "missing-consultation-topic",
  question: "What did we discuss about missing-consultation-topic?",
}, undefined, () => {}, selectionCtx);
assert.equal(noCandidates.details.mode, "transcript");
assert.equal(noCandidates.details.recallMode, "normal");
assert.equal(noCandidates.details.configuredMode, "discussion");
assert.equal(noCandidates.details.returnedResults, 0);
assert.equal(noCandidates.details.consultation, undefined);
assert.equal(shown, 1, "no eligible candidates must not open another checklist");
assert.equal(readFileSync(native.getSessionFile()!, "utf8"), nativeBefore);
assert.equal(JSON.parse(readFileSync(configPath, "utf8")).recallMode, "discussion");
writeFileSync(configPath, originalConfig);
db.getDb().prepare("DELETE FROM turns WHERE session_id = ?").run(nativeId);
db.getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(nativeId);

// Rendering must preserve the result and evidence.
const renderCases = [
  { result: nonEmpty, isPartial: false, isError: false },
  { result: recallResult, isPartial: false, isError: false },
  { result: duplicateOnly, isPartial: false, isError: false },
  ...updates.map((result) => ({ result, isPartial: true, isError: false })),
  { result: { content: [{ type: "text", text: errorText }] }, isPartial: false, isError: true },
];
const displaySnapshot = JSON.stringify(renderCases);
for (const foreground of ["\x1b[38;2;238;238;238m", "\x1b[38;2;32;32;32m", "\x1b[38;2;120;200;255m"]) {
  for (const { result, isPartial, isError } of renderCases) {
    for (const expanded of [false, true]) {
      for (const width of [30, 160]) {
        recall.renderResult!(result, { expanded, isPartial }, resultTheme(foreground), { isError }).render(width);
      }
    }
  }
}
assert.equal(JSON.stringify(renderCases), displaySnapshot, "rendering must not mutate model-visible results or structured evidence");
assert.doesNotMatch(nonEmptyText, /\x1b/, "theme ANSI codes must remain display-only, outside model text and exports");

writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 0, knowledgePath: join(obsidianVault, "pi-session-memory") }));
await assert.rejects(recall.execute("invalid-config", options, undefined, () => {}));
assert.equal(readdirSync(obsidianVault).length, 0, "failed workflows must not export raw or partial success notes");
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, recallMode: "normal", jevEnable: true, knowledgePath: join(obsidianVault, "pi-session-memory") }));

// Mock only the runtime boundary: execute the unchanged Jev filter inside both tool stages.
const { JevRuntime } = await import("../src/relevance/jev-runtime.ts");
const runtimePrototype = JevRuntime.prototype;
const originalRuntime = {
  ensureReady: runtimePrototype.ensureReady,
  selectedModel: runtimePrototype.selectedModel,
  contextWindow: runtimePrototype.contextWindow,
  client: runtimePrototype.client,
};
const jevRequests: any[] = [];
try {
  runtimePrototype.ensureReady = async () => ({ state: "ready" });
  runtimePrototype.selectedModel = () => "nimble";
  runtimePrototype.contextWindow = () => 8_192;
  runtimePrototype.client = (() => ({
    async systemOne(request: any) {
      jevRequests.push(request);
      return { answers: Object.fromEntries(Object.entries(request.questions).map(([key, value]: [string, any]) => [
        key, { noul: jevRequests.length === 1 && value.instructions.includes("shared result") ? 0.1 : 0.9 },
      ])) };
    },
  })) as any;
  const filteredUpdates: any[] = [];
  const filtered = await recall.execute("jev-enabled", options, undefined, (update: any) => filteredUpdates.push(update));
  assert.equal(jevRequests.length, 2, "the unchanged Jev filter must run once per stage for these small candidates");
  assert.ok(jevRequests.every((request) => request.state.userQuestion === options.question));
  assert.deepEqual(filtered.details.global.results.map((turn: any) => turn.turn_id), ["pi:project:unique"]);
  assert.deepEqual(filtered.details.project.results.map((turn: any) => turn.turn_id), ["pi:project:shared"], "project must retain a global Jev rejection while removing the global final retained turn");
  assert.equal(filtered.details.project.duplicatesRemoved, 1);
  assert.equal(filtered.details.global.jev.filtered, 1);
  assert.equal(filtered.details.project.jev.retained, 2);
  assert.deepEqual(filteredUpdates.map((update) => update.details.stage), ["global", "global", "global", "project", "project", "project"]);
  assert.doesNotMatch(filtered.content[1]!.text, /pi:project:unique/);

  const filterConfig = readFileSync(configPath, "utf8");
  const fallbackConfig = JSON.stringify({ ...JSON.parse(filterConfig), recallMode: "discussion", consultation: { timeoutMs: 1000 } });
  writeFileSync(configPath, fallbackConfig);
  process.env.PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD = "2";
  jevRequests.length = 0;
  const fallbackUpdates: any[] = [];
  const filteredFallback = await recall.execute("jev-discussion-fallback", options, undefined, (update: any) => fallbackUpdates.push(update), selectionCtx);
  assert.equal(filteredFallback.details.mode, "transcript");
  assert.equal(filteredFallback.details.recallMode, "normal");
  assert.equal(filteredFallback.details.configuredMode, "discussion");
  assert.equal(jevRequests.length, 2, "fallback must not rerun the two-stage Jev review");
  assert.deepEqual(filteredFallback.details.global, filtered.details.global);
  assert.deepEqual(filteredFallback.details.project, filtered.details.project);
  assert.deepEqual(filteredFallback.content.slice(0, 2), filtered.content.slice(0, 2), "Normal fallback reuses the final filtered evidence sections");
  assert.deepEqual(fallbackUpdates.map(update => update.details.stage), filteredUpdates.map(update => update.details.stage));
  assert.equal(shown, 1, "filtered unique turns at the threshold do not open participants");
  assert.equal(readFileSync(configPath, "utf8"), fallbackConfig);
  writeFileSync(configPath, filterConfig);
  process.env.PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD = "0";

  runtimePrototype.ensureReady = async () => ({ state: "unavailable", reason: "test Jev unavailable" });
  const unavailable = await recall.execute("jev-unavailable", options, undefined, () => {});
  assert.equal(jevRequests.length, 2, "unavailable Jev must keep the existing literal recall behavior without making model calls");
  assert.equal(unavailable.details.global.jev.status, "unavailable");
  assert.equal(unavailable.details.project.jev.status, "unavailable");
  assert.equal(unavailable.details.project.duplicatesRemoved, 2);
  assert.ok(unavailable.content.slice(0, 2).every((block) => block.text.includes("test Jev unavailable")), "expanded content must retain each stage's existing Jev diagnostics");
  assert.equal(readdirSync(obsidianVault).length, 0);
} finally {
  Object.assign(runtimePrototype, originalRuntime);
}

// Exercise real runtime + SDK + filter + sequential workflow for remote connections.
const originalFetch = globalThis.fetch;
const previousKey = process.env.PI_MEMORY_E2E_DECISION_KEY;
const { OllamaService } = await import("../src/relevance/ollama-service.ts");
const originalEnsureModel = OllamaService.prototype.ensureModel;
const remoteCalls: Array<{ url: string; body: any; authorization: string | null }> = [];
function freshRecall(): RegisteredTool {
  const registrations: RegisteredTool[] = [];
  const handlers = new Map<string, any>();
  extension({ on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {}, registerTool(tool: RegisteredTool) { registrations.push(requestContextTool(tool, () => handlers.get("context"))); } } as any);
  return registrations.find((tool) => tool.name === "recall_memory")!;
}
try {
  process.env.PI_MEMORY_E2E_DECISION_KEY = "isolated-e2e-secret";
  OllamaService.prototype.ensureModel = async () => { throw new Error("Remote connection must not manage local Ollama"); };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.endsWith("/v1/systemone"), "no remote /api/show or /api/tags probes are permitted");
    const body = JSON.parse(String(init?.body));
    remoteCalls.push({ url, body, authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.9 }])) }), { headers: { "Content-Type": "application/json" } });
  };
  for (const [baseURL, model] of [["https://api.typesafe.ai", "jev-latest"], ["https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode", "decision-model-preview"]]) {
    writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, recallMode: "normal", jevEnable: true, model, jevConnection: { baseURL, apiKeyEnv: "PI_MEMORY_E2E_DECISION_KEY", contextWindow: 8_192, manageOllama: false }, knowledgePath: join(obsidianVault, "pi-session-memory") }));
    const beforeCalls = remoteCalls.length;
    const remoteResult = await freshRecall().execute("remote", options, undefined, () => {});
    assert.equal(remoteCalls.length - beforeCalls, 2, "both recall stages use the same remote System One client");
    assert.ok(remoteCalls.slice(beforeCalls).every((call) => call.url === `${baseURL}/v1/systemone` && call.body.model === model && call.body.state.userQuestion === options.question && call.authorization === "Bearer isolated-e2e-secret"));
    assert.equal(remoteResult.details.global.jev.status, "filtered");
    assert.equal(remoteResult.details.project.jev.status, "filtered");
    assert.equal(remoteResult.details.global.jev.model, model);
    assert.equal(remoteResult.details.global.jev.contextWindow, 8_192);
    assert.equal(remoteResult.details.project.duplicatesRemoved, 2);
    assert.deepEqual(remoteResult.details.project.results, []);
    assert.doesNotMatch(JSON.stringify(remoteResult), /isolated-e2e-secret|api\.typesafe\.ai|maas\.aliyuncs/);
    assert.equal(readdirSync(obsidianVault).length, 0, "remote filtering must not add raw results before finalization");
  }
  const notesBeforeMissing = readdirSync(obsidianVault).length;
  const callsBeforeMissing = remoteCalls.length;
  delete process.env.PI_MEMORY_E2E_DECISION_KEY;
  await assert.rejects(freshRecall().execute("missing-key", options, undefined, () => {}));
  assert.equal(remoteCalls.length, callsBeforeMissing);
  assert.equal(readdirSync(obsidianVault).length, notesBeforeMissing, "missing credentials must not export a partial/fallback result");

  process.env.PI_MEMORY_E2E_DECISION_KEY = "isolated-e2e-secret";
  let failedRequests = 0;
  globalThis.fetch = async () => { failedRequests++; return new Response(JSON.stringify({ error: { message: "test unauthorized" } }), { status: 401, headers: { "Content-Type": "application/json" } }); };
  const failedRemote = await freshRecall().execute("remote-401", options, undefined, () => {});
  assert.equal(failedRequests, 1, "existing unavailable state prevents repeated requests or backend switching in the project stage");
  assert.equal(failedRemote.details.global.jev.status, "unavailable");
  assert.equal(failedRemote.details.project.jev.status, "unavailable");
  assert.equal(failedRemote.details.returnedResults, 2, "existing literal-recall fallback remains unchanged for request failures");
} finally {
  globalThis.fetch = originalFetch;
  OllamaService.prototype.ensureModel = originalEnsureModel;
  if (previousKey === undefined) delete process.env.PI_MEMORY_E2E_DECISION_KEY;
  else process.env.PI_MEMORY_E2E_DECISION_KEY = previousKey;
}

const reviewFiltered = tools.find((tool) => tool.name === "review_jev_filtered");
assert.ok(reviewFiltered);
assert.ok(reviewFiltered.parameters.required.includes("primary_entity"));
await assert.rejects(reviewFiltered.execute("audit-missing-primary", { entities: options.entities, question: options.question } as any, undefined, () => {}));
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, jevEnable: true }));
try {
  Object.assign(runtimePrototype, {
    ensureReady: async () => ({ state: "ready" }), selectedModel: () => "nimble", contextWindow: () => 8192,
    client: () => ({ async systemOne(request: any) {
      assert.equal(request.state.userQuestion, options.question);
      return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { noul: 0.1 }])) };
    } }),
  });
  const audit = await reviewFiltered.execute("audit-primary", options, undefined, () => {});
  assert.ok(audit.details.results.length > 0);
  assert.ok(audit.details.results.every((entry: any) => entry.turn.score === 12), "audit must reuse primary bonus scoring before Jev review");
} finally {
  Object.assign(runtimePrototype, originalRuntime);
}

// Exercise finish tool + final-message replacement through actual extension handlers.
const finishRecall = tools.find(tool => tool.name === "finish_memory_recall")!;
const finalContext = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId() { return "main-output-run"; } } };
const settle = events.find(({ event }) => event === "agent_settled")!;
const messageEnd = events.find(({ event }) => event === "message_end")!;
const finalMessage = { role: "assistant", content: [{ type: "text", text: "Different summary" }], stopReason: "stop", timestamp: 1 };
const finalConclusion = { ...knowledgeFields, description: "Historical evidence findings and open questions", findings: "Historical evidence.[^transcript-1]", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };
const fetchTool = tools.find(tool => tool.name === "fetch_session")!;
for (const customRootEnabled of [false, true]) {
  await settle.handler({}, finalContext);
  writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, ...(customRootEnabled ? { knowledgePath: join(obsidianVault, "pi-session-memory") } : {}) }));
  const defaultRoot = join(historyHome, ".pi", "agent", "pi-session-memory", "knowledge");
  const defaultMeetingsBefore = existsSync(join(defaultRoot, "meetings")) ? readdirSync(join(defaultRoot, "meetings")) : [];
  const sourceTurn = (await import("../src/recall/retriever.ts")).recallTurns({ entities: options.entities })[0]!;
  await fetchTool.execute("final-source", { turn_id: sourceTurn.turn_id, before: 0, after: 0 });
  assert.equal((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message.stopReason, "error");
  const saved = await finishRecall.execute("finish-recall", { question: options.question, conclusion: finalConclusion }, undefined, undefined, finalContext);
  const root = customRootEnabled ? join(obsidianVault, "pi-session-memory") : defaultRoot;
  assert.equal(saved.details.path, join(root, "meetings", finalConclusion.topic_path, saved.details.meeting_id, "minutes.md"));
  assert.equal(saved.details.concept_id, `meetings/${finalConclusion.topic_path}/${saved.details.meeting_id}/minutes`);
  const finalResult = await messageEnd.handler({ message: finalMessage }, finalContext) as any;
  assert.equal(finalResult.message.content[0].text, readFileSync(saved.details.path, "utf8"));
  assert.equal(finalResult.message.content.length, 1, "final OKF must not include a separate summary or config footer");
  assert.equal(saved.content[0]!.text, saved.details.markdown);
  if (customRootEnabled) assert.deepEqual(readdirSync(join(defaultRoot, "meetings")), defaultMeetingsBefore);
}
await settle.handler({}, finalContext);
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage);
await assert.rejects(finishRecall.execute("without-evidence", { question: options.question, conclusion: finalConclusion }, undefined, undefined, finalContext));

// Current-context writing is independent of recall mode, Jev and TUI selection.
const writeOkf = tools.find(tool => tool.name === "write_okf")!;
const contextConclusion = { ...finalConclusion, description: "Independent current-context writing with shared publication", findings: "Use the shared OKF writer.[^context-1]" };
const contextParams = { question: "Save current context as OKF without historical retrieval", context: "The current task requires an independent writer and one publication pipeline.", conclusion: contextConclusion };
const configFile = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
const historyBeforeContext = db.getHistoryStats();
try {
  runtimePrototype.ensureReady = async () => { throw new Error("write_okf must not initialize Jev"); };
  for (const customRootEnabled of [false, true]) {
    await settle.handler({}, finalContext);
    writeFileSync(configFile, JSON.stringify({ recallLimit: 2, recallMode: "discussion", consultation: { timeoutMs: 1000 }, jevEnable: true, ...(customRootEnabled ? { knowledgePath: join(obsidianVault, "pi-session-memory") } : {}) }));
    const configBeforeContext = readFileSync(configFile, "utf8");
    const noTuiContext = { ...finalContext, mode: "json", ui: { custom() { throw new Error("write_okf must not open a selection menu"); } } };
    const savedContext = await writeOkf.execute("write-current-context", contextParams, undefined, undefined, noTuiContext);
    const root = customRootEnabled ? join(obsidianVault, "pi-session-memory") : join(historyHome, ".pi", "agent", "pi-session-memory", "knowledge");
    assert.equal(savedContext.details.path, join(root, "meetings", contextConclusion.topic_path, savedContext.details.meeting_id, "minutes.md"));
    assert.equal(savedContext.content[0]!.text, readFileSync(savedContext.details.path, "utf8"));
    const currentFinal = await messageEnd.handler({ message: finalMessage }, noTuiContext) as any;
    assert.equal(currentFinal.message.content[0].text, savedContext.details.markdown);
    assert.equal(currentFinal.message.content.length, 1);
    assert.equal(currentFinal.message.stopReason, "stop");
    assert.match(savedContext.details.markdown, /id: context-1/);
    assert.doesNotMatch(savedContext.details.markdown, /id: transcript-|id: consultation-|verified:/);
    assert.equal(readFileSync(configFile, "utf8"), configBeforeContext, "writing does not change configuration");
    await assert.rejects(writeOkf.execute("write-invalid-context", { ...contextParams, context: " " }, undefined, undefined, noTuiContext));
    assert.equal((await messageEnd.handler({ message: finalMessage }, noTuiContext) as any).message.stopReason, "error", "failed writing cannot emit a stale saved document");
  }
} finally { Object.assign(runtimePrototype, originalRuntime); }
assert.deepEqual(db.getHistoryStats(), historyBeforeContext, "write_okf does not change indexed transcript storage");
await settle.handler({}, finalContext);
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage);

// Reuse the saved vault document through the metadata-first route, with no new meeting.
const inspectKnowledge = tools.find(tool => tool.name === "inspect_memory_knowledge")!;
const readKnowledge = tools.find(tool => tool.name === "read_memory_knowledge")!;
const vaultMeetings = join(obsidianVault, "pi-session-memory", "meetings", finalConclusion.topic_path);
const meetingsBeforeReuse = readdirSync(vaultMeetings).filter(name => name !== "index.md");
const rootCatalogue = await inspectKnowledge.execute("metadata-root", {});
assert.equal(rootCatalogue.details.meetings.length, 0);
assert.deepEqual(rootCatalogue.details.directories.map((entry: any) => entry.directory), ["meetings"]);
const catalogue = await inspectKnowledge.execute("metadata", { directory: `meetings/${finalConclusion.topic_path}` });
assert.equal(catalogue.details.meetings.length, meetingsBeforeReuse.length);
assert.ok(catalogue.details.meetings.every((entry: any) => typeof entry.frontmatter.description === "string" && entry.frontmatter.description.length));
assert.ok(catalogue.details.meetings.every((entry: any) => !("markdown" in entry)), "metadata-first inspection does not expose bodies");
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage, "metadata inspection does not require a new meeting");
const chosen = catalogue.details.meetings[0];
const reused = await readKnowledge.execute("reuse", { meeting_id: chosen.meeting_id });
assert.equal((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message.content[0].text, readFileSync(chosen.path, "utf8"));
assert.equal(reused.content[0]!.text, readFileSync(chosen.path, "utf8"));
assert.deepEqual(readdirSync(vaultMeetings).filter(name => name !== "index.md"), meetingsBeforeReuse);
await settle.handler({}, finalContext);
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage);
(await import("../src/history/db.ts")).getDb().close();
cleanup();
console.log("e2e.test.ts: passed");
