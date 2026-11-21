import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { knowledgeFields, knowledgeTurn } from "./helpers/knowledge-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "pi-unified-knowledge-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "untouched.db");
const { validateMemoryConfig, getMemoryConfigPath, getSessionMemoryConfig } = await import("../src/settings/config.ts");
const { resolveKnowledgePath } = await import("../src/knowledge/knowledge-storage.ts");
const { setupConfigurationSchema } = await import("../src/setup/setup-schema.ts");
const { CONFIG_FIELDS, createConfigDraft } = await import("../src/setup/config-fields.ts");
const { configureMemory, readMemorySetup } = await import("../src/setup/setup.ts");
const { writeMeetingMinutes, writeTranscriptMinutes } = await import("../src/knowledge/meeting-minutes.ts");
const { inspectMemoryKnowledge, readMemoryKnowledge } = await import("../src/knowledge/memory-knowledge.ts");
const path = getMemoryConfigPath();
const defaultRoot = join(dirname(path), "knowledge");
const custom = join(home, "parent", "complete-bundle-root");
const base = { recallLimit: 5, recallMode: "normal" };
const conclusion = { ...knowledgeFields, description: "Unified storage checks", findings: "None", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };

try {
  assert.equal(resolveKnowledgePath(validateMemoryConfig(base)), defaultRoot);
  for (const mode of ["normal", "choice", "discussion"]) {
    const proposal = { ...base, recallMode: mode, knowledgePath: custom, ...(mode === "discussion" ? { consultation: { timeoutMs: 1000 } } : {}) };
    assert.ok(Value.Check(setupConfigurationSchema, proposal));
    const config = validateMemoryConfig(proposal);
    assert.equal(resolveKnowledgePath(config), custom, "the path is the complete root, with no appended subdirectory");
    assert.equal(config.consultation?.timeoutMs, mode === "discussion" ? 1000 : undefined);
  }
  assert.ok(!existsSync(custom)); assert.ok(!existsSync(dirname(path)), "resolution never creates storage or configuration");
  for (const invalid of ["", " ", "relative", "~/knowledge", null, false, 1, []]) {
    assert.throws(() => validateMemoryConfig({ ...base, knowledgePath: invalid }), /knowledgePath/);
  }
  for (const retired of [
    { obsidianExportEnabled: false }, { obsidianExportEnabled: true }, { obsidianVaultPath: custom },
    { consultation: { timeoutMs: 1000, knowledgePath: custom } },
  ]) {
    const proposal = { ...base, knowledgePath: custom, ...retired };
    assert.ok(!Value.Check(setupConfigurationSchema, proposal));
    assert.throws(() => validateMemoryConfig(proposal), /are no longer supported/);
  }
  assert.throws(() => validateMemoryConfig({ ...base, recallMode: "discussion", knowledgePath: custom }), /discussion mode requires consultation/);
  assert.throws(() => validateMemoryConfig({ ...base, knowledgePath: custom, consultation: {} }), /positive integer timeoutMs/);
  assert.equal(CONFIG_FIELDS.length, 11);
  assert.ok(CONFIG_FIELDS.some(field => field.key === "knowledgePath"));
  assert.ok(!CONFIG_FIELDS.some(field => /obsidian|consultation\.knowledgePath/i.test(field.key)));

  configureMemory({ ...base, knowledgePath: custom });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...base, knowledgePath: custom });
  assert.equal(getSessionMemoryConfig().consultation, undefined);
  assert.deepEqual(inspectMemoryKnowledge().directories, []);
  assert.equal(inspectMemoryKnowledge().knowledge_root, custom);
  assert.ok(!existsSync(custom), "saving configuration and inspecting an absent root do not initialize knowledge");

  // Existing knowledge is reusable in place, independent of consultation settings.
  const saved = new Map<string, string>();
  for (const kind of ["transcript", "consultation"] as const) {
    const record = { id: `unified-${kind}`, question: "Review storage", knowledgePath: resolveKnowledgePath(), evidence: [knowledgeTurn()] };
    const result = kind === "transcript" ? writeTranscriptMinutes(record, conclusion) : writeMeetingMinutes({ ...record, owner: "main", timeoutMs: 1000,
      answers: [{ sessionId: record.evidence[0].session_id, question: "Question", answer: "Original evidence", messageIds: [] }],
    }, conclusion);
    assert.equal(result.path, join(custom, "meetings", conclusion.topic_path, `unified-${kind}`, "minutes.md"));
    for (const name of readdirSync(dirname(result.path))) saved.set(join(dirname(result.path), name), readFileSync(join(dirname(result.path), name), "utf8"));
    assert.equal(readMemoryKnowledge(`unified-${kind}`).markdown, result.markdown);
  }
  assert.ok(!existsSync(defaultRoot), "both output routes use one custom root, without duplicate output");
  const legacy = { ...base, consultation: { timeoutMs: 300000 }, jevEnable: false, unrelated: { keep: true }, obsidianExportEnabled: true, obsidianVaultPath: dirname(custom) };
  (legacy.consultation as any).knowledgePath = join(home, "inactive-root");
  writeFileSync(path, JSON.stringify(legacy));
  const oldBytes = readFileSync(path, "utf8");
  assert.deepEqual(readMemorySetup().configuration, legacy, "setup can inspect retired settings without rewriting them");
  assert.throws(() => resolveKnowledgePath(), /are no longer supported/);
  assert.equal(readFileSync(path, "utf8"), oldBytes, "runtime rejection never migrates old configuration");
  assert.equal(createConfigDraft(legacy).knowledgePath, undefined, "the editor does not infer a root from retired fields");
  const approved = { ...base, consultation: { timeoutMs: 300000 }, jevEnable: false, knowledgePath: custom };
  configureMemory(approved);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...approved, unrelated: legacy.unrelated });
  assert.ok(!Object.hasOwn(getSessionMemoryConfig().consultation!, "turnThreshold"), "approved saves preserve omitted optional values");
  assert.equal(readMemoryKnowledge("unified-transcript").path, join(custom, "meetings", conclusion.topic_path, "unified-transcript", "minutes.md"));
  for (const [file, bytes] of saved) assert.equal(readFileSync(file, "utf8"), bytes, "in-place configuration repair never rewrites minutes, indexes or evidence");

  const before = readFileSync(path, "utf8");
  assert.throws(() => configureMemory({ ...approved, knowledgePath: path }), /not an existing file/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.throws(() => configureMemory({ ...approved, knowledgePath: join(path, "not-a-directory") }), { code: "ENOTDIR" });
  assert.equal(readFileSync(path, "utf8"), before);
  const stat = fs.statSync;
  const failure = Object.assign(new Error("Injected knowledge-directory stat failure"), { code: "EACCES" });
  try {
    Object.assign(fs, { statSync: () => { throw failure; } });
    syncBuiltinESMExports();
    for (const root of [custom, join(home, "missing-root")]) {
      const proposal = { ...approved, knowledgePath: root };
      assert.throws(() => resolveKnowledgePath(validateMemoryConfig(proposal)), error => error === failure);
      assert.throws(() => configureMemory(proposal), error => error === failure);
    }
  } finally { Object.assign(fs, { statSync: stat }); syncBuiltinESMExports(); }
  assert.equal(readFileSync(path, "utf8"), before, "storage errors do not replace the configuration or choose another root");
  configureMemory(base);
  assert.equal(resolveKnowledgePath(), defaultRoot);
  for (const [file, bytes] of saved) assert.equal(readFileSync(file, "utf8"), bytes, "unsetting a custom root does not delete its documents");
  writeFileSync(defaultRoot, "not a directory");
  assert.throws(() => resolveKnowledgePath(), /not an existing file/);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!), "configuration and knowledge operations do not initialize the transcript database");
  console.log("knowledge-storage tests passed: independent root, all modes, both OKF routes, in-place legacy repair, omitted values, no migration/duplicate writes/fallback, read-only resolution and explicit storage errors");
} finally { rmSync(home, { recursive: true, force: true }); }
