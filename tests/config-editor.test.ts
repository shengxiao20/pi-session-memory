import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-config-editor-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "untouched.db");
const { editMemoryConfiguration } = await import("../src/setup/config-editor.ts");
const { CONFIG_FIELDS, completeConfigDraft, createConfigDraft, formatConfigField, parseConfigFieldValue, setConfigFieldValue } = await import("../src/setup/config-fields.ts");
const { readMemorySetup, configureMemory, SETUP_REQUEST } = await import("../src/setup/setup.ts");
const { setupConfigurationSchema } = await import("../src/setup/setup-schema.ts");
const { DISCUSSION_TURN_THRESHOLD_ENV, getDiscussionTurnThreshold, getMemoryConfigPath } = await import("../src/settings/config.ts");
const path = getMemoryConfigPath();
const field = (key: string) => { const result = CONFIG_FIELDS.find(field => field.key === key); assert.ok(result); return result; };
type Step = { method: "select" | "input"; answer?: string; check?: (title: string, choices?: string[]) => void };
function _ui(steps: Step[]) {
  const notifications: string[] = [];
  const next = (method: Step["method"], title: string, choices?: string[]) => {
    const step = steps.shift(); assert.ok(step, `unexpected ${method}: ${title}`); assert.equal(step.method, method);
    if (title.startsWith("Configuration\n")) {
      assert.equal(choices!.length, CONFIG_FIELDS.length, "the editor lists only JSON fields");
      assert.ok(!choices!.includes("Environment"), "no environment-only menu entry remains");
      assert.ok(choices!.every(row => row.includes("(now: ") && !row.includes("(default: ")), "each field row shows now, not default");
    }
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
  const leaves = (schema: any, prefix = ""): string[] => Object.entries(schema.properties).flatMap(([key, value]: [string, any]) => value.properties ? leaves(value, `${prefix}${key}.`) : [`${prefix}${key}`]);
  assert.deepEqual(CONFIG_FIELDS.map(field => field.key).sort(), leaves(setupConfigurationSchema).sort());
  assert.equal(CONFIG_FIELDS.length, 11);
  assert.deepEqual(readMemorySetup().fields, CONFIG_FIELDS);
  await _edit([{ method: "select", check: (title, rows) => {
    assert.ok(title.includes(path)); assert.equal(rows!.length, 11);
    const fields = rows!;
    assert.ok(!rows!.some(row => /Save|Cancel|confirm/.test(row)));
    assert.equal(new Set(fields.map(row => row.indexOf("("))).size, 1, "metadata is aligned in a separate column");
    for (const field of CONFIG_FIELDS) {
      const row = fields.find(row => row.trimStart().startsWith(`${field.key} `)); assert.ok(row);
      assert.match(row, /\s{4,}\((?:required|optional)\)  \(now: .+\)$/);
      assert.ok(row.endsWith(`(now: ${field.defaultValue ?? field.defaultLabel})`), "unset fields display existing defaults or default descriptions");
      assert.ok(row.slice(0, row.indexOf("(now:")).length <= 80, "field labels remain compact; values are not truncated");
      assert.equal(row.startsWith("  "), field.key.includes("."), "nested variables are indented");
      assert.ok(!row.includes(field.description));
    }
  } }]);
  assert.ok(!existsSync(dirname(path)), "menu Esc creates no configuration directory");
  for (const [key, value, expected] of [
    ["recallLimit", 7, "7"], ["recallMode", "normal", "normal"],
    ["consultation.timeoutMs", 9000, "9000"], ["consultation.turnThreshold", 0, "0"],
    ["jevEnable", false, "false"], ["jevEnable", true, "true"],
    ["jevConnection.manageOllama", false, "false"], ["jevConnection.contextWindow", 32768, "32768"],
    ["model", "custom-model", "custom-model"], ["model", "", ""], ["model", null, "null"],
    ["knowledgePath", join(home, "long-current-root", "segment".repeat(20)), join(home, "long-current-root", "segment".repeat(20))],
    ["jevConnection.apiKeyEnv", "EDITOR_TEST_KEY", "EDITOR_TEST_KEY"],
    ["jevConnection.baseURL", "http://127.0.0.1:12345", "http://127.0.0.1:12345"],
  ] as const) {
    const draft = {}; setConfigFieldValue(draft, field(key), value);
    const beforeDraft = JSON.stringify(draft);
    assert.ok(formatConfigField(field(key), draft).endsWith(`(now: ${expected})`), `${key} displays the stored value, including false/0/empty/null/long strings`);
    assert.equal(JSON.stringify(draft), beforeDraft, "display never mutates the draft or inserts defaults");
  }
  await _edit([select("field:recallLimit"), input(), select()]);
  assert.ok(!existsSync(path), "field Esc does not save");
  const initialized = await _edit([select("field:recallLimit"), { method: "input", answer: "", check: title => {
    assert.match(title, /^recallLimit\n  Current: not set/); assert.match(title, /\(required\) \(default: 20/);
  } }, { method: "select", check: (_title, rows) => {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).recallLimit, 20);
    assert.ok(rows!.find(row => row.startsWith("recallLimit "))!.endsWith("(now: 20)"));
  } }]);
  assert.deepEqual(initialized.notifications, ["Saved recallLimit."]);
  const defaults = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(defaults.consultation.timeoutMs, 120000); assert.equal(defaults.consultation.turnThreshold, 5);
  assert.equal(defaults.recallMode, "choice");
  assert.equal(defaults.model, "nimble"); assert.equal(defaults.jevConnection.manageOllama, true);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!)); assert.ok(!existsSync(join(dirname(path), "knowledge")));

  _reset(); const before = readFileSync(path, "utf8");
  await _edit([{ method: "select", check: (_title, rows) => {
    assert.ok(rows!.find(row => row.trimStart().startsWith("consultation.timeoutMs "))!.endsWith("(now: 9000)"));
    assert.ok(rows!.find(row => row.startsWith("knowledgePath "))!.endsWith(`(now: ${baseline.knowledgePath})`));
  } }]);
  assert.equal(readFileSync(path, "utf8"), before, "displaying saved values never rewrites configuration");
  const changedNow = await _edit([select("field:recallLimit"), input("7"), { method: "select", check: (_title, rows) => assert.ok(rows!.find(row => row.startsWith("recallLimit "))!.endsWith("(now: 7)")) }]);
  assert.deepEqual(changedNow.notifications, ["Saved recallLimit."]);
  _reset();
  await _edit([select("field:recallLimit"), input(), select()]);
  assert.equal(readFileSync(path, "utf8"), before);
  const edits = await _edit([select("field:recallLimit"), input("7"), select("field:consultation.turnThreshold"), input("0"), select("field:knowledgePath"), input(""), select("field:recallMode"), select("discussion"), select("field:recallLimit"), { method: "input", check: title => assert.match(title, /Current: 7/) }, select()]);
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
  assert.deepEqual(field("recallMode").choices, ["choice", "normal", "discussion"]);
  assert.equal(field("recallMode").kind, "enum");
  for (const mode of field("recallMode").choices!) assert.equal(parseConfigFieldValue(field("recallMode"), mode), mode);
  for (const raw of ["true", "false", "CHOICE", "normal "]) assert.throws(() => parseConfigFieldValue(field("recallMode"), raw));
  for (const mode of ["choice", "normal", "discussion"]) {
    _reset();
    const changed = await _edit([select("field:recallMode"), { method: "select", answer: mode, check: (title, options) => {
      assert.deepEqual(options, ["choice", "normal", "discussion"]);
      assert.match(title, /Current: "normal"/);
      assert.match(title, /per-call choice never changes this setting/);
    } }, select()]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).recallMode, mode);
    assert.deepEqual(changed.notifications, ["Saved recallMode."]);
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
  await assert.rejects(_edit([select("field:recallLimit"), input("0")]), /recallLimit/);
  await assert.rejects(_edit([select("field:jevConnection.manageOllama"), select("false")]), /apiKeyEnv.*required/);
  await assert.rejects(_edit([select("field:knowledgePath"), input("relative-root")]), /knowledgePath/);
  await assert.rejects(_edit([select("field:knowledgePath"), input(path)]), /not an existing file/);
  assert.equal(readFileSync(path, "utf8"), unchanged, "invalid roots preserve the original configuration");
  const missingRoot = join(home, "missing-knowledge");
  await _edit([select("field:knowledgePath"), input(missingRoot), select()]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).knowledgePath, missingRoot);
  assert.ok(!existsSync(missingRoot), "saving a root does not initialize knowledge");
  _reset(); assert.equal(readFileSync(path, "utf8"), unchanged);
  const custom = join(home, "knowledge-parent", "bundle");
  await _edit([select("field:jevConnection.apiKeyEnv"), input("EDITOR_TEST_KEY"), select("field:jevConnection.contextWindow"), input("8192"), select("field:jevConnection.manageOllama"), select("false"), { method: "select", answer: "field:knowledgePath", check: (_title, rows) => {
    for (const key of ["model", "jevConnection.apiKeyEnv", "jevConnection.contextWindow"]) assert.match(rows!.find(row => row.trimStart().startsWith(`${key} `))!, /\(required\)/);
  } }, input(custom), select()]);
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
  assert.throws(() => completeConfigDraft(createConfigDraft({ consultation: null })), /JSON object/);
  const draft = createConfigDraft(null); setConfigFieldValue(draft, field("jevConnection.manageOllama"), false);
  assert.throws(() => completeConfigDraft(draft), /apiKeyEnv/);
  process.env[DISCUSSION_TURN_THRESHOLD_ENV] = "bad";
  const badOverrideBytes = readFileSync(path, "utf8");
  await assert.rejects(_edit([select("field:recallLimit"), input("9")]), /PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD/);
  assert.equal(readFileSync(path, "utf8"), badOverrideBytes); delete process.env[DISCUSSION_TURN_THRESHOLD_ENV];

  _reset();
  await assert.rejects(_edit([select("field:recallLimit"), { method: "input", answer: "7", check: () => writeFileSync(path, JSON.stringify({ ...baseline, recallLimit: 99 })) }]), /changed while the editor was open/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).recallLimit, 99);
  await assert.rejects(editMemoryConfiguration({ hasUI: false } as any), /requires Pi TUI/);
  process.env.EDITOR_TEST_KEY = "never-display-this-secret";
  const environmentBefore = { ...process.env };
  const editorBytes = readFileSync(path, "utf8");
  const onlyFields = await _edit([{ method: "select", check: (_title, rows) => assert.ok(!rows!.some(row => row.includes(process.env.EDITOR_TEST_KEY!))) }]);
  assert.deepEqual(onlyFields.notifications, [], "opening the editor does not display environment help");
  await assert.rejects(_edit([select("Environment")]), /Unknown configuration editor selection/);
  assert.equal(readFileSync(path, "utf8"), editorBytes, "opening or rejecting the removed entry does not write configuration");
  assert.deepEqual({ ...process.env }, environmentBefore, "editing never changes environment variables");
  delete process.env.EDITOR_TEST_KEY;
  writeFileSync(path, "malformed JSON"); await assert.rejects(_edit([]), SyntaxError);
  assert.equal(readFileSync(path, "utf8"), "malformed JSON"); assert.ok(!existsSync(process.env.MEMORY_DB_PATH!));

  const extension = (await import("../extensions/index.ts")).default;
  const tools: any[] = []; const commands: any[] = [];
  let allowSetupRequest = false;
  const setupRequests: string[] = [];
  extension({
    on() {},
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string, options: any) {
      commands.push({ name, options });
    },
    sendUserMessage(message: string) {
      assert.ok(allowSetupRequest,
        "Direct editing must not send an Agent setup request");
      setupRequests.push(message);
    },
  } as any);
  assert.equal(commands.length, 1); assert.equal(tools.length, 15);
  assert.match(commands[0].options.description, /required\/optional/);
  rmSync(path);
  const menuSteps = [{ method: "select", answer: "Edit configuration", check: (_title: string, rows?: string[]) => assert.deepEqual(rows, ["Agentic setup", "Edit configuration", "Database session management", "Delete sessions by turn count", "Clean indexed tool turns", "Import history"]) }, select()] as Step[];
  await commands[0].options.handler("", _ui(menuSteps)); assert.equal(menuSteps.length, 0); assert.ok(!existsSync(path));
  assert.deepEqual(setupRequests, [], "direct editing sends no setup request");
  allowSetupRequest = true;
  const setupSteps: Step[] = [{
    method: "select",
    answer: "Agentic setup",
    check: (_title, rows) => assert.deepEqual(rows, [
      "Agentic setup", "Edit configuration", "Database session management",
      "Delete sessions by turn count", "Clean indexed tool turns", "Import history",
    ]),
  }];
  await commands[0].options.handler("", _ui(setupSteps));
  assert.equal(setupSteps.length, 0);
  assert.deepEqual(setupRequests, [SETUP_REQUEST]);
  assert.ok(!existsSync(path), "Agentic setup does not save configuration");
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!),
    "Agentic setup does not initialize history");
  console.log("config editor tests passed: immediate per-field saves, no Save/Cancel/confirmation, Esc semantics, aligned short rows, nested indentation, current values, defaults, strict validation, conditional prerequisites, environment overrides, stale-write rejection, no history/service/credential effects");
} finally { delete process.env[DISCUSSION_TURN_THRESHOLD_ENV]; delete process.env.EDITOR_TEST_KEY; rmSync(home, { recursive: true, force: true }); }
