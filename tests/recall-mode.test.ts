import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { selectRecallMode } from "../src/recall/recall-mode.ts";
import { requestContextTool } from "./helpers/request-context-tool.ts";
import { knowledgeFields } from "./helpers/knowledge-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "pi-recall-mode-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "memory.db");
const directory = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(directory, { recursive: true });
const configPath = join(directory, "config.json");
const { RECALL_MODES, DEFAULT_RECALL_MODE, validateMemoryConfig, DISCUSSION_TURN_THRESHOLD_ENV } = await import("../src/settings/config.ts");
const originalThreshold = process.env[DISCUSSION_TURN_THRESHOLD_ENV];
delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];
const { setupConfigurationSchema } = await import("../src/setup/setup-schema.ts");
const { configureMemory, readMemorySetup } = await import("../src/setup/setup.ts");
const { default: extension } = await import("../extensions/index.ts");
const { upsertSession, insertTurn, getSession } = await import("../src/history/db.ts");
const { ConsultationRuntime } = await import("../src/consultation/consultation-runtime.ts");
const writeConfig = (extra: object = {}) => writeFileSync(configPath, JSON.stringify({ recallLimit: 20, ...extra }));
const originalStart = ConsultationRuntime.prototype.start;
const query = { entities: ["mode project"], primary_entity: "mode project", question: "Review mode project" };
const finalMessage: any = { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: 1 };
try {
  assert.equal(DEFAULT_RECALL_MODE, "choice");
  assert.equal(validateMemoryConfig({ recallLimit: 20 }).recallMode, "choice");
  assert.equal(validateMemoryConfig({ recallLimit: 20, recallMode: "choice" }).consultation, undefined);
  assert.equal(Value.Check(setupConfigurationSchema, { recallLimit: 20 }), true);
  assert.equal((setupConfigurationSchema.properties.recallMode as any).default, "choice");
  for (const mode of RECALL_MODES) {
    const proposal = { recallLimit: 20, recallMode: mode, consultation: { timeoutMs: 2000 } };
    assert.equal(Value.Check(setupConfigurationSchema, proposal), true);
    assert.equal(validateMemoryConfig(proposal).recallMode, mode);
  }
  for (const mode of [true, false, null, 0, "", "normal ", "Choice", "invalid", {}, []]) {
    assert.equal(Value.Check(setupConfigurationSchema, { recallLimit: 20, recallMode: mode }), false);
    assert.throws(() => validateMemoryConfig({ recallLimit: 20, recallMode: mode }), /recallMode must be/);
  }
  assert.throws(() => validateMemoryConfig({ recallLimit: 20, recallMode: "discussion" }), /discussion mode requires consultation/);
  for (const old of [true, false]) {
    writeConfig({ enableDiscussion: old, consultation: { timeoutMs: 8000 }, unrelated: { keep: true } });
    const bytes = readFileSync(configPath, "utf8");
    assert.throws(() => validateMemoryConfig(JSON.parse(bytes)), /enableDiscussion is no longer supported/);
    assert.equal(readMemorySetup().configuration!.enableDiscussion, old);
    assert.equal(readFileSync(configPath, "utf8"), bytes, "reading legacy config never migrates it");
    assert.throws(() => configureMemory({ recallLimit: 20, enableDiscussion: old }), /Invalid setup configuration/);
    assert.equal(readFileSync(configPath, "utf8"), bytes, "invalid proposals preserve legacy bytes");
    configureMemory({ recallLimit: 20, recallMode: "choice", consultation: { timeoutMs: 8000 } });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      recallLimit: 20, recallMode: "choice", consultation: { timeoutMs: 8000 }, unrelated: { keep: true },
    }, "an approved save removes the retired switch and preserves unrelated keys");
  }

  const counts = { global: 3, project: 2 };
  for (const mode of ["normal", "discussion"] as const) {
    assert.equal(await selectRecallMode(mode, counts, { hasUI: false } as any), mode);
  }
  await assert.rejects(selectRecallMode("choice", counts, { hasUI: false } as any), /requires Pi TUI mode/);
  const uiCalls: any[] = [];
  const ui = (answer?: number | string, controller?: AbortController) => ({
    hasUI: true,
    ui: { async select(title: string, options: string[], dialog: any) {
      uiCalls.push({ title, options, dialog });
      controller?.abort(new Error("Interrupted at menu"));
      return typeof answer === "number" ? options[answer] : answer;
    } },
  } as any);
  assert.equal(await selectRecallMode("choice", counts, ui(0)), "normal");
  assert.equal(await selectRecallMode("choice", counts, ui(1)), "discussion");
  assert.equal(await selectRecallMode("choice", counts, ui()), undefined);
  assert.match(uiCalls[0].title, /5 unique turns/);
  assert.match(uiCalls[0].title, /Global: 3 · Additional project turns: 2/);
  assert.match(uiCalls[0].title, /This call only.*Esc cancels/);
  assert.deepEqual(uiCalls[0].options.map((option: string) => option.split(" ")[0]), ["normal", "discussion"]);
  await assert.rejects(selectRecallMode("choice", counts, ui("unknown")), /Unknown recall mode selection/);
  const preAbort = new AbortController(); preAbort.abort(new Error("Already interrupted"));
  const beforeCalls = uiCalls.length;
  await assert.rejects(selectRecallMode("choice", counts, ui(0), preAbort.signal), /Already interrupted/);
  assert.equal(uiCalls.length, beforeCalls, "a cancelled call never opens the selector");
  const duringAbort = new AbortController();
  await assert.rejects(selectRecallMode("choice", counts, ui(0, duringAbort), duringAbort.signal), /Interrupted at menu/);
  assert.strictEqual(uiCalls.at(-1).dialog.signal, duringAbort.signal, "native select receives the caller's abort signal");
  assert.equal(await selectRecallMode("choice", { global: 0, project: 0 }, ui(0)), "normal", "empty recall still asks");

  const session_id = "pi:mode-history";
  upsertSession({ session_id, source: "pi", cwd: "/work/mode-project", started_at: 1, model_id: null, jsonl_path: join(home, "history.jsonl") });
  for (let i = 0; i < 2; i++) insertTurn({ turn_id: `${session_id}:u${i}`, session_id, turn_index: i, ts: i,
    user_text: `mode project question ${i}`, reply_text: `Source answer ${i}`, user_message_id: `u${i}`, tool_names: null });
  const starts: any[] = [];
  ConsultationRuntime.prototype.start = async function(turns, question, ctx, signal) {
    starts.push({ turns, question, ctx, signal });
    return { status: "active", consultation_id: "test-consultation", answers: [] };
  };
  const build = (answer?: number, hasUI = true) => {
    const events = new Map<string, any>(); const tools = new Map<string, any>();
    extension({ on(name: string, handler: any) { events.set(name, handler); }, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, requestContextTool(tool, () => events.get("context"))); },
    } as any);
    const updates: any[] = []; const menus: any[] = [];
    const ctx: any = { hasUI, sessionManager: { getSessionId: () => "main" }, ui: {
      notify() {}, async select(title: string, options: string[]) {
        assert.equal(updates.at(-1).details.stage, "project", "menu opens after both search stages");
        assert.match(title, /2 unique turns/);
        assert.match(title, /Additional project turns: 0/, "counts exclude exact global/project duplicates");
        menus.push({ title, options });
        return answer === undefined ? undefined : options[answer];
      },
    } };
    return { events, tools, updates, menus, ctx, recall: (input = query) => tools.get("recall_memory").execute("recall", input, undefined, (update: any) => updates.push(update), ctx) };
  };
  for (const configuredMode of [undefined, "choice", "normal", "discussion"] as const) {
    writeConfig({ ...(configuredMode === undefined ? {} : { recallMode: configuredMode }), consultation: { timeoutMs: 2000 } });
    for (const selection of [0, 1] as const) {
      const app = build(selection);
      const bytes = readFileSync(configPath, "utf8"); const beforeStarts = starts.length;
      const result = await app.recall();
      const selected = configuredMode === "normal" || configuredMode === "discussion" ? configuredMode : selection === 0 ? "normal" : "discussion";
      assert.equal(result.details.recallMode, selected);
      assert.equal(result.details.configuredMode, configuredMode ?? "choice");
      assert.equal(app.menus.length, configuredMode === undefined || configuredMode === "choice" ? 1 : 0);
      assert.equal(starts.length - beforeStarts, selected === "discussion" ? 1 : 0);
      if (selected === "normal") {
        assert.equal(result.details.mode, "transcript"); assert.equal(result.details.returnedResults, 2);
        assert.equal(result.details.project.duplicatesRemoved, 2);
        assert.ok(result.content.some((block: any) => /Source answer/.test(block.text)));
      } else {
        assert.equal(result.details.mode, "consultation");
        assert.equal(starts.at(-1).question, query.question);
        assert.equal(starts.at(-1).turns.length, 2, "consultation receives final deduplicated evidence");
        assert.ok(!result.content.some((block: any) => /Source answer/.test(block.text)), "discussion does not return raw sections");
      }
      assert.equal(readFileSync(configPath, "utf8"), bytes, "per-call selection never persists a mode");
      const final = app.events.get("message_end")({ message: finalMessage }, app.ctx);
      assert.equal(final.message.stopReason, "error", "both evidence routes still require an OKF conclusion");
      await app.events.get("session_before_switch")();
    }
  }
  for (const mode of RECALL_MODES) {
    writeConfig({ recallMode: mode, consultation: { timeoutMs: 2000 } });
    const app = build(); const bytes = readFileSync(configPath, "utf8");
    const sourceBefore = getSession(session_id); const callsBefore = starts.length;
    app.ctx.ui.select = async () => { throw new Error("fetch_session must never choose a recall mode"); };
    const fetched = await app.tools.get("fetch_session").execute("fetch", { turn_id: `${session_id}:u0`, before: 0, after: 0 }, undefined, undefined, app.ctx);
    assert.equal(fetched.details.turnCount, 1);
    assert.deepEqual(fetched.details.fetchedTurnIds, [`${session_id}:u0`]);
    assert.equal(starts.length, callsBefore);
    assert.deepEqual(getSession(session_id), sourceBefore, "fetch remains read-only in every mode");
    assert.equal(readFileSync(configPath, "utf8"), bytes);
    await app.events.get("session_before_switch")();
  }
  writeConfig();
  const repeat = build(0); await repeat.recall(); await repeat.recall();
  assert.equal(repeat.menus.length, 2, "choice asks on every call rather than caching the first answer");
  const cancelled = build(); const startsBeforeCancel = starts.length;
  const cancellation = await cancelled.recall();
  assert.equal(cancellation.details.mode, "cancelled");
  assert.equal(starts.length, startsBeforeCancel);
  assert.deepEqual(cancelled.events.get("message_end")({ message: finalMessage }).message, finalMessage,
    "menu cancellation adds no evidence and creates no finish requirement");
  const headless = build(0, false);
  await assert.rejects(headless.recall(), /requires Pi TUI mode/);
  assert.equal(headless.updates.at(-1).details.stage, "project", "headless error occurs after retrieval, without a fallback");
  assert.equal(headless.menus.length, 0);
  const invalid = build(0);
  await assert.rejects(invalid.recall({ ...query, primary_entity: "wrong" }), /included in entities/);
  assert.equal(invalid.menus.length, 0, "a failed query does not open a mode menu");

  ConsultationRuntime.prototype.start = originalStart;
  writeConfig();
  const missing = build(1);
  await assert.rejects(missing.recall(), /consultation.timeoutMs is not configured/);
  assert.equal(missing.menus.length, 1, "missing consultation config does not force normal before asking");
  assert.deepEqual(missing.events.get("message_end")({ message: finalMessage }).message, finalMessage);
  for (const configuredMode of ["discussion", "choice"] as const) {
    for (const turnThreshold of [undefined, 2]) {
      const knowledgePath = join(home, `fallback-${configuredMode}-${turnThreshold ?? "default"}`);
      writeConfig({ recallMode: configuredMode, knowledgePath, consultation: { timeoutMs: 2000,
        ...(turnThreshold === undefined ? {} : { turnThreshold }) } });
      const app = build(1); const bytes = readFileSync(configPath, "utf8");
      let pickers = 0;
      app.ctx.mode = "tui";
      app.ctx.ui.custom = async () => { pickers++; return turnThreshold === undefined ? undefined : []; };
      const fallback = await app.recall();
      assert.equal(fallback.details.mode, "transcript");
      assert.equal(fallback.details.recallMode, "normal");
      assert.equal(fallback.details.configuredMode, configuredMode);
      assert.match(fallback.details.fallbackReason, /unique returned-turn threshold/);
      assert.equal(fallback.details.returnedResults, 2);
      assert.equal(fallback.details.global.returnedResults, 2);
      assert.equal(fallback.details.project.returnedResults, 0);
      assert.equal(fallback.details.project.duplicatesRemoved, 2, "duplicate hits cannot exceed the exclusive threshold");
      assert.deepEqual(app.updates.map(update => update.details.stage), ["global", "project"], "fallback never repeats recall");
      assert.equal(pickers, 0, "no eligible session opens neither a checklist nor an agent");
      assert.ok(fallback.content.some((block: any) => /Source answer/.test(block.text)));
      assert.ok(fallback.content.some((block: any) => /transcript-1/.test(block.text)));
      assert.ok(!fallback.content.some((block: any) => /Private historical-session consultation/.test(block.text)));
      assert.equal(fallback.details.consultation, undefined);
      assert.equal(readFileSync(configPath, "utf8"), bytes);
      assert.ok(!existsSync(knowledgePath), "fallback does not save raw evidence");
      assert.equal(app.events.get("message_end")({ message: finalMessage }, app.ctx).message.stopReason, "error",
        "fallback follows the Normal OKF finish requirement");
      const saved = await app.tools.get("finish_memory_recall").execute("finish", { question: query.question, conclusion: {
        ...knowledgeFields, description: "Review of mode project evidence.", findings: "Sources reviewed [transcript-1].",
        decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None",
      } }, undefined, undefined, app.ctx);
      assert.match(saved.details.markdown, /transcript-1/);
      const final = app.events.get("message_end")({ message: finalMessage }, app.ctx).message;
      assert.equal(final.stopReason, "stop");
      assert.equal(final.content[0].text, saved.details.markdown, "fallback can save and emit the Normal OKF document");
      assert.equal(readFileSync(configPath, "utf8"), bytes);

      process.env[DISCUSSION_TURN_THRESHOLD_ENV] = "1";
      const next = await app.recall();
      delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];
      assert.equal(next.details.mode, "consultation", "the next call still attempts Discussion when a session exceeds the threshold");
      assert.equal(next.details.recallMode, "discussion");
      assert.equal(next.details.consultation.status, "cancelled");
      assert.equal(next.details.consultation.consultation_id, null);
      assert.equal(next.details.fallbackReason, undefined, "Esc and empty participant selection do not fall back");
      assert.ok(!next.content.some((block: any) => /Source answer|Fetch turn ID/.test(block.text)));
      assert.equal(pickers, 1, "the environment threshold is read again on the next call");
      assert.equal(app.menus.length, configuredMode === "choice" ? 2 : 0, "choice is not replaced by the previous fallback");
      assert.equal(readFileSync(configPath, "utf8"), bytes);
      await app.events.get("session_before_switch")();
    }
  }
  writeConfig({ recallMode: "discussion", consultation: { timeoutMs: 2000 } });
  const empty = build(undefined, false);
  const emptyFallback = await empty.recall({ entities: ["missing topic"], primary_entity: "missing topic", question: "Review missing topic" });
  assert.equal(emptyFallback.details.mode, "transcript", "zero hits use Normal without requiring a participant TUI");
  assert.equal(emptyFallback.details.recallMode, "normal");
  assert.equal(emptyFallback.details.returnedResults, 0);
  assert.deepEqual(emptyFallback.details.global.results, []);
  assert.deepEqual(emptyFallback.details.project.results, []);
  assert.equal(empty.menus.length, 0);
  assert.equal(empty.events.get("message_end")({ message: finalMessage }, empty.ctx).message.stopReason, "error");
  await empty.events.get("session_before_switch")();

  writeConfig({ recallMode: "choice", consultation: { timeoutMs: 2000, turnThreshold: 0 } });
  let confirmed = false; let disposed = 0;
  const runtime = new ConsultationRuntime(async (group) => {
    assert.equal(confirmed, true, "choice does not bypass participant confirmation");
    return { async ask(question) { return { sessionId: group[0].session_id, question, answer: "Private", messageIds: [] }; },
      async abort() {}, dispose() { disposed++; } };
  }, async groups => { confirmed = true; return groups; });
  const evidence: any = [{ turn_id: "pi:other:u", session_id: "pi:other", source: "pi", score: 11, ts: 1, turn_index: 0, user_text: "mode project", reply_text: "answer" }];
  const context: any = { sessionManager: { getSessionId: () => "main" } };
  const consultation = await runtime.start(evidence, query.question, context);
  assert.equal(consultation.status, "active");
  assert.ok(consultation.consultation_id);
  const followup = await runtime.followUp(consultation.consultation_id!, "pi:other", "Explain", context);
  assert.equal(followup.answer, "Private", "choice allows follow-up only for an active participant");
  await runtime.cancel(consultation.consultation_id!, context);
  assert.equal(disposed, 1);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).recallMode, "choice");
  assert.ok(!existsSync(join(directory, "knowledge")), "choosing or cancelling a mode never writes knowledge");
  console.log("recall mode tests passed: enum/default, explicit legacy repair, native menu, abort/Esc/headless, every-call routing, dedup counts, one-call no-candidate fallback, Normal OKF saving, no cancellation/error fallback, no persistence, confirmation/follow-up/cleanup");
} finally {
  ConsultationRuntime.prototype.start = originalStart;
  if (originalThreshold === undefined) delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];
  else process.env[DISCUSSION_TURN_THRESHOLD_ENV] = originalThreshold;
  rmSync(home, { recursive: true, force: true });
}
