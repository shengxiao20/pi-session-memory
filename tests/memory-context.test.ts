import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-transient-history-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const configRoot = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configRoot, { recursive: true });
const configure = (discussion = false) => writeFileSync(join(configRoot, "config.json"), JSON.stringify({ recallLimit: 20, enableDiscussion: discussion, consultation: { timeoutMs: 5000 } }));
configure();
const { MemoryContext, withMemoryContext } = await import("../src/memory-context.ts");
const { SessionManager, ModelRuntime, DefaultResourceLoader, createAgentSession, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { upsertSession, upsertTurn, getDb, getSession } = await import("../src/db.ts");
const aiPath = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const { createAssistantMessageEventStream } = await import(aiPath);
const sourceMarker = "SOURCE_ONLY_94ca8d";
const privateMarker = "PRIVATE_ONLY_aa287d";
const thinkingMarker = "INTERMEDIATE_ONLY_176d3e";
const assertClean = (value: unknown) => assert.doesNotMatch(typeof value === "string" ? value : JSON.stringify(value), /SOURCE_ONLY_94ca8d|PRIVATE_ONLY_aa287d|INTERMEDIATE_ONLY_176d3e/);
const model: any = { id: "transient", name: "Transient test", provider: "transient-test", api: "openai-completions", baseUrl: "http://unused", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
const assistant = (text: string): any => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });

// Unit checks: immutable projection, usage accounting, compaction survival, display expiry and unaffected tools.
const memory = new MemoryContext();
const full = { content: [{ type: "text" as const, text: sourceMarker }, { type: "text" as const, text: "Config · Jev=off\nEnv · MEMORY_DB_PATH=set" }], details: { evidence: privateMarker }, usage: assistant("").usage };
const lightweight = memory.retain("unit-call", "recall_memory", full);
assertClean(lightweight);
assert.deepEqual(lightweight.usage, full.usage);
const canonicalTool: any = { role: "toolResult", toolName: "recall_memory", toolCallId: "unit-call", isError: false, timestamp: 1, ...lightweight };
const request = memory.inject([canonicalTool]);
assert.equal((request[0] as any).content[0].text, sourceMarker);
assert.equal((request[0] as any).details.evidence, privateMarker);
assertClean(canonicalTool);
(request[0] as any).content[0].text = "changed";
assert.equal((memory.inject([canonicalTool])[0] as any).content[0].text, sourceMarker);
assert.match(JSON.stringify(memory.inject([])), /SOURCE_ONLY_94ca8d/, "evidence remains available when compaction omits its tool message");
const intermediate: any = { ...assistant(thinkingMarker), content: [{ type: "thinking", thinking: privateMarker }, { type: "text", text: sourceMarker }, { type: "toolCall", id: "assistant-call", name: "fetch_session", arguments: { turn_id: "exact-id", before: 0, after: 0 } }], stopReason: "toolUse" };
const cleanAssistant = memory.finalize(intermediate);
assertClean(cleanAssistant);
assert.deepEqual(cleanAssistant.content, [intermediate.content[2]]);
assert.equal((memory.inject([cleanAssistant])[0] as any).content[0].thinking, privateMarker);
assertClean(memory.finalize({ ...assistant(sourceMarker), stopReason: "aborted" }));
memory.reset();
assertClean(memory.inject([canonicalTool, cleanAssistant]));
assert.equal(memory.renderResult(lightweight), undefined);
const secondResult = memory.retain("unit-call", "recall_memory", { content: [{ type: "text", text: "New run evidence" }], details: {} });
assert.notEqual((secondResult.details as any).context_id, (lightweight.details as any).context_id);
assertClean(memory.inject([canonicalTool])[0]);
const secondAssistant = { ...intermediate, timestamp: intermediate.timestamp + 1 };
memory.finalize(secondAssistant);
assertClean(memory.inject([cleanAssistant])[0]);
memory.reset();
const plain = assistant("ordinary answer");
assert.equal(memory.finalize(plain), plain);
const unrelated: any = withMemoryContext({ name: "get_memory_stats", label: "Stats", description: "Stats", parameters: {}, async execute() { return { content: [{ type: "text", text: "2 turns" }], details: { count: 2 } }; } }, memory);
assert.deepEqual((await unrelated.execute()).details, { count: 2 });

const historical = SessionManager.create(home, join(home, "historical"));
const userId = historical.appendMessage({ role: "user", content: "Earlier historytopic work", timestamp: 1 });
historical.appendMessage(assistant(sourceMarker));
const sourceId = `pi:${historical.getSessionId()}`;
const turnId = `${sourceId}:${userId}`;
upsertSession({ session_id: sourceId, source: "pi", cwd: home, started_at: 1, model_id: model.id, jsonl_path: historical.getSessionFile()! });
upsertTurn({ turn_id: turnId, session_id: sourceId, turn_index: 0, ts: 1, user_text: "Earlier historytopic work", reply_text: sourceMarker, tool_names: null, user_message_id: userId });
const originalBytes = readFileSync(historical.getSessionFile()!, "utf8");
const mainManager = SessionManager.create(home, join(home, "main"));
let mode = "transcript";
let step = 0;
let consultationId = "";
let reuseId = "";
const calls: Array<{ mode: string; step: number; context: any }> = [];
const conclusion = (route: string) => ({ description: `${route} research findings and uncertainty`, findings: `Evidence supports a limited research conclusion [${route === "Transcript" ? "transcript" : "consultation"}-1].`, decisions: "None", unverified_inferences: "Implementation remains unverified.", disagreements: "None", open_questions: "None", actions: "None" });
const query = { entities: ["historytopic", "work"], primary_entity: "historytopic", question: "Review earlier historytopic work" };
const provider: any = {
  id: model.provider, name: "Deterministic test", auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test" } }) } }, getModels: () => [model],
  streamSimple(_model: any, context: any) {
    const consultant = context.systemPrompt.includes("historical session consultant");
    calls.push({ mode: consultant ? "consultant" : mode, step, context: JSON.parse(JSON.stringify(context)) });
    const stream = createAssistantMessageEventStream();
    let message: any;
    if (consultant) message = assistant(privateMarker);
    else if (mode === "compaction") { assertClean(context); message = assistant("Research decisions and final OKF documents are retained."); }
    else if (mode === "ordinary") { assertClean(context); message = assistant("ordinary answer"); }
    else {
      if (existsSync(mainManager.getSessionFile()!)) assertClean(readFileSync(mainManager.getSessionFile()!, "utf8"));
      const contextText = JSON.stringify(context.messages);
      let name: string | undefined;
      let args: any;
      if (step === 0) { name = "inspect_memory_knowledge"; args = {}; }
      else if (mode === "reuse") {
        if (step === 1) { assert.doesNotMatch(contextText, /SOURCE_ONLY_94ca8d|PRIVATE_ONLY_aa287d/); name = "read_memory_knowledge"; args = { meeting_id: reuseId }; }
        else { assert.match(contextText, /Transcript research/); message = assistant("not the saved document"); }
      } else if (step === 1) { name = "recall_memory"; args = query; }
      else if (mode === "transcript") {
        assert.match(contextText, /SOURCE_ONLY_94ca8d/, "main model must receive the recalled original text");
        if (step === 2) { name = "fetch_session"; args = { turn_id: turnId, before: 0, after: 0 }; }
        else if (step === 3) { name = "review_jev_filtered"; args = query; }
        else if (step === 4) { name = "finish_memory_recall"; args = { question: query.question, conclusion: conclusion("Transcript") }; }
        else message = assistant("not the saved document");
      } else {
        assert.match(contextText, /PRIVATE_ONLY_aa287d/, "main model must receive private answers in temporary context");
        if (step === 2) {
          const recalled = context.messages.findLast((value: any) => value.role === "toolResult" && value.toolName === "recall_memory");
          const match = /"consultation_id":\s*"([^"]+)"/.exec(recalled.content[0].text);
          assert.ok(match, "consultation ID must be returned to the main model");
          consultationId = match[1];
          name = "follow_up_session"; args = { consultation_id: consultationId, session_id: sourceId, question: "Which facts remain unverified?" };
        } else if (step === 3) { name = "finish_session_consultation"; args = { consultation_id: consultationId, conclusion: conclusion("Discussion") }; }
        else message = assistant("not the saved document");
      }
      if (name) message = { ...assistant(""), content: [{ type: "text", text: `${thinkingMarker} ${step > 1 ? sourceMarker : ""}` }, { type: "thinking", thinking: thinkingMarker }, { type: "toolCall", id: `${mode}-${step}`, name, arguments: args }], stopReason: "toolUse" };
      step++;
    }
    queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
    return stream;
  }, stream(...args: any[]) { return this.streamSimple(...args); },
};
const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
modelRuntime.registerNativeProvider(provider);
const extension = (await import("../extensions/index.ts")).default;
const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 } });
const resources = new DefaultResourceLoader({ cwd: home, agentDir: join(home, ".pi", "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension], systemPrompt: "You are the main coding agent." });
await resources.reload();
const { session } = await createAgentSession({ cwd: home, model, modelRuntime, sessionManager: mainManager, resourceLoader: resources, settingsManager: settings, tools: ["inspect_memory_knowledge", "read_memory_knowledge", "recall_memory", "fetch_session", "review_jev_filtered", "finish_memory_recall", "follow_up_session", "finish_session_consultation"], thinkingLevel: "off" });
const { KeybindingsManager, TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");
try {
  await session.bindExtensions({ mode: "tui", onError(error) { throw new Error(JSON.stringify(error)); }, uiContext: {
    notify() {}, async custom(build: any) {
      let selected: unknown;
      const component = build({ terminal: { rows: 30 }, requestRender() {} }, { fg(_role: string, text: string) { return text; }, bg(_role: string, text: string) { return text; } }, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => { selected = value; });
      component.handleInput("\r"); component.dispose(); return selected;
    },
  } as any });
  await session.prompt(query.question);
  assert.equal(step, 6, JSON.stringify({ calls: calls.map(call => ({ mode: call.mode, step: call.step })), messages: session.messages }, null, 2));
  const minutesRoot = join(configRoot, "knowledge", "meetings");
  const transcriptIds = readdirSync(minutesRoot);
  assert.equal(transcriptIds.length, 1);
  reuseId = transcriptIds[0];
  const transcriptMarkdown = readFileSync(join(minutesRoot, reuseId, "minutes.md"), "utf8");
  assert.equal((session.messages.at(-1) as any).content[0].text, transcriptMarkdown);
  const transcriptEntries = mainManager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult");
  assert.equal(transcriptEntries.length, 5);
  assert.ok(transcriptEntries.every((entry: any) => entry.message.details.memory_context === "transient"));
  assert.ok(mainManager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse").every((entry: any) => entry.message.content.every((block: any) => block.type === "toolCall")));
  assertClean(readFileSync(mainManager.getSessionFile()!, "utf8"));
  assert.match(readFileSync(join(minutesRoot, reuseId, "evidence-1.md"), "utf8"), /SOURCE_ONLY_94ca8d/, "portable OKF evidence remains intentionally saved outside JSONL");
  mode = "ordinary";
  await session.prompt("Explain a general programming concept");
  assert.equal(session.getLastAssistantText(), "ordinary answer");
  mode = "reuse"; step = 0;
  await session.prompt("Review the saved research conclusion");
  assert.equal((session.messages.at(-1) as any).content[0].text, transcriptMarkdown);
  assert.deepEqual(readdirSync(minutesRoot), transcriptIds);
  mode = "discussion"; step = 0; configure(true);
  await session.prompt("Review unresolved historical evidence");
  const discussionMarkdown = readFileSync(join(minutesRoot, consultationId, "minutes.md"), "utf8");
  assert.equal((session.messages.at(-1) as any).content[0].text, discussionMarkdown);
  assertClean(readFileSync(mainManager.getSessionFile()!, "utf8"));
  assert.equal(readFileSync(historical.getSessionFile()!, "utf8"), originalBytes);
  assert.ok(!existsSync(join(configRoot, "consultation-locks")));
  assert.match(readFileSync(join(minutesRoot, consultationId, "evidence-1.md"), "utf8"), /PRIVATE_ONLY_aa287d/);
  const indexedMain = getSession(`pi:${mainManager.getSessionId()}`);
  assertClean(indexedMain.turns);
  assert.equal(indexedMain.turns.length, 1);
  assert.equal(indexedMain.turns[0].user_text, "Explain a general programming concept");
  assert.doesNotMatch(JSON.stringify(indexedMain.turns), /Transcript research|Discussion research/, "entire package-tool turns, including their final OKF text, must stay outside SQLite");
  mode = "compaction";
  await session.compact();
  assert.ok(calls.some(call => call.mode === "compaction"));
  assertClean(readFileSync(mainManager.getSessionFile()!, "utf8"));
  mode = "ordinary";
  await session.prompt("An unrelated question after compaction");
  assert.equal(session.getLastAssistantText(), "ordinary answer");
  console.log("memory-context tests passed: real SDK tool/context boundaries, JSONL isolation, original-file immutability, final OKF persistence, indexing and compaction");
} finally { session.dispose(); getDb().close(); rmSync(home, { recursive: true, force: true }); }
