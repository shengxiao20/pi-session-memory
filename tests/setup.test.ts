import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST_SETUP_IMPORT_NOTICE } from "../prompts/guidance.ts";

const home = mkdtempSync(join(tmpdir(), "pi-memory-setup-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "untouched.db");
const { getMemoryConfigPath, getSessionMemoryConfig } = await import("../src/settings/config.ts");
const { readMemorySetup, configureMemory, SETUP_NOTICE } = await import("../src/setup/setup.ts");
const { registerSetupTools } = await import("../src/setup/setup-tools.ts");
const path = getMemoryConfigPath();
const baseline = { recallLimit: 20, recallMode: "normal", jevEnable: false, model: "nimble" };
try {
  const missing = readMemorySetup();
  assert.equal(missing.config_path, path);
  assert.equal(missing.configuration, null);
  assert.ok(existsSync(missing.guide_path), "guide is an external packaged Markdown file");
  assert.ok(!existsSync(path), "reading setup must not create a configuration");
  for (const key of ["recallLimit", "recallMode", "consultation.timeoutMs", "knowledgePath", "jevEnable", "model", "jevConnection.manageOllama", "jevConnection.baseURL", "jevConnection.apiKeyEnv", "jevConnection.contextWindow", "MEMORY_DB_PATH", "OLLAMA_HOST"]) assert.ok(missing.guide.includes(key), `guide explains ${key}`);
  assert.match(missing.guide, /one question per assistant reply/);
  assert.match(missing.guide, /Wait\s+for\s+each\s+answer/);
  assert.match(missing.guide, /Cancellation does not write anything/);
  assert.match(missing.guide, /Save these settings/);
  assert.match(SETUP_NOTICE, /General usage questions do not authorize writes/);
  assert.ok(SETUP_NOTICE.endsWith(POST_SETUP_IMPORT_NOTICE), "setup tools share the post-save import boundary");
  assert.equal([...POST_SETUP_IMPORT_NOTICE.matchAll(/\?/g)].length, 1, "post-setup import asks only one question");
  assert.match(POST_SETUP_IMPORT_NOTICE, /Configuration approval is not import approval/);
  assert.match(POST_SETUP_IMPORT_NOTICE, /Only after import approval, call backfill_memory once/);
  const importHeading = missing.guide.indexOf("## Optional history import after setup");
  assert.ok(importHeading > missing.guide.indexOf("### 7. Review and save"), "optional import follows the final configuration save");
  const importGuide = missing.guide.slice(importHeading);
  for (const required of [
    /complete only after `configure_memory` succeeds/,
    /Saving\s+configuration is not approval to import/,
    /restore sessions that the\s+user manually deleted/,
    /Ask one question: \*\*Import all existing Pi history now\?\*\*/,
    /Wait for a separate\s+explicit answer/,
    /Only after explicit import approval, call `backfill_memory` once/,
    /declines, does not answer, or cancels, do not import/,
    /Do not retry, use a fallback/,
    /failure does not undo the saved\s+configuration/,
    /general\s+usage questions, direct field editing, cancelled setup, or a failed save/,
  ]) assert.match(importGuide, required);
  assert.doesNotMatch(missing.guide, /startup\s+synchronization/);
  assert.match(missing.guide, /Pi startup does not import history/);
  const headings = [...missing.guide.matchAll(/^### (\d+)\./gm)].map(match => Number(match[1]));
  assert.deepEqual(headings, [1, 2, 3, 4, 5, 6, 7], "guide has a fixed question order");
  assert.match(missing.guide, /does not require a timeout or a consultation object/);
  assert.match(missing.guide, /rejected, not automatically migrated/);

  assert.throws(() => configureMemory({ ...baseline, recallLimit: 0 }), /Invalid setup configuration/);
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

  const tools: any[] = []; registerSetupTools(tool => { tools.push(tool); });
  assert.deepEqual(tools.map(tool => tool.name), ["setup_memory", "configure_memory"]);
  for (const tool of tools) { assert.equal(tool.executionMode, "sequential"); assert.match(tool.description, /user/); assert.ok(tool.promptGuidelines.includes(SETUP_NOTICE)); }
  writeFileSync(path, '{"recallLimit":0}');
  const invalid = await tools[0].execute();
  assert.equal(invalid.details.configuration.recallLimit, 0, "guide reading permits explicit semantic repair");
  const written = await tools[1].execute("save", { configuration: baseline });
  assert.equal(written.details.config_path, path);
  assert.match(written.content[0].text, /No history operations or service checks ran/);
  assert.ok(written.content[0].text.endsWith(POST_SETUP_IMPORT_NOTICE), "successful saves return the same independent import instructions");
  assert.doesNotMatch(written.content[0].text, /startup\s+synchronization/);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!), "offering import after a save does not import without separate approval");
  const savedBytes = readFileSync(path, "utf8");
  for (const operation of ["writeFileSync", "renameSync"] as const) {
    const original = fs[operation];
    try {
      let failureCalls = 0;
      fs[operation] = () => { failureCalls++; throw new Error(`Injected ${operation} failure`); };
      syncBuiltinESMExports();
      assert.throws(() => configureMemory({ ...baseline, recallLimit: 99 }), new RegExp(`Injected ${operation} failure`));
      assert.equal(failureCalls, 1, "failed configuration saves do not retry");
      await assert.rejects(tools[1].execute("failed-save", { configuration: { ...baseline, recallLimit: 99 } }), new RegExp(`Injected ${operation} failure`));
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
    writeFileSync(path, value); assert.throws(() => readMemorySetup(), /JSON object/);
  }
  rmSync(path); mkdirSync(path);
  assert.throws(() => readMemorySetup(), /EISDIR/);
  assert.ok(!existsSync(process.env.MEMORY_DB_PATH!));
  console.log("setup tests passed: packaged guide, ordered single-question instructions, read-only entry, validated approved saves, preserved settings, invalid proposals/JSON/storage, no history/service effects");
} finally { rmSync(home, { recursive: true, force: true }); }
