import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

extension({
  on(event: string, handler: (...args: any[]) => unknown) { events.push({ event, handler }); },
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) { commands.push({ name, options }); },
  registerTool(tool: RegisteredTool) { tools.push(tool); },
} as any);

assert.deepEqual(events.map(({ event }) => event), ["session_start", "agent_settled", "session_shutdown"]);
assert.equal(commands.length, 1);
assert.deepEqual(commands.map(({ name }) => name), ["pi-session-memory"]);
assert.equal(tools.length, 6);
assert.ok(!tools.some((tool) => tool.name === "recall_project_memory"), "the agent must have only one sequential recall entry point");
assert.ok(commands.every(({ options }) => options.description.length > 0), "every user command needs a description");
assert.ok(tools.every((tool) => tool.description.length > 0), "every agent tool needs a description");

const notices: Array<{ message: string; level: string }> = [];
const selections: string[] = ["Help — explain history search, indexing, and migration", `What's new — pi-session-memory v${(await import("../package.json", { with: { type: "json" } })).default.version}`];
const ctx = { ui: {
  notify(message: string, level: string) { notices.push({ message, level }); },
  async select(_title: string, _options: string[]) { return selections.shift(); },
  async input() { return undefined; },
} };
const menu = commands.find((command) => command.name === "pi-session-memory");
assert.ok(menu);
await menu.options.handler("", ctx);
assert.match(notices[0]?.message ?? "", /pi-session-memory/);
await menu.options.handler("", ctx);
assert.match(notices[1]?.message ?? "", /What's New in pi-session-memory v0\.7\.23/);
assert.match(notices[1]?.message ?? "", /two-line configuration snapshot/);
assert.match(notices[1]?.message ?? "", /MEMORY_DB_PATH/);

const migration = tools.find((tool) => tool.name === "migrate_project_sessions");
assert.ok(migration);
assert.match(migration.description, /Claude Code and Codex/);
assert.equal(tools.filter((tool) => /^migrate_(claude|codex)_project_sessions$/.test(tool.name)).length, 0);

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
assert.match(recall.promptSnippet!, /call recall_memory once/);
assert.doesNotMatch(recall.promptSnippet!, /call both|current project only/);
const recallParameters = JSON.stringify(recall.parameters);
for (const forbiddenScope of ["cwd", "project", "sources", "sessionIds", "after", "before"]) {
  assert.doesNotMatch(recallParameters, new RegExp(`"${forbiddenScope}"`), `global recall must not expose ${forbiddenScope} scoping`);
}
const options = { entities: ["jev", "filter"], question: "Was jev filtering implemented?" };
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
assert.equal(exportedNotes.length, 1, "a combined recall must export exactly one complete note, including empty searches");
assert.ok(readFileSync(join(obsidianVault, exportedNotes[0]!), "utf8").includes(recallResult.content.slice(0, 2).map((block) => block.text).join("\n\n")));
assert.ok(!readFileSync(join(obsidianVault, exportedNotes[0]!), "utf8").includes("Config · "), "operational configuration is not exported as transcript evidence");

const db = await import("../src/db.ts");
for (const [session_id, source, cwd] of [
  ["claude:project", "claude", "/work/jev"],
  ["codex:outside", "codex", "/work/outside"],
] as const) {
  db.upsertSession({ session_id, source, cwd, started_at: 1, model_id: null, jsonl_path: join(historyHome, `${source}.jsonl`) });
}
for (const [session_id, id, ts, text] of [
  ["codex:outside", "global", 30, "jev filter outside the project"],
  ["claude:project", "shared", 20, "jev filter shared result"],
  ["claude:project", "unique", 10, "jev filter additional result"],
  ["claude:project", "below-limit", 5, "jev filter excluded by original limit"],
] as const) {
  db.insertTurn({ turn_id: `${session_id}:${id}`, session_id, turn_index: ts, ts, user_text: text, reply_text: "original assistant text", tool_names: null, user_message_id: id });
}
const nonEmpty = await recall.execute("non-empty", options, undefined, () => {});
assert.deepEqual(nonEmpty.details.global.results.map((turn: any) => turn.turn_id), ["codex:outside:global", "claude:project:shared"]);
assert.deepEqual(nonEmpty.details.project.results.map((turn: any) => turn.turn_id), ["claude:project:unique"]);
assert.equal(nonEmpty.details.project.duplicatesRemoved, 1);
assert.equal(nonEmpty.details.project.jev.retained, 2, "pre-deduplication Jev statistics must remain unchanged");
assert.equal(nonEmpty.details.returnedResults, 3);
assert.match(nonEmpty.content[1]!.text, /claude:project:unique/);
assert.doesNotMatch(nonEmpty.content[1]!.text, /claude:project:shared|claude:project:below-limit/, "project text must use only the same unique results as details, with no refill");
const expanded = recall.renderResult(nonEmpty, { expanded: true, isPartial: false }, renderTheme, { isError: false }).render(160).join("\n");
assert.match(expanded, /Global recall[\s\S]*codex:outside:global[\s\S]*Project recall[\s\S]*claude:project:unique/);
const nonEmptyText = nonEmpty.content.map((block) => block.text).join("\n\n");
const allNotes = readdirSync(obsidianVault).map((file) => readFileSync(join(obsidianVault, file), "utf8"));
assert.equal(allNotes.length, 2);
assert.ok(allNotes.some((note) => note.includes(nonEmpty.content.slice(0, 2).map((block) => block.text).join("\n\n"))), "the single exported note must exactly include both final result sections, without the operational summary");

db.getDb().prepare("DELETE FROM turns WHERE turn_id = ?").run("codex:outside:global");
const duplicateOnly = await recall.execute("duplicate-only", options, undefined, () => {});
assert.deepEqual(duplicateOnly.details.project.results, []);
assert.deepEqual(duplicateOnly.details.project.sessions, []);
assert.equal(duplicateOnly.details.project.duplicatesRemoved, 2);
assert.match(duplicateOnly.content[1]!.text, /No additional project turns returned/);
assert.doesNotMatch(duplicateOnly.content[1]!.text, /No stored session CWD.*matches|claude:project:/, "fully duplicate results must not falsely claim directory discovery failed or re-emit turns");
assert.equal(readdirSync(obsidianVault).length, 3);

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
assert.equal(readdirSync(obsidianVault).length, 3, "failed workflows must not export a partial success note");
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2, jevEnable: true, obsidianExportEnabled: true, obsidianVaultPath: obsidianVault }));
selections.push("Search project history — discover a named project by session directory name");
await menu.options.handler("", { ui: { ...ctx.ui, async input() { return "jev | filter"; } } });
const manualText = notices.at(-1)!.message;
assert.match(manualText, /# Project recall results[\s\S]*claude:project:shared[\s\S]*claude:project:unique/);
assert.doesNotMatch(manualText, /# Global recall|# Jev result|duplicates removed/, "manual project menu search must remain an independent literal search without Jev or deduplication");
assert.equal(readdirSync(obsidianVault).length, 4);

// Mock only the runtime boundary: execute the unchanged Jev filter inside both tool stages.
const { JevRuntime } = await import("../src/jev-runtime.ts");
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
  assert.deepEqual(filtered.details.global.results.map((turn: any) => turn.turn_id), ["claude:project:unique"]);
  assert.deepEqual(filtered.details.project.results.map((turn: any) => turn.turn_id), ["claude:project:shared"], "project must retain a global Jev rejection while removing the global final retained turn");
  assert.equal(filtered.details.project.duplicatesRemoved, 1);
  assert.equal(filtered.details.global.jev.filtered, 1);
  assert.equal(filtered.details.project.jev.retained, 2);
  assert.deepEqual(filteredUpdates.map((update) => update.details.stage), ["global", "global", "global", "project", "project", "project"]);
  assert.doesNotMatch(filtered.content[1]!.text, /claude:project:unique/);
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
  assert.equal(readdirSync(obsidianVault).length, 6);
} finally {
  Object.assign(runtimePrototype, originalRuntime);
}

// Exercise real runtime + SDK + filter + sequential workflow for remote connections.
const originalFetch = globalThis.fetch;
const previousKey = process.env.PI_MEMORY_E2E_DECISION_KEY;
const { OllamaService } = await import("../src/ollama-service.ts");
const originalEnsureModel = OllamaService.prototype.ensureModel;
const remoteCalls: Array<{ url: string; body: any; authorization: string | null }> = [];
function freshRecall(): RegisteredTool {
  const registrations: RegisteredTool[] = [];
  extension({ on() {}, registerCommand() {}, registerTool(tool: RegisteredTool) { registrations.push(tool); } } as any);
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
    assert.ok(readdirSync(obsidianVault).some((file) => readFileSync(join(obsidianVault, file), "utf8").includes(text)), "export includes the same complete two-stage remote evidence without the config snapshot");
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
assert.doesNotMatch(JSON.stringify(reviewFiltered.parameters), /"cwd"|"sources"|"sessionIds"|"after"|"before"/, "Jev review must not expose extra scoping");

(await import("../src/db.ts")).getDb().close();
cleanup();
console.log("e2e.test.ts: passed");
