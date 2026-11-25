import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-memory-setup-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "untouched.db");
const { getMemoryConfigPath, getSessionMemoryConfig } = await import("../src/settings/config.ts");
const { readMemorySetup, configureMemory } = await import("../src/setup/setup.ts");
const { registerSetupTools } = await import("../src/setup/setup-tools.ts");
const path = getMemoryConfigPath();
const baseline = { recallLimit: 20, recallMode: "normal", jevEnable: false, model: "nimble" };
try {
  const missing = readMemorySetup();
  assert.equal(missing.config_path, path);
  assert.equal(missing.configuration, null);
  assert.ok(!existsSync(path), "reading setup must not create a configuration");

  assert.throws(() => configureMemory({ ...baseline, recallLimit: 0 }));
  assert.ok(!existsSync(path), "invalid proposals do not create configuration directories or files");
  const saved = configureMemory(baseline);
  assert.equal(saved.config_path, path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), baseline, "save writes approved settings, not normalized hidden defaults");
  assert.equal(getSessionMemoryConfig().jevConnection.manageOllama, true, "normal runtime reader retains documented defaults");
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!), "configuration saving does not initialize or clean SQLite");

  const unrelated = { customLegacySetting: { keep: true } };
  writeFileSync(path, JSON.stringify({ ...baseline, ...unrelated }));
  configureMemory({ ...baseline, recallLimit: 7 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...baseline, recallLimit: 7, ...unrelated });
  const before = readFileSync(path, "utf8");
  for (const proposal of [
    { ...baseline, MEMORY_DB_PATH: "must-not-save" },
    { ...baseline, apiKey: "must-not-save" },
    { ...baseline, recallMode: "discussion" },
    { ...baseline, recallMode: "invalid" },
    { ...baseline, enableDiscussion: true },
    { ...baseline, consultation: { timeoutMs: 0 } },
    { ...baseline, consultation: { timeoutMs: 1000, knowledgePath: "relative" } },
    { ...baseline, jevEnable: true, model: " " },
    { ...baseline, jevConnection: { baseURL: "https://service.test", manageOllama: true } },
    { ...baseline, jevConnection: { baseURL: "http://127.0.0.1:11434/v1/systemone", manageOllama: true } },
    { ...baseline, jevConnection: { baseURL: "https://service.test", manageOllama: false, apiKey: "must-not-save" } },
    { ...baseline, jevConnection: { baseURL: "https://service.test", manageOllama: false } },
    { ...baseline, obsidianExportEnabled: true },
    { ...baseline, obsidianExportEnabled: true, obsidianVaultPath: join(home, "missing-vault") },
  ]) {
    assert.throws(() => configureMemory(proposal));
    assert.equal(readFileSync(path, "utf8"), before, "invalid proposals leave original bytes unchanged");
  }
  assert.ok(!existsSync(join(home, "missing-vault")), "setup does not create or replace an invalid vault");
  assert.ok(readdirSync(join(home, ".pi", "agent", "pi-session-memory")).every(name => !name.endsWith(".pending")));

  const customRoot = join(home, "custom-knowledge");
  const complete = { ...baseline, recallLimit: 12, recallMode: "discussion", consultation: { timeoutMs: 9000 }, knowledgePath: customRoot, jevEnable: true, model: "tev1:4b", jevConnection: { baseURL: "https://service.test/api", manageOllama: false, apiKeyEnv: "TEST_SETUP_SECRET", contextWindow: 8192 } };
  configureMemory(complete);
  const runtime = getSessionMemoryConfig();
  assert.equal(runtime.consultation!.timeoutMs, 9000);
  assert.deepEqual(runtime.jevConnection, complete.jevConnection);
  assert.ok(!existsSync(customRoot), "saving does not initialize knowledge storage");
  assert.equal(runtime.knowledgePath, customRoot);
  assert.ok(!process.env.TEST_SETUP_SECRET, "saving neither reads nor writes credentials");
  configureMemory({ ...baseline, consultation: { timeoutMs: 9000 } });
  assert.equal(getSessionMemoryConfig().knowledgePath, undefined, "complete replacement can remove the custom root without changing the timeout");

  const tools = new Map<string, any>(); registerSetupTools(tool => tools.set(tool.name, tool));
  const setupTool = tools.get("setup_memory")!;
  const configureTool = tools.get("configure_memory")!;
  writeFileSync(path, '{"recallLimit":0}');
  const invalid = await setupTool.execute();
  assert.equal(invalid.details.configuration.recallLimit, 0, "guide reading permits explicit semantic repair");
  const written = await configureTool.execute("save", { configuration: baseline });
  assert.equal(written.details.config_path, path);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!), "offering import after a save does not import without separate approval");
  const savedBytes = readFileSync(path, "utf8");
  for (const operation of ["writeFileSync", "renameSync"] as const) {
    const original = fs[operation];
    try {
      let failureCalls = 0;
      const failure = new Error("Injected filesystem failure");
      fs[operation] = () => { failureCalls++; throw failure; };
      syncBuiltinESMExports();
      assert.throws(() => configureMemory({ ...baseline, recallLimit: 99 }), error => error === failure);
      assert.equal(failureCalls, 1, "failed configuration saves do not retry");
      await assert.rejects(configureTool.execute("failed-save", { configuration: { ...baseline, recallLimit: 99 } }), error => error === failure);
      assert.equal(failureCalls, 2, "the setup tool rejects once without returning a success or import offer");
    } finally {
      Object.assign(fs, { [operation]: original });
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(path, "utf8"), savedBytes, `${operation} failure preserves the original file`);
    assert.ok(readdirSync(join(home, ".pi", "agent", "pi-session-memory")).every(name => !name.endsWith(".pending")), "failed saves leave no temporary file");
  }
  writeFileSync(path, "malformed JSON");
  assert.throws(() => readMemorySetup(), SyntaxError);
  assert.throws(() => configureMemory(baseline), SyntaxError);
  assert.equal(readFileSync(path, "utf8"), "malformed JSON");
  for (const value of ["null", "[]", "42"]) {
    writeFileSync(path, value); assert.throws(() => readMemorySetup());
  }
  rmSync(path); mkdirSync(path);
  assert.throws(() => readMemorySetup());
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!));
  console.log("setup tests passed: read-only entry, validated saves, preserved settings and failure boundaries");
} finally { rmSync(home, { recursive: true, force: true }); }
