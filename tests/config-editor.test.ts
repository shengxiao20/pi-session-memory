import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-config-editor-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "untouched.db");
const { editMemoryConfiguration } = await import("../src/setup/config-editor.ts");
const { CONFIG_FIELDS, completeConfigDraft, createConfigDraft, parseConfigFieldValue, setConfigFieldValue } = await import("../src/setup/config-fields.ts");
const { configureMemory } = await import("../src/setup/setup.ts");
const { DISCUSSION_TURN_THRESHOLD_ENV, getDiscussionTurnThreshold, getMemoryConfigPath } = await import("../src/settings/config.ts");
const path = getMemoryConfigPath();
const field = (key: string) => { const result = CONFIG_FIELDS.find(field => field.key === key); assert.ok(result); return result; };
type Step = { method: "select" | "input"; answer?: string; check?: (title: string, choices?: string[]) => void };
function _ui(steps: Step[]) {
  const notifications: string[] = [];
  const next = (method: Step["method"], title: string, choices?: string[]) => {
    const step = steps.shift(); assert.ok(step, `unexpected ${method}: ${title}`); assert.equal(step.method, method);
    step.check?.(title, choices);
    if (step.answer?.startsWith("field:")) {
      const row = choices?.find(row => row.trimStart().startsWith(`${step.answer!.slice(6)} `)); assert.ok(row); return row;
    }
    return step.answer;
  };
  return { hasUI: true, ui: { select: async (title: string, choices: string[]) => next("select", title, choices), input: async (title: string) => next("input", title), confirm: async () => { throw new Error("Direct editing must not ask for save confirmation"); }, notify: (text: string) => notifications.push(text) }, notifications } as any;
}
async function _edit(steps: Step[]) { const ctx = _ui(steps); await editMemoryConfiguration(ctx); assert.equal(steps.length, 0); return ctx; }
const select = (answer?: string): Step => ({ method: "select", answer });
const input = (answer?: string): Step => ({ method: "input", answer });
const baseline = { recallLimit: 20, recallMode: "normal", customLegacySetting: { keep: true }, knowledgePath: join(home, "custom"), consultation: { timeoutMs: 9000 } };
function _reset() { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(baseline)); }
try {
  delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];
  await _edit([select()]);
  assert.ok(!existsSync(dirname(path)), "menu Esc creates no configuration directory");
  await _edit([select("field:recallLimit"), input(), select()]);
  assert.ok(!existsSync(path), "field Esc does not save");
  await _edit([select("field:recallLimit"), input(""), { method: "select", check: () => {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).recallLimit, 20);
  } }]);
  const defaults = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(defaults.consultation.timeoutMs, 120000); assert.equal(defaults.consultation.turnThreshold, 5);
  assert.equal(defaults.recallMode, "choice");
  assert.equal(defaults.model, "nimble"); assert.equal(defaults.jevConnection.manageOllama, true);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!)); assert.ok(!existsSync(join(dirname(path), "knowledge")));

  _reset(); const before = readFileSync(path, "utf8");
  await _edit([select()]);
  assert.equal(readFileSync(path, "utf8"), before, "displaying saved values never rewrites configuration");
  await _edit([select("field:recallLimit"), input("7"), select()]);
  _reset();
  await _edit([select("field:recallLimit"), input(), select()]);
  assert.equal(readFileSync(path, "utf8"), before);
  const edits = await _edit([select("field:recallLimit"), input("7"), select("field:consultation.turnThreshold"), input("0"), select("field:knowledgePath"), input(""), select("field:recallMode"), select("discussion"), select("field:recallLimit"), input(), select()]);
  const edited = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(edited.recallLimit, 7); assert.equal(edited.consultation.turnThreshold, 0); assert.equal(edited.consultation.timeoutMs, 9000);
  assert.ok(!Object.hasOwn(edited, "knowledgePath")); assert.deepEqual(edited.customLegacySetting, baseline.customLegacySetting);
  assert.equal(edited.recallMode, "discussion"); assert.equal(getDiscussionTurnThreshold(), 0);
  assert.equal(edits.notifications.length, 4, "each submitted field is saved independently; later Esc does not undo saved fields");
  process.env[DISCUSSION_TURN_THRESHOLD_ENV] = "6";
  await _edit([select("field:consultation.turnThreshold"), input("2"), select()]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).consultation.turnThreshold, 2); assert.equal(getDiscussionTurnThreshold(), 6);
  delete process.env[DISCUSSION_TURN_THRESHOLD_ENV]; assert.equal(getDiscussionTurnThreshold(), 2);
  for (const raw of ["-1", "+5", "5.0", "05", "5e0", "5 ", "5\n", "5\r", "NaN", "Infinity", "9007199254740992"]) assert.throws(() => parseConfigFieldValue(field("consultation.turnThreshold"), raw));
  assert.equal(parseConfigFieldValue(field("consultation.turnThreshold"), "9007199254740991"), Number.MAX_SAFE_INTEGER);
  assert.equal(parseConfigFieldValue(field("recallLimit"), ""), 20); assert.equal(parseConfigFieldValue(field("consultation.timeoutMs"), ""), 120000);
  assert.equal(parseConfigFieldValue(field("jevConnection.contextWindow"), ""), undefined);
  assert.throws(() => parseConfigFieldValue(field("recallMode"), "1"));
  assert.equal(parseConfigFieldValue(field("recallMode"), ""), "choice");
  for (const mode of ["choice", "normal", "discussion"]) assert.equal(parseConfigFieldValue(field("recallMode"), mode), mode);
  for (const raw of ["true", "false", "CHOICE", "normal "]) assert.throws(() => parseConfigFieldValue(field("recallMode"), raw));
  for (const mode of ["choice", "normal", "discussion"]) {
    _reset();
    await _edit([select("field:recallMode"), select(mode), select()]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).recallMode, mode);
  }
  _reset();
  const legacy = { ...baseline, enableDiscussion: true }; delete (legacy as any).recallMode;
  writeFileSync(path, JSON.stringify(legacy));
  const legacyBytes = readFileSync(path, "utf8");
  await _edit([select("field:recallMode"), select(), select()]);
  assert.equal(readFileSync(path, "utf8"), legacyBytes, "Esc does not migrate the retired switch");
  await _edit([select("field:recallMode"), select("choice"), select()]);
  const repaired = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(repaired.recallMode, "choice"); assert.ok(!Object.hasOwn(repaired, "enableDiscussion"));
  assert.deepEqual(repaired.consultation, { ...baseline.consultation, turnThreshold: 5 });
  assert.deepEqual(repaired.customLegacySetting, baseline.customLegacySetting);
  for (const invalid of [-1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => configureMemory({ recallLimit: 20, consultation: { timeoutMs: 1000, turnThreshold: invalid } }));

  _reset(); const unchanged = readFileSync(path, "utf8");
  await assert.rejects(_edit([select("field:recallLimit"), input("0")]));
  await assert.rejects(_edit([select("field:jevConnection.manageOllama"), select("false")]));
  await assert.rejects(_edit([select("field:knowledgePath"), input("relative-root")]));
  await assert.rejects(_edit([select("field:knowledgePath"), input(path)]));
  assert.equal(readFileSync(path, "utf8"), unchanged, "invalid roots preserve the original configuration");
  const missingRoot = join(home, "missing-knowledge");
  await _edit([select("field:knowledgePath"), input(missingRoot), select()]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).knowledgePath, missingRoot);
  assert.ok(!existsSync(missingRoot), "saving a root does not initialize knowledge");
  _reset(); assert.equal(readFileSync(path, "utf8"), unchanged);
  const custom = join(home, "knowledge-parent", "bundle");
  await _edit([select("field:jevConnection.apiKeyEnv"), input("EDITOR_TEST_KEY"), select("field:jevConnection.contextWindow"), input("8192"), select("field:jevConnection.manageOllama"), select("false"), select("field:knowledgePath"), input(custom), select()]);
  assert.ok(!process.env.EDITOR_TEST_KEY); assert.ok(!existsSync(custom));
  await _edit([select("field:knowledgePath"), input(""), select()]);
  assert.ok(!Object.hasOwn(JSON.parse(readFileSync(path, "utf8")), "knowledgePath"));
  const oldRoot = join(home, "old-vault", "pi-session-memory");
  const oldStorage = { ...baseline, consultation: { ...baseline.consultation, knowledgePath: join(home, "inactive") }, obsidianExportEnabled: true, obsidianVaultPath: dirname(oldRoot) };
  delete (oldStorage as any).knowledgePath;
  writeFileSync(path, JSON.stringify(oldStorage));
  const oldStorageBytes = readFileSync(path, "utf8");
  await _edit([select("field:knowledgePath"), input(), select()]);
  assert.equal(readFileSync(path, "utf8"), oldStorageBytes, "Esc never converts retired storage settings");
  await _edit([select("field:knowledgePath"), input(oldRoot), select()]);
  const repairedStorage = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(repairedStorage.knowledgePath, oldRoot);
  assert.ok(!Object.hasOwn(repairedStorage, "obsidianExportEnabled"));
  assert.ok(!Object.hasOwn(repairedStorage, "obsidianVaultPath"));
  assert.deepEqual(repairedStorage.consultation, { ...baseline.consultation, turnThreshold: 5 });
  assert.deepEqual(repairedStorage.customLegacySetting, baseline.customLegacySetting);
  assert.ok(!existsSync(oldRoot));
  const proposal = completeConfigDraft(createConfigDraft({ recallLimit: 0 })); assert.equal(proposal.recallLimit, 0);
  assert.throws(() => completeConfigDraft(createConfigDraft({ consultation: null })));
  const draft = createConfigDraft(null); setConfigFieldValue(draft, field("jevConnection.manageOllama"), false);
  assert.throws(() => completeConfigDraft(draft));
  process.env[DISCUSSION_TURN_THRESHOLD_ENV] = "bad";
  const badOverrideBytes = readFileSync(path, "utf8");
  await assert.rejects(_edit([select("field:recallLimit"), input("9")]));
  assert.equal(readFileSync(path, "utf8"), badOverrideBytes); delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];

  _reset();
  await assert.rejects(_edit([select("field:recallLimit"), { method: "input", answer: "7", check: () => writeFileSync(path, JSON.stringify({ ...baseline, recallLimit: 99 })) }]));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).recallLimit, 99);
  await assert.rejects(editMemoryConfiguration({ hasUI: false } as any));
  process.env.EDITOR_TEST_KEY = "never-display-this-secret";
  const environmentBefore = { ...process.env };
  const editorBytes = readFileSync(path, "utf8");
  const onlyFields = await _edit([{ method: "select", check: (_title, rows) => assert.ok(!rows!.some(row => row.includes(process.env.EDITOR_TEST_KEY!))) }]);
  assert.deepEqual(onlyFields.notifications, [], "opening the editor does not display environment help");
  await assert.rejects(_edit([select("Environment")]));
  assert.equal(readFileSync(path, "utf8"), editorBytes, "opening or rejecting the removed entry does not write configuration");
  assert.deepEqual({ ...process.env }, environmentBefore, "editing never changes environment variables");
  delete process.env.EDITOR_TEST_KEY;
  writeFileSync(path, "malformed JSON"); await assert.rejects(_edit([]), SyntaxError);
  assert.equal(readFileSync(path, "utf8"), "malformed JSON"); assert.ok(!existsSync(process.env.MEMORY_DB_PATH!));

  const extension = (await import("../extensions/index.ts")).default;
  const commands: any[] = [];
  let allowSetupRequest = false;
  const setupRequests: string[] = [];
  extension({
    on() {},
    registerTool() {},
    registerCommand(name: string, options: any) {
      commands.push({ name, options });
    },
    sendUserMessage(message: string) {
      assert.ok(allowSetupRequest,
        "Direct editing must not send an Agent setup request");
      setupRequests.push(message);
    },
  } as any);
  rmSync(path);
  const memoryCommand = commands.find(command => command.name === "pi-session-memory")!;
  const menuSteps = [select("Edit configuration"), select()];
  await memoryCommand.options.handler("", _ui(menuSteps)); assert.equal(menuSteps.length, 0); assert.ok(!existsSync(path));
  assert.deepEqual(setupRequests, [], "direct editing sends no setup request");
  allowSetupRequest = true;
  const setupSteps = [select("Agentic setup")];
  await memoryCommand.options.handler("", _ui(setupSteps));
  assert.equal(setupSteps.length, 0);
  assert.equal(setupRequests.length, 1);
  assert.ok(!existsSync(path), "Agentic setup does not save configuration");
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!),
    "Agentic setup does not initialize history");
  console.log("config editor tests passed: immediate per-field saves, Esc semantics, defaults and strict validation, conditional prerequisites, environment overrides, stale-write rejection, no history/service/credential effects");
} finally { delete process.env[DISCUSSION_TURN_THRESHOLD_ENV]; delete process.env.EDITOR_TEST_KEY; rmSync(home, { recursive: true, force: true }); }
