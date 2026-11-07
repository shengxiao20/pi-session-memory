import assert from "node:assert/strict";
import { requestContextTool } from "./helpers/request-context-tool.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

// Theme stub supplies distinct ANSI colors and rejects use of the wrong semantic role.
function resultTheme(foreground: string) {
  return { fg(role: string, text: string) {
    assert.equal(role, "toolOutput");
    return `${foreground}${text}\x1b[39m`;
  } };
}
const renderTheme = resultTheme("\x1b[38;2;238;238;238m");

const dbPath = join(tmpdir(), `pi-session-memory-e2e-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-memory-e2e-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
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
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, obsidianExportEnabled: true, obsidianVaultPath: obsidianVault }));

const extension = (await import("../extensions/index.ts")).default;
const events: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
const commands: Array<{ name: string; options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
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

assert.deepEqual(events.map(({ event }) => event), ["context", "message_end", "session_start", "agent_settled", "session_shutdown", "session_before_switch"]);
assert.equal(commands.length, 1);
assert.deepEqual(commands.map(({ name }) => name), ["pi-session-memory"]);
assert.equal(tools.length, 14);
const { SESSION_MEMORY_TOOL_NAMES } = await import("../src/history/memory-index-policy.ts");
assert.ok(tools.every(tool => (SESSION_MEMORY_TOOL_NAMES as readonly string[]).includes(tool.name)), "every registered package tool must be covered by SQLite turn exclusion");
assert.ok(!tools.some((tool) => tool.name === "recall_project_memory"), "the agent must have only one sequential recall entry point");
assert.ok(commands.every(({ options }) => options.description.length > 0), "every user command needs a description");
assert.ok(tools.every((tool) => tool.description.length > 0), "every agent tool needs a description");
for (const description of [...commands.map(({ options }) => options.description), ...tools.map((tool) => tool.description)]) {
  assert.doesNotMatch(description, /[\u4e00-\u9fff]/, "command and tool descriptions must be English only");
}

const notices: Array<{ message: string; level: string }> = [];
const selections: string[] = ["Setup — explain optional features and save approved configuration"];
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
assert.equal(notices.length, 0, "startup must not show a custom release notice or empty sync summary");
assert.ok(!existsSync(oldStatePath), "startup must not create custom release-note state");
writeFileSync(oldStatePath, "invalid legacy state");
await startup.handler({}, ctx);
assert.equal(notices.length, 0, "startup must ignore legacy custom release-note state");
assert.equal(readFileSync(oldStatePath, "utf8"), "invalid legacy state", "legacy state must remain untouched");
const menu = commands.find((command) => command.name === "pi-session-memory");
assert.ok(menu);
await menu.options.handler("", ctx);
assert.equal(notices.length, 0);
assert.equal(sentUserMessages.length, 1);
assert.match(sentUserMessages[0]!, /Run pi-session-memory setup/);
assert.deepEqual(menuOptions[0], [
  "Setup — explain optional features and save approved configuration",
  "Clean indexed tool turns — back up SQLite and remove complete package-tool turns",
  "Import historical sessions — rescan Pi history",
]);
assert.ok(menuOptions[0]!.every((option) => !/[\u4e00-\u9fff]/.test(option)), "menu descriptions must be English only");
assert.ok(menuOptions[0]!.every((option) => !/search|help|status|knowledge|consultation|conclusion/i.test(option)), "Agent-handled review actions must not appear in the direct-operation menu");
(await import("../src/history/db.ts")).getDb();
selections.push("Clean indexed tool turns — back up SQLite and remove complete package-tool turns");
await menu.options.handler("", ctx);
assert.match(notices.at(-1)!.message, /SQLite cleanup removed 0 package-tool turns/);
assert.match(notices.at(-1)!.message, /Backup:/);
selections.push("Import historical sessions — rescan Pi history");
await menu.options.handler("", ctx);
assert.match(notices.at(-1)!.message, /\[session-memory\] imported/);
notices.length = 0;
await assert.rejects(menu.options.handler("setup", ctx), /accepts no arguments/);
await assert.rejects(menu.options.handler("unexpected", ctx), /accepts no arguments/);
const setupConfigPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
const beforeSetup = readFileSync(setupConfigPath, "utf8");
const setupTool = tools.find(tool => tool.name === "setup_memory")!;
const startupJevPrototype = (await import("../src/relevance/jev-runtime.ts")).JevRuntime.prototype;
const originalStartupReadiness = startupJevPrototype.ensureReady;
let startupReadinessCalls = 0;
startupJevPrototype.ensureReady = async () => { startupReadinessCalls++; throw new Error("Unexpected startup with invalid configuration"); };
async function assertStartupConfigurationFailure(expected: RegExp) {
  const before = notices.length;
  await startup!.handler({}, ctx);
  assert.equal(notices.length, before + 1);
  const notice = notices.at(-1)!;
  assert.equal(notice.level, "error");
  assert.match(notice.message, /configuration failed/);
  assert.match(notice.message, expected);
  assert.match(notice.message, /Ask the agent to run setup_memory/);
  assert.doesNotMatch(notice.message, /history sync failed|jev startup failed/);
  assert.equal(startupReadinessCalls, 0, "invalid configuration must not start Jev or enable defaults");
}
try {
  rmSync(setupConfigPath);
  await assertStartupConfigurationFailure(/ENOENT/);
  assert.ok(!existsSync(setupConfigPath), "startup must not create configuration");
  writeFileSync(setupConfigPath, '{"recallLimit":0}');
  await assertStartupConfigurationFailure(/recallLimit/);
  assert.equal(readFileSync(setupConfigPath, "utf8"), '{"recallLimit":0}');
  writeFileSync(setupConfigPath, "invalid JSON");
  await assertStartupConfigurationFailure(/SyntaxError/);
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

assert.equal(tools.some((tool) => tool.name === "migrate_project_sessions"), false);

const stats = tools.find((tool) => tool.name === "get_memory_stats");
assert.ok(stats);
const result = await stats.execute();
assert.match(result.content[0]?.text ?? "", /0 turns across 0 sessions/);
assert.equal(result.content.length, 2, "non-recall tools also append the shared summary");
assert.match(result.content[1]!.text, /^Config · [^\n]+\nEnv · [^\n]+$/);

const recall = tools.find((tool) => tool.name === "recall_memory");
assert.ok(recall);
assert.match(recall.description, /automatically searches[\s\S]*globally, then uses those same entities/);
assert.match(recall.description, /no separate project recall call is needed/);
assert.match(recall.promptSnippet!, /Call once/);
assert.doesNotMatch(recall.promptSnippet!, /call both|current project only/);
const recallParameters = JSON.stringify(recall.parameters);
for (const forbiddenScope of ["cwd", "project", "sources", "sessionIds", "after", "before"]) {
  assert.doesNotMatch(recallParameters, new RegExp(`"${forbiddenScope}"`), `global recall must not expose ${forbiddenScope} scoping`);
}
const options = { entities: ["jev", "filter"], primary_entity: "jev", question: "Was jev filtering implemented?" };
assert.ok(recall.parameters.required.includes("primary_entity"));
assert.match(recall.promptSnippet!, /complete core phrase verbatim/);
await assert.rejects(recall.execute("missing-primary", { entities: options.entities, question: options.question } as any, undefined, () => {}), /primary_entity must be a non-empty string/);
await assert.rejects(recall.execute("missing-membership", { ...options, primary_entity: "filtering" }, undefined, () => {}), /primary_entity must be included in entities/);
const updates: any[] = [];
const recallResult = await recall.execute("call", options, undefined, (update: any) => updates.push(update));
const recallText = recallResult.content.map((block) => block.text).join("\n\n");
assert.equal(recallResult.content.length, 3, "global, project and the two-line configuration summary must be separate blocks");
assert.match(recallResult.content[2]!.text, /^Config · Jev=off \(nimble\) · Obsidian=on · manageOllama=on · limit=2\nEnv · MEMORY_DB_PATH=set · API key=local-placeholder · OLLAMA_HOST=/);
assert.equal(recallResult.content[2]!.text.split("\n").length, 2);
assert.ok(recallResult.content[0]!.text.startsWith("# Global recall"));
assert.ok(recallResult.content[1]!.text.startsWith("# Project recall"));
assert.doesNotMatch(recallText, /# Jev result|jevEnable is false|\*\*Model:\*\* nimble/, "disabled Jev must not add a visible summary");
assert.deepEqual(updates.map((update) => update.details.stage), ["global", "project"]);
assert.deepEqual(recallResult.details.global.results, []);
assert.deepEqual(recallResult.details.project.results, []);
assert.equal(recallResult.details.returnedResults, 0);
assert.ok(recall.renderResult);
const compact = recall.renderResult(recallResult, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(120).join("\n");
assert.match(compact, /Global recall · returned turns: 0[\s\S]*Project recall · new turns: 0/);
assert.match(compact, /Config · Jev=off/);
assert.match(compact, /Env · MEMORY_DB_PATH=set/);
for (const update of updates) {
  const rendered = recall.renderResult(update, { expanded: false, isPartial: true }, renderTheme, { isError: false }).render(120).join("\n");
  assert.match(rendered, /Global recall:[\s\S]*Project recall:/, "streamed progress must show both stages");
}
const errorText = "Recall failed\nFull failure detail";
const renderedError = recall.renderResult({ content: [{ type: "text", text: errorText }] }, { expanded: false, isPartial: false }, renderTheme, { isError: true }).render(120).join("\n");
assert.match(renderedError, /Recall failed[\s\S]*Full failure detail/, "compact rendering must not hide tool errors");
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
const fetchSchema = fetch.parameters as any;
assert.deepEqual(fetchSchema.required, ["turn_id", "before", "after"]);
assert.deepEqual(Object.keys(fetchSchema.properties), ["turn_id", "before", "after"]);
for (const name of ["before", "after"]) {
  assert.equal(fetchSchema.properties[name].type, "integer");
  assert.equal(fetchSchema.properties[name].minimum, 0);
}
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
  assert.match(fetched.content[0]!.text, /Target turn ID:[\s\S]*Storage action:\*\* none/);
  assert.match(fetched.content[1]!.text, /^Config · [^\n]+\nEnv · [^\n]+$/);
}
const windowFetch = await fetch.execute("window", { turn_id: "pi:project:shared", before: 10, after: 100 });
assert.deepEqual(windowFetch.details.fetchedTurnIds, ["pi:project:unique", "pi:project:shared"]);
await assert.rejects(() => fetch.execute("old", { session_id: "pi:project", from_turn_index: 20, to_turn_index: 20 }), /turn_id must be/);
await assert.rejects(() => fetch.execute("missing", { turn_id: "pi:project:shared", after: 0 }), /before must be/);
await assert.rejects(() => fetch.execute("unknown", { turn_id: "pi:missing:2599a0a9", before: 0, after: 0 }), /History turn not found/);
assert.deepEqual(db.getHistoryStats(), fetchStatsBefore);
assert.equal(readdirSync(obsidianVault).length, notesBeforeFetch, "fetch must not export or create evidence");
assert.doesNotMatch(nonEmpty.content[1]!.text, /pi:project:shared|pi:project:below-limit/, "project text must use only the same unique results as details, with no refill");
const expanded = recall.renderResult(nonEmpty, { expanded: true, isPartial: false }, renderTheme, { isError: false }).render(160).join("\n");
assert.match(expanded, /Global recall[\s\S]*pi:outside:global[\s\S]*Project recall[\s\S]*pi:project:unique/);
const nonEmptyText = nonEmpty.content.map((block) => block.text).join("\n\n");
const allNotes = readdirSync(obsidianVault).map((file) => readFileSync(join(obsidianVault, file), "utf8"));
assert.equal(allNotes.length, 0, "raw transcript evidence remains unsaved until finish_memory_recall");

db.getDb().prepare("DELETE FROM turns WHERE turn_id = ?").run("pi:outside:global");
const duplicateOnly = await recall.execute("duplicate-only", options, undefined, () => {});
assert.deepEqual(duplicateOnly.details.project.results, []);
assert.deepEqual(duplicateOnly.details.project.sessions, []);
assert.equal(duplicateOnly.details.project.duplicatesRemoved, 2);
assert.match(duplicateOnly.content[1]!.text, /No additional project turns returned/);
assert.doesNotMatch(duplicateOnly.content[1]!.text.split("Only after retrieving transcripts")[0], /No stored session CWD.*matches|pi:project:/, "fully duplicate results must not falsely claim directory discovery failed or re-emit turns");
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
writeFileSync(configPath, JSON.stringify({ ...JSON.parse(originalConfig), enableDiscussion: true, consultation: { knowledgePath: join(historyHome, "knowledge"), timeoutMs: 1000 } }));
let shown = 0;
const selectionCtx = { mode: "tui", sessionManager: { getSessionId() { return "main"; } }, ui: {
  async custom(build: any) {
    shown++;
    let result: any;
    const component = build({ terminal: { rows: 30 }, requestRender() {} }, {
      fg(_role: string, text: string) { return text; },
      bg(_role: string, text: string) { return text; },
    }, { matches(data: string, action: string) { return data === "cancel" && action === "tui.select.cancel"; } }, (value: any) => { result = value; });
    const lines = component.render(90).join("\n");
    assert.match(lines, /native candidate/);
    assert.match(lines, /\[x\]/);
    assert.match(lines, /User question:/);
    assert.match(lines, /Historical reply:/);
    component.handleInput("cancel"); component.dispose();
    return result;
  },
} };
const nativeBefore = readFileSync(native.getSessionFile()!, "utf8");
const exportBeforeSelection = readdirSync(obsidianVault).length;
const selectionResult = await recall.execute("selection", options, undefined, () => {}, selectionCtx);
assert.equal(shown, 1);
assert.equal(selectionResult.details.mode, "consultation");
assert.match(selectionResult.content.at(-1)!.text, /Discussion=on/);
assert.doesNotMatch(selectionResult.content.at(-1)!.text, /Jev=|Ollama/);
assert.equal(selectionResult.details.consultation.consultation_id, null);
assert.equal(selectionResult.details.global, undefined);
const cancelledDisplay = recall.renderResult!(selectionResult, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(120).join("\n");
assert.match(cancelledDisplay, /cancelled without fetch fallback/);
assert.doesNotMatch(cancelledDisplay, /consultation_id|"answers"|Private historical-session consultation/);
assert.doesNotMatch(selectionResult.content.map(block => block.text).join("\n"), /native evidence|Fetch turn ID|# Global recall/);
assert.equal(readFileSync(native.getSessionFile()!, "utf8"), nativeBefore, "cancelled selection must not open a writer or append a question");
assert.equal(readdirSync(obsidianVault).length, exportBeforeSelection);
const discussionText = selectionResult.content.map(block => block.text).join("\n");
assert.match(discussionText, /No consultation is active/);
assert.match(discussionText, /not a session-wide mode/);
assert.doesNotMatch(discussionText, /This is the consultation branch|Do not use fetch_session|Use only when consultation is disabled/);
const independentFetch = await fetch.execute("independent-fetch", { turn_id: `${nativeId}:candidate`, before: 0, after: 0 });
assert.equal(independentFetch.details.turnCount, 1, "Discussion configuration must not block explicit main-agent fetch calls after cancellation");
const independentAudit = await tools.find(tool => tool.name === "review_jev_filtered")!.execute("independent-audit", options, undefined, () => {});
assert.equal(independentAudit.details.jev.status, "disabled", "Discussion must not block main-agent audits");
await assert.rejects(() => recall.execute("headless", options, undefined, () => {}, { ...selectionCtx, mode: "json" }), /requires Pi TUI/);
const fetchAfterFailure = await fetch.execute("after-failure", { turn_id: `${nativeId}:candidate`, before: 0, after: 0 });
assert.equal(fetchAfterFailure.details.turnCount, 1, "failed consultation must not restrict main-agent tools");
const noCandidates = await recall.execute("no-candidates", {
  entities: ["missing-consultation-topic", "missing-history-topic"], primary_entity: "missing-consultation-topic",
  question: "What did we discuss about missing-consultation-topic?",
}, undefined, () => {}, selectionCtx);
assert.equal(noCandidates.details.consultation.consultation_id, null);
assert.match(noCandidates.content[0].text, /No consultation is active/);
assert.equal(shown, 1, "no eligible candidates must not open another checklist");
writeFileSync(configPath, originalConfig);
db.getDb().prepare("DELETE FROM turns WHERE session_id = ?").run(nativeId);
db.getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(nativeId);

// Dark/light/custom foregrounds must survive multiline rendering and narrow wrapping.
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
        const lines = recall.renderResult(result, { expanded, isPartial }, resultTheme(foreground), { isError }).render(width);
        assert.ok(lines.some((line) => stripVTControlCharacters(line).trim()));
        for (const line of lines.filter((line) => stripVTControlCharacters(line).trim())) {
          assert.ok(line.startsWith(foreground), "every visible line, including wrapped continuations, must use the active theme foreground");
        }
      }
    }
  }
}
assert.equal(JSON.stringify(renderCases), displaySnapshot, "rendering must not mutate model-visible results or structured evidence");
assert.doesNotMatch(nonEmptyText, /\x1b/, "theme ANSI codes must remain display-only, outside model text and exports");

writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 0, obsidianExportEnabled: true, obsidianVaultPath: obsidianVault }));
await assert.rejects(recall.execute("invalid-config", options, undefined, () => {}), /recallLimit/);
assert.equal(readdirSync(obsidianVault).length, 0, "failed workflows must not export raw or partial success notes");
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, jevEnable: true, obsidianExportEnabled: true, obsidianVaultPath: obsidianVault }));

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
  const filteredCompact = recall.renderResult(filtered, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(160).join("\n");
  assert.match(filteredCompact, /Global recall.*Jev: filtered[\s\S]*Project recall.*Jev: filtered/);

  runtimePrototype.ensureReady = async () => ({ state: "unavailable", reason: "test Jev unavailable" });
  const unavailable = await recall.execute("jev-unavailable", options, undefined, () => {});
  assert.equal(jevRequests.length, 2, "unavailable Jev must keep the existing literal recall behavior without making model calls");
  assert.equal(unavailable.details.global.jev.status, "unavailable");
  assert.equal(unavailable.details.project.jev.status, "unavailable");
  assert.equal(unavailable.details.project.duplicatesRemoved, 2);
  const unavailableCompact = recall.renderResult(unavailable, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(160).join("\n");
  assert.match(unavailableCompact, /Global recall.*Jev: unavailable[\s\S]*Project recall.*Jev: unavailable/, "the compact stage display must keep Jev unavailability visible");
  assert.ok(unavailable.content.slice(0, 2).every((block) => block.text.includes("test Jev unavailable")), "expanded content must retain each stage's existing Jev diagnostics");
assert.match(unavailable.content[2]!.text, /Config · Jev=on/, "configuration must not claim the enabled filter is disabled just because its runtime is unavailable");
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
    writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, jevEnable: true, model, jevConnection: { baseURL, apiKeyEnv: "PI_MEMORY_E2E_DECISION_KEY", contextWindow: 8_192, manageOllama: false }, obsidianExportEnabled: true, obsidianVaultPath: obsidianVault }));
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
    const text = remoteResult.content.slice(0, 2).map((block) => block.text).join("\n\n");
    assert.doesNotMatch(JSON.stringify(remoteResult), /isolated-e2e-secret|api\.typesafe\.ai|maas\.aliyuncs/);
    assert.match(remoteResult.content[2]!.text, /PI_MEMORY_E2E_DECISION_KEY=set/);
    assert.equal(readdirSync(obsidianVault).length, 0, "remote filtering must not add raw results before finalization");
  }
  const notesBeforeMissing = readdirSync(obsidianVault).length;
  const callsBeforeMissing = remoteCalls.length;
  delete process.env.PI_MEMORY_E2E_DECISION_KEY;
  await assert.rejects(freshRecall().execute("missing-key", options, undefined, () => {}), /environment variable PI_MEMORY_E2E_DECISION_KEY is missing or empty/);
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
assert.match(reviewFiltered.description, /global and entity-discovered project-session literal recall/);
assert.ok(reviewFiltered.parameters.required.includes("primary_entity"));
await assert.rejects(reviewFiltered.execute("audit-missing-primary", { entities: options.entities, question: options.question } as any, undefined, () => {}), /primary_entity must be a non-empty string/);
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
assert.doesNotMatch(JSON.stringify(reviewFiltered.parameters), /"cwd"|"sources"|"sessionIds"|"after"|"before"/, "Jev review must not expose extra scoping");

// Exercise finish tool + final-message replacement through actual extension handlers.
const finishRecall = tools.find(tool => tool.name === "finish_memory_recall")!;
const finalContext = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId() { return "main-output-run"; } } };
const settle = events.find(({ event }) => event === "agent_settled")!;
const messageEnd = events.find(({ event }) => event === "message_end")!;
const finalMessage = { role: "assistant", content: [{ type: "text", text: "Different summary" }], stopReason: "stop", timestamp: 1 };
const finalConclusion = { description: "Historical evidence findings and open questions", findings: "Historical evidence.[^transcript-1]", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };
const fetchTool = tools.find(tool => tool.name === "fetch_session")!;
for (const obsidianEnabled of [false, true]) {
  await settle.handler({}, finalContext);
  writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, obsidianExportEnabled: obsidianEnabled, ...(obsidianEnabled ? { obsidianVaultPath: obsidianVault } : {}) }));
  const defaultRoot = join(historyHome, ".pi", "agent", "pi-session-memory", "knowledge");
  const defaultMeetingsBefore = existsSync(join(defaultRoot, "meetings")) ? readdirSync(join(defaultRoot, "meetings")) : [];
  const sourceTurn = (await import("../src/recall/retriever.ts")).recallTurns({ entities: options.entities })[0]!;
  const fetched = await fetchTool.execute("final-source", { turn_id: sourceTurn.turn_id, before: 0, after: 0 });
  assert.match(fetched.content[0]!.text, /Storage action:\*\* none/);
  assert.equal((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message.stopReason, "error");
  const saved = await finishRecall.execute("finish-recall", { question: options.question, conclusion: finalConclusion }, undefined, undefined, finalContext);
  const root = obsidianEnabled ? obsidianVault : defaultRoot;
  assert.equal(saved.details.path, join(root, "meetings", saved.details.meeting_id, "minutes.md"));
  const finalResult = await messageEnd.handler({ message: finalMessage }, finalContext) as any;
  assert.equal(finalResult.message.content[0].text, readFileSync(saved.details.path, "utf8"));
  assert.equal(finalResult.message.content.length, 1, "final OKF must not include a separate summary or config footer");
  assert.equal(saved.content[0]!.text, saved.details.markdown);
  if (obsidianEnabled) assert.deepEqual(readdirSync(join(defaultRoot, "meetings")), defaultMeetingsBefore);
}
await settle.handler({}, finalContext);
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage);
await assert.rejects(finishRecall.execute("without-evidence", { question: options.question, conclusion: finalConclusion }, undefined, undefined, finalContext), /No recalled or fetched/);

// Reuse the saved vault document through the metadata-first route, with no new meeting.
const inspectKnowledge = tools.find(tool => tool.name === "inspect_memory_knowledge")!;
const readKnowledge = tools.find(tool => tool.name === "read_memory_knowledge")!;
const meetingsBeforeReuse = readdirSync(join(obsidianVault, "meetings"));
const catalogue = await inspectKnowledge.execute("metadata", {});
assert.equal(catalogue.details.meetings.length, meetingsBeforeReuse.length);
assert.ok(catalogue.details.meetings.every((entry: any) => typeof entry.frontmatter.description === "string" && entry.frontmatter.description.length));
assert.ok(catalogue.details.meetings.every((entry: any) => !("markdown" in entry)), "metadata-first inspection does not expose bodies");
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage, "metadata inspection does not require a new meeting");
const chosen = catalogue.details.meetings[0];
const reused = await readKnowledge.execute("reuse", { meeting_id: chosen.meeting_id });
assert.equal((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message.content[0].text, readFileSync(chosen.path, "utf8"));
assert.equal(reused.content[0]!.text, readFileSync(chosen.path, "utf8"));
assert.deepEqual(readdirSync(join(obsidianVault, "meetings")), meetingsBeforeReuse);
await settle.handler({}, finalContext);
assert.deepEqual((await messageEnd.handler({ message: finalMessage }, finalContext) as any).message, finalMessage);
for (const name of ["inspect_memory_knowledge", "read_memory_knowledge", "recall_memory", "fetch_session", "review_jev_filtered", "finish_memory_recall"]) {
  const tool = tools.find(tool => tool.name === name)!;
  assert.match(tool.description, /explicit/);
  assert.doesNotMatch(`${tool.description}\n${tool.promptSnippet}`, /Use for any question|For every prior-conversation/);
}
assert.match(recall.promptSnippet!, /after saved OKF descriptions show no clear match/);
(await import("../src/history/db.ts")).getDb().close();
cleanup();
console.log("e2e.test.ts: passed");
