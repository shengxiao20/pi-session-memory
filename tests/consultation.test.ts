import assert from "node:assert/strict";
import { requestContextTool } from "./helpers/request-context-tool.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-consultation-"));
process.env.HOME = root; process.env.USERPROFILE = root;
process.env.MEMORY_DB_PATH = join(root, "memory.db");
const configDirectory = join(root, ".pi", "agent", "pi-session-memory");
mkdirSync(configDirectory, { recursive: true });
const configPath = join(configDirectory, "config.json");
const knowledgePath = join(root, "knowledge");
function configure(consultation?: unknown) { writeFileSync(configPath, JSON.stringify({ recallLimit: 20, ...(consultation === undefined ? {} : { enableDiscussion: true, consultation }) })); }
const enabled = { knowledgePath, timeoutMs: 2000 };
configure();
const { getEnabledConsultation, getSessionMemoryConfig } = await import("../src/config.ts");
assert.equal(getEnabledConsultation(), undefined);
configure(enabled);
assert.deepEqual(getEnabledConsultation(), enabled);
writeFileSync(configPath, JSON.stringify({ recallLimit: 20, consultation: enabled }));
assert.equal(getEnabledConsultation(), undefined);
writeFileSync(configPath, JSON.stringify({ recallLimit: 20, enableDiscussion: false, consultation: enabled }));
assert.equal(getEnabledConsultation(), undefined);
for (const value of ["true", 1, null]) {
  writeFileSync(configPath, JSON.stringify({ recallLimit: 20, enableDiscussion: value, consultation: enabled }));
  assert.throws(() => getSessionMemoryConfig(), /Invalid/);
}
writeFileSync(configPath, JSON.stringify({ recallLimit: 20, enableDiscussion: true }));
assert.throws(() => getSessionMemoryConfig(), /Invalid/);
for (const value of [{ ...enabled, enableEnv: "TEST_CONSULTATION" }, { ...enabled, knowledgePath: "relative" }, { ...enabled, timeoutMs: 0 }]) {
  configure(value); assert.throws(() => getSessionMemoryConfig(), /Invalid/);
}
configure(enabled);
const { SessionManager, ModelRuntime, ModelRegistry, createAgentSession, createExtensionRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const aiPath = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const { createAssistantMessageEventStream } = await import(aiPath);
const { upsertSession, upsertTurn } = await import("../src/db.ts");
const { ConsultationRuntime, selectConsultationSessions } = await import("../src/consultation-runtime.ts");
const { createHistoricalAgent } = await import("../src/consultation-agent.ts");
const model: any = { id: "test", name: "Test", provider: "consult-test", api: "openai-completions", baseUrl: "http://unused", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
const managers: any[] = [];
const turns: any[] = [];
for (let index = 0; index < 4; index++) {
  const manager = SessionManager.create(root, join(root, "sessions"));
  const userId = manager.appendMessage({ role: "user", content: `historical-${index}`, timestamp: Date.now() });
  manager.appendMessage(assistant(`old answer ${index}`));
  managers.push(manager);
  const sessionId = `pi:${manager.getSessionId()}`;
  upsertSession({ session_id: sessionId, source: "pi", cwd: root, started_at: index, model_id: "test", jsonl_path: manager.getSessionFile()! });
  const turn = { turn_id: `${sessionId}:${userId}`, session_id: sessionId, turn_index: 0, ts: index, user_text: `historical-${index}`, reply_text: `old answer ${index}`, tool_names: null, user_message_id: userId };
  upsertTurn(turn);
  turns.push({ ...turn, source: "pi", cwd: root, score: index + 1 });
}
const main = SessionManager.create(root, join(root, "main"));
const probePath = join(root, "main-tool-probe.txt");
writeFileSync(probePath, "main tools remain usable");
const calls: any[] = [];
const provider: any = {
  id: model.provider, name: "Test", auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
  getModels: () => [model],
  streamSimple(_model: any, context: any) {
    calls.push(context);
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    const message = last?.role === "user" && JSON.stringify(last.content).includes("main tool probe")
      ? { ...assistant(""), content: [{ type: "toolCall", id: `probe-${calls.length}`, name: "read", arguments: { path: probePath } }], stopReason: "toolUse" as const }
      : assistant(`private answer ${calls.length}`);
    queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
    return stream;
  },
  stream(...args: any[]) { return this.streamSimple(...args); },
};
const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false }); modelRuntime.registerNativeProvider(provider);
const ctx: any = { model, modelRegistry: new ModelRegistry(modelRuntime), sessionManager: main, thinkingLevel: "off" };
assert.deepEqual(selectConsultationSessions([...turns, turns[3], { ...turns[0], source: "claude" }], turns[2].session_id).map(group => group[0].session_id), [turns[3].session_id, turns[1].session_id, turns[0].session_id]);

// Real SDK restoration in memory, with an in-process deterministic provider. No remote request.
const originalBytes = readFileSync(managers[0].getSessionFile(), "utf8");
const realAgent = await createHistoricalAgent([turns[0]], ctx);
const answer = await realAgent.ask("private test");
assert.equal(answer.answer, "private answer 1");
assert.ok(answer.messageIds.length >= 2);
assert.ok(calls[0].messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("historical-0")));
assert.equal(calls[0].tools?.length ?? 0, 0);
assert.match(calls[0].systemPrompt, /historical session consultant/);
assert.equal(readFileSync(managers[0].getSessionFile(), "utf8"), originalBytes, "consultation must not append to the original session");
await realAgent.abort(); realAgent.dispose();
const branchManager = managers[1];
const oldUserId = turns[1].user_message_id;
branchManager.branch(oldUserId);
const activeUserId = branchManager.appendMessage({ role: "user", content: "active-branch-evidence", timestamp: Date.now() });
branchManager.appendMessage(assistant("active branch reply"));
branchManager.appendCompaction("retained-compaction-evidence", activeUserId, 100);
const branchAgent = await createHistoricalAgent([turns[1]], ctx);
await branchAgent.ask("Check restored branch");
const restored = JSON.stringify(calls[1].messages);
assert.match(restored, /active-branch-evidence/);
assert.match(restored, /retained-compaction-evidence/);
assert.doesNotMatch(restored, /old answer 1/);
await branchAgent.abort(); branchAgent.dispose();
// Legacy-format migration happens only in memory. Malformed JSON must throw without changing source bytes.
const legacyBytes = originalBytes.replace('"version":3', '"version":2');
assert.notEqual(legacyBytes, originalBytes);
writeFileSync(managers[0].getSessionFile(), legacyBytes);
const legacyAgent = await createHistoricalAgent([turns[0]], ctx);
await legacyAgent.ask("Check legacy history without rewriting it");
assert.equal(readFileSync(managers[0].getSessionFile(), "utf8"), legacyBytes);
await legacyAgent.abort(); legacyAgent.dispose();
const malformedBytes = `${legacyBytes}{malformed\n`;
writeFileSync(managers[0].getSessionFile(), malformedBytes);
await assert.rejects(() => createHistoricalAgent([turns[0]], ctx), SyntaxError);
assert.equal(readFileSync(managers[0].getSessionFile(), "utf8"), malformedBytes);
writeFileSync(managers[0].getSessionFile(), originalBytes);
await assert.rejects(() => createHistoricalAgent([turns[0]], { ...ctx, model: undefined }), /selected main model/);
await assert.rejects(() => createHistoricalAgent([turns[0]], { ...ctx, sessionManager: managers[0] }), /active main session/);

const asked: Array<{ session: string; question: string }> = [];
let active = 0; let peak = 0; let disposed = 0;
const factory: any = async (group: any[]) => ({
  async ask(question: string, signal?: AbortSignal) {
    active++; peak = Math.max(peak, active);
    try { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 2)); signal?.throwIfAborted();
      asked.push({ session: group[0].session_id, question });
      return { sessionId: group[0].session_id, question, answer: `answer-${group[0].session_id}`, messageIds: ["native-answer"] };
    } finally { active--; }
  }, async abort() {}, dispose() { disposed++; },
});
const { selectConsultationParticipants } = await import("../src/consultation-selection.ts");
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = await import("@earendil-works/pi-tui");
const candidates = selectConsultationSessions(turns, main.getSessionId());
const simulateSelection = (inputs: string[]) => ({ ...ctx, mode: "tui", ui: {
  async custom(build: any) {
    let result: any;
    const backgrounds: string[] = [];
    const component = build({ terminal: { rows: 30 }, requestRender() {} }, {
      fg(_role: string, text: string) { return text; },
      bg(role: string, text: string) { backgrounds.push(role); return `\u001b[48;5;24m${text}\u001b[49m`; },
    }, new KeybindingsManager(TUI_KEYBINDINGS), (value: any) => { result = value; });
    const lines = component.render(65);
    assert.equal((lines.join("\n").match(/\[x\]/g) ?? []).length, candidates.length);
    assert.match(lines.join("\n"), /Matched turn/);
    assert.match(lines.join("\n"), /User question:/);
    assert.match(lines.join("\n"), /Historical reply:/);
    assert.ok(backgrounds.includes("searchMatchBg"));
    assert.ok(backgrounds.includes("userMessageBg"));
    assert.ok(backgrounds.includes("customMessageBg"));
    assert.ok(lines.every((line: string) => visibleWidth(line) <= 65));
    for (const input of inputs) { component.handleInput(input); component.render(65); }
    component.dispose();
    return result;
  },
} } as any);
assert.deepEqual(await selectConsultationParticipants(candidates, simulateSelection([" ", "\u001b[B", " ", "\r"])), candidates.slice(2));
assert.deepEqual(await selectConsultationParticipants(candidates, simulateSelection(["\r"])), candidates);
assert.deepEqual(await selectConsultationParticipants(candidates, simulateSelection([" ", "\u001b[B", " ", "\u001b[B", " ", "\r"])), []);
assert.deepEqual(await selectConsultationParticipants(candidates, simulateSelection(["\u001b"])), []);
await assert.rejects(() => selectConsultationParticipants(candidates, { ...ctx, mode: "json" } as any), /requires Pi TUI/);
let selectionFactoryCalls = 0;
const rejectedRuntime = new ConsultationRuntime(async (...args) => { selectionFactoryCalls++; return factory(...args); });
const rejectedSelection = await rejectedRuntime.start(turns, "reject all", simulateSelection([" ", "\u001b[B", " ", "\u001b[B", " ", "\r"]));
assert.equal(rejectedSelection.consultation_id, null);
assert.equal(selectionFactoryCalls, 0);
const acceptedRuntime = new ConsultationRuntime(factory);
const acceptedSelection = await acceptedRuntime.start(turns, "select one", simulateSelection([" ", "\u001b[B", " ", "\r"]));
assert.equal(acceptedSelection.answers.length, 1);
await acceptedRuntime.cancel(acceptedSelection.consultation_id!, ctx);
asked.length = 0; disposed = 0;

const approveAll = async (groups: any[][]) => groups;
const runtime = new ConsultationRuntime(factory, approveAll);
const first = await runtime.start(turns, "current question", ctx);
assert.equal(first.answers.length, 3); assert.equal(peak, 1);
assert.ok(first.answers.every(answer => answer.question === "current question"), "return only the user question, not prompts containing raw indexed evidence");
assert.equal(asked.length, 3);
assert.ok(asked.every(call => !call.question.includes("answer-pi:")), "consultants must not see other answers");
await assert.rejects(() => runtime.start(turns, "duplicate", ctx), /Finish or cancel/);
await assert.rejects(() => runtime.followUp(first.consultation_id!, turns[0].session_id, "not selected", ctx), /not a participant/);
await assert.rejects(() => runtime.followUp(first.consultation_id!, turns[3].session_id, "wrong owner", { ...ctx, sessionManager: managers[0] }), /another main session/);
await runtime.followUp(first.consultation_id!, turns[3].session_id, "clarify privately", ctx);
assert.equal(asked.length, 4); assert.equal(asked[3].session, turns[3].session_id);
const conclusion = { description: "Consultation findings and remaining actions", findings: "Supported fact.[^consultation-1]", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };
const minutes = await runtime.finish(first.consultation_id!, conclusion, ctx);
assert.equal(minutes.status, "draft"); assert.equal(disposed, 3);
const saved = readFileSync(minutes.path, "utf8");
assert.match(saved, /^---\ndescription: "Consultation findings and remaining actions"\n---/); assert.doesNotMatch(saved, /meeting_status:|type:|generated:/); assert.doesNotMatch(saved, /verified:/);
assert.match(saved, /\[\^consultation-1\]/);
assert.doesNotMatch(readFileSync(join(knowledgePath, "index.md"), "utf8"), /---|okf_version/);
assert.match(readFileSync(join(knowledgePath, "log.md"), "utf8"), /## \d{4}-\d{2}-\d{2}/);
assert.match(saved, /\(evidence-1\.md\)/);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
await assert.rejects(() => runtime.followUp(first.consultation_id!, turns[3].session_id, "closed", ctx), /Unknown/);
const failure = new ConsultationRuntime(async () => { throw new Error("explicit failure"); }, approveAll);
await assert.rejects(() => failure.start(turns, "fail", ctx), /explicit failure/);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
const controller = new AbortController(); controller.abort();
await assert.rejects(() => runtime.start(turns, "cancelled", ctx, controller.signal));
const noCandidates = await runtime.start(turns.filter(turn => turn.source !== "pi"), "no candidates", ctx);
assert.equal(noCandidates.consultation_id, null);
const selectionAborted = new AbortController();
let componentBuilt!: () => void;
const built = new Promise<void>(resolve => { componentBuilt = resolve; });
const abortedContext = { ...ctx, mode: "tui", ui: { custom(build: any) {
  return new Promise(resolve => {
    const component = build({ terminal: { rows: 30 }, requestRender() {} }, { fg(_role: string, text: string) { return text; } }, {}, (value: any) => { component.dispose(); resolve(value); });
    componentBuilt();
  });
} } } as any;
const selectionPending = selectConsultationParticipants(candidates, abortedContext, selectionAborted.signal);
await built; selectionAborted.abort(new Error("selection aborted"));
await assert.rejects(() => selectionPending, /selection aborted/);
configure({ ...enabled, timeoutMs: 1 });
const reviewedRuntime = new ConsultationRuntime(factory, async groups => { await new Promise(resolve => setTimeout(resolve, 10)); return []; });
assert.equal((await reviewedRuntime.start(turns, "review without timeout", ctx)).consultation_id, null);
configure(enabled);
const next = await runtime.start(turns, "cancel", ctx); await runtime.cancel(next.consultation_id!, ctx);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
// Timeout and external cancellation must release in-memory participants before another consultation starts.
configure({ ...enabled, timeoutMs: 15 });
const waitingFactory: any = async (group: any[]) => ({
  ask(_question: string, signal: AbortSignal) {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, async abort() {}, dispose() {},
});
const timeoutRuntime = new ConsultationRuntime(waitingFactory, approveAll);
await assert.rejects(() => timeoutRuntime.start(turns, "timeout", ctx), /timed out/);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
configure(enabled);
const cancellation = timeoutRuntime.start(turns, "cancel while running", ctx);
await new Promise(resolve => setTimeout(resolve, 5));
await timeoutRuntime.close();
await assert.rejects(() => cancellation, /cancelled/);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));

// Independent in-memory consultants can read the same historical files without competing writers.
const firstReader = await runtime.start(turns, "first reader", ctx);
const competitor = new ConsultationRuntime(factory, approveAll);
const secondReader = await competitor.start(turns, "second reader", ctx);
assert.equal(secondReader.answers.length, 3);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
await runtime.cancel(firstReader.consultation_id!, ctx);
await competitor.cancel(secondReader.consultation_id!, ctx);

// Cancellation during asynchronous SDK creation must await cleanup and leave no orphan participant.
let releaseFactory!: () => void;
let factoryStarted!: () => void;
const started = new Promise<void>(resolve => { factoryStarted = resolve; });
let startupDisposed = 0;
const startup = new ConsultationRuntime(async () => {
  factoryStarted();
  await new Promise<void>(resolve => { releaseFactory = resolve; });
  return { async ask() { throw new Error("must not ask"); }, async abort() {}, dispose() { startupDisposed++; } };
}, approveAll);
const startupResult = startup.start(turns, "cancel startup", ctx);
await started;
const shutdown = startup.close();
releaseFactory();
await shutdown;
await assert.rejects(() => startupResult, /cancelled/);
assert.equal(startupDisposed, 1);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));

const { registerConsultationTools } = await import("../src/consultation-tools.ts");
let command: any;
const registered: any[] = [];
const { ConsultationPresentation, cleanDisplayText } = await import("../src/consultation-presentation.ts");
assert.equal(cleanDisplayText("\u001b[31m安全文本\u001b[0m\u0007"), "安全文本");
const presentation = new ConsultationPresentation();
const { MemoryOutput } = await import("../src/memory-output.ts");
command = { handler: registerConsultationTools((tool: any) => { registered.push(tool); }, runtime, presentation, new MemoryOutput()) };
assert.equal(registered.length, 3);
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { getThemeByName } = await import(new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { stripVTControlCharacters } = await import("node:util");
const initialDetails = { mode: "consultation", consultation: { consultation_id: "meeting-one", answers: [
  { sessionId: "session-one", question: "question one", answer: "**Bold answer**\n\n- First fact\n- 中文事实\n\n```ts\nconst value = 1;\n```", messageIds: ["message-one"] },
  { sessionId: "session-two", question: "question two", answer: "## Heading\n\n[Link](https://example.com)", messageIds: ["message-two"] },
] } };
const initialResult = { content: [{ type: "text" as const, text: JSON.stringify(initialDetails) }, { type: "text" as const, text: "Config · Discussion=on" }], details: initialDetails };
const originalPayload = JSON.stringify(initialResult);
const modelCallsBeforeRendering = calls.length;
for (const name of ["dark", "light"]) {
  initTheme(name, false);
  const theme = getThemeByName(name)!;
  for (const width of [40, 80, 120]) {
    const lines = presentation.render("recall_memory", initialResult, { expanded: false, isPartial: false }, theme, {}, false).render(width);
    const compact = stripVTControlCharacters(lines.join("\n"));
    assert.match(compact, /Agent 1 answer:/);
    assert.match(compact, /Agent 2 answer:/);
    assert.match(compact, /Bold answer/);
    assert.doesNotMatch(compact, /\*\*Bold answer\*\*|session-one|message-one|meeting-one|consultation_id/);
    assert.match(compact, /中文事实/);
    assert.match(compact, /const value = 1;/);
    assert.match(lines.join("\n"), /\u001b\[/);
    assert.match(compact, /Config · Discussion=on/);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const expanded = stripVTControlCharacters(presentation.render("recall_memory", initialResult, { expanded: true, isPartial: false }, theme, {}, false).render(width).join("\n"));
    assert.match(expanded, /User question: question one/);
    assert.match(expanded, /session-one/);
    assert.match(expanded, /message-one/);
    assert.match(expanded, /meeting-one/);
    const followUpResult = { content: [{ type: "text" as const, text: JSON.stringify(initialDetails.consultation.answers[1]) }], details: initialDetails.consultation.answers[1] };
    const followUp = stripVTControlCharacters(registered[0].renderResult(followUpResult, { expanded: false, isPartial: false }, theme, { args: { consultation_id: "meeting-one" }, isError: false }).render(width).join("\n"));
    assert.match(followUp, /Agent 2 answer:/);
    assert.doesNotMatch(followUp, /session-two|message-two|meeting-one/);
  }
}
assert.equal(JSON.stringify(initialResult), originalPayload);
assert.equal(calls.length, modelCallsBeforeRendering, "presentation must not invoke a model");
presentation.restore([{ type: "message", message: { role: "toolResult", details: initialDetails } }]);
assert.equal(presentation.number("meeting-one", "session-two"), 2);
presentation.remember({ consultation_id: "meeting-two", answers: [...initialDetails.consultation.answers].reverse() });
assert.equal(presentation.number("meeting-one", "session-two"), 2);
assert.equal(presentation.number("meeting-two", "session-two"), 1);
assert.throws(() => presentation.number("unknown", "session-two"), /Unknown consultation participant/);
const theme = getThemeByName("dark")!;
const displayStatus = (tool: string, details: unknown, error = false) => stripVTControlCharacters(presentation.render(tool, {
  content: [{ type: "text", text: error ? "Timeout\nInternal stack" : JSON.stringify(details) }], details,
}, { expanded: false, isPartial: false }, theme, { consultation_id: "meeting-one" }, error).render(100).join("\n"));
assert.match(displayStatus("recall_memory", { consultation: { consultation_id: null, answers: [], reason: "No candidates" } }), /Consultation not started: No candidates/);
assert.match(displayStatus("recall_memory", {}, true), /Consultation failed: Timeout/);
assert.doesNotMatch(displayStatus("recall_memory", {}, true), /Internal stack/);
assert.match(displayStatus("finish_session_consultation", { path: "/knowledge/minutes.md" }), /Draft OKF minutes saved:/);
assert.match(displayStatus("cancel_session_consultation", { cancelled: "meeting-one" }), /Consultation cancelled\. Historical participants released\./);
assert.doesNotMatch(displayStatus("cancel_session_consultation", { cancelled: "meeting-one" }), /meeting-one/);
assert.match(stripVTControlCharacters(presentation.render("recall_memory", { content: [], details: {} },
  { expanded: false, isPartial: true }, theme, {}, false).render(100).join("\n")), /Waiting for historical agent answers…/);
for (const tool of registered) {
  assert.equal(stripVTControlCharacters(tool.renderCall({ consultation_id: "hidden-id", session_id: "hidden-session" }, theme).render(100).join("\n")).trim(), tool.label);
}
for (const args of ["null", "{}", '{"action":"cancel"}', '{"action":"follow-up","consultation_id":"x"}', '{"action":"finish","consultation_id":"x","conclusion":{}}']) {
  await assert.rejects(() => command.handler(args, ctx), /Invalid consultation command/);
}
// Real main-agent tools remain usable during Discussion and in later prompts. No remote requests.
const mainLoader: any = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are the main coding agent. Use the read tool when asked to run a main tool probe.",
  getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
  extendResources: () => {}, reload: async () => {},
};
const { session: mainAgent } = await createAgentSession({
  cwd: root, model, modelRuntime, sessionManager: main, resourceLoader: mainLoader,
  tools: ["read", "bash", "edit", "write"], thinkingLevel: "off",
  settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
});
const mainTools = mainAgent.getActiveToolNames();
const mainPrompt = mainAgent.systemPrompt;
assert.deepEqual(mainTools, ["read", "bash", "edit", "write"]);
const extensionEvents = new Map<string, (...args: any[]) => any>();
const extensionTools = new Map<string, any>();
const extension = (await import("../extensions/index.ts")).default;
extension({
  on(name: string, handler: (...args: any[]) => any) { extensionEvents.set(name, handler); },
  registerTool(tool: any) { extensionTools.set(tool.name, requestContextTool(tool, () => extensionEvents.get("context")!)); }, registerCommand() {},
  setActiveTools() { throw new Error("Consultation must not change main-agent tools"); },
} as any);
const discussionOptions = { entities: ["historical", "consultation"], primary_entity: "historical", question: "What does historical evidence say about consultation?" };
const startDiscussion = async () => {
  const callsBefore = calls.length;
  const result = await extensionTools.get("recall_memory").execute("discussion", discussionOptions, undefined, () => {}, simulateSelection(["\r"]));
  assert.ok(calls.slice(callsBefore).every(call => (call.tools?.length ?? 0) === 0 && /historical session consultant/.test(call.systemPrompt)), "only historical consultants must be tool-free");
  assert.equal(result.details.consultation.answers.length, 3);
  assert.match(result.content[0].text, /You remain the main agent/);
  assert.doesNotMatch(result.content[0].text, /Do not use fetch_session|This is the consultation branch/);
  assert.deepEqual(mainAgent.getActiveToolNames(), mainTools);
  assert.equal(mainAgent.systemPrompt, mainPrompt);
  return result.details.consultation;
};
const probeMainTools = async (label: string) => {
  await mainAgent.prompt(`main tool probe ${label}`);
  const result = mainAgent.messages.filter(message => message.role === "toolResult" && message.toolName === "read").at(-1);
  assert.ok(result?.role === "toolResult" && JSON.stringify(result.content).includes("main tools remain usable"), `main read tool must work ${label}`);
  assert.deepEqual(mainAgent.getActiveToolNames(), mainTools);
  assert.equal(mainAgent.systemPrompt, mainPrompt);
};
await probeMainTools("before Discussion");
const automaticCleanup = await startDiscussion();
const independentFetch = await extensionTools.get("fetch_session").execute("source-check", { turn_id: turns[0].turn_id, before: 0, after: 0 });
assert.equal(independentFetch.details.turnCount, 1, "main source checking must remain available during Discussion");
const independentAudit = await extensionTools.get("review_jev_filtered").execute("audit", discussionOptions, undefined, () => {});
assert.equal(independentAudit.details.jev.status, "disabled");
await probeMainTools("during Discussion");
const meetingsBeforeSettle = readdirSync(join(knowledgePath, "meetings"));
await extensionEvents.get("agent_settled")!({}, ctx);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
assert.deepEqual(readdirSync(join(knowledgePath, "meetings")), meetingsBeforeSettle, "automatic cancellation must not create minutes");
await assert.rejects(() => extensionTools.get("follow_up_session").execute("closed", {
  consultation_id: automaticCleanup.consultation_id, session_id: automaticCleanup.answers[0].sessionId, question: "too late",
}, undefined, undefined, ctx), /Unknown consultation ID/);
await probeMainTools("after Discussion settles");
configure({ timeoutMs: 2000 });
const finished = await startDiscussion();
const finishResult = await extensionTools.get("finish_session_consultation").execute("finish", { consultation_id: finished.consultation_id, conclusion }, undefined, undefined, ctx);
assert.match(finishResult.content[1].text, /No consultation is active/);
const defaultMinutes = join(configDirectory, "knowledge", "meetings", finished.consultation_id, "minutes.md");
assert.equal(finishResult.details.path, defaultMinutes, "Discussion uses the shared default directory when knowledgePath is omitted");
const finalMessage = { role: "assistant", content: [{ type: "text", text: "A different summary" }], stopReason: "stop", timestamp: 1 };
const replaced = await extensionEvents.get("message_end")!({ message: finalMessage }, ctx);
assert.equal(replaced.message.content[0].text, readFileSync(defaultMinutes, "utf8"));
assert.equal(replaced.message.content[0].text, finishResult.details.markdown);
await probeMainTools("after explicit finish");
const cancelled = await startDiscussion();
const cancelResult = await extensionTools.get("cancel_session_consultation").execute("cancel", { consultation_id: cancelled.consultation_id }, undefined, undefined, ctx);
assert.match(cancelResult.content[1].text, /No consultation is active/);
await probeMainTools("after explicit cancel");
assert.equal(getSessionMemoryConfig().enableDiscussion, true, "ending a discussion must not disable future recall discussions");
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));
const vault = join(root, "obsidian-vault");
mkdirSync(vault);
writeFileSync(configPath, JSON.stringify({ recallLimit: 20, enableDiscussion: true, consultation: { timeoutMs: 2000 }, obsidianExportEnabled: true, obsidianVaultPath: vault }));
const defaultMeetingsBeforeVault = readdirSync(join(configDirectory, "knowledge", "meetings"));
const vaultDiscussion = await startDiscussion();
const vaultFinished = await extensionTools.get("finish_session_consultation").execute("finish-vault", { consultation_id: vaultDiscussion.consultation_id, conclusion }, undefined, undefined, ctx);
assert.equal(vaultFinished.details.path, join(vault, "meetings", vaultDiscussion.consultation_id, "minutes.md"));
const vaultMessage = await extensionEvents.get("message_end")!({ message: finalMessage }, ctx);
assert.equal(vaultMessage.message.content[0].text, readFileSync(vaultFinished.details.path, "utf8"));
assert.deepEqual(readdirSync(join(configDirectory, "knowledge", "meetings")), defaultMeetingsBeforeVault, "Discussion must not duplicate vault minutes in the default directory");
await extensionEvents.get("agent_settled")!({}, ctx);
assert.deepEqual((await extensionEvents.get("message_end")!({ message: finalMessage }, ctx)).message, finalMessage, "finished OKF must not replace a later unrelated answer");
configure(enabled);
mainAgent.dispose();

const cleanupRuntime = new ConsultationRuntime(async () => ({
  async ask(question) { return { sessionId: turns[0].session_id, question, answer: "cleanup", messageIds: [] }; },
  async abort() { throw new Error("abort failure"); },
  dispose() { throw new Error("dispose failure"); },
}), approveAll);
const cleanupMeeting = await cleanupRuntime.start(turns, "cleanup errors", ctx);
await assert.rejects(() => cleanupRuntime.cancel(cleanupMeeting.consultation_id!, ctx), /Consultation cleanup failed/);
assert.ok(!existsSync(join(configDirectory, "consultation-locks")));

const { writeMeetingMinutes } = await import("../src/meeting-minutes.ts");
assert.throws(() => writeMeetingMinutes({} as any, {} as any), /description must be non-empty/);
rmSync(root, { recursive: true, force: true });
console.log("consultation tests passed (real SDK, deterministic provider; no live sessions modified)");
