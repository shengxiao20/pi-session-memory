import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatConfigSummary, withConfigSummary } from "../src/tool-config-summary.ts";
import { DEFAULT_JEV_CONNECTION, type SessionMemoryConfig } from "../src/config.ts";

const config: SessionMemoryConfig = { recallLimit: 20, jevEnable: false, model: "nimble", jevConnection: { ...DEFAULT_JEV_CONNECTION }, obsidianExportEnabled: false };
assert.equal(formatConfigSummary(config, {}), "Config · Jev=off (nimble) · Obsidian=off · manageOllama=on · limit=20\nEnv · MEMORY_DB_PATH=unset · API key=local-placeholder · OLLAMA_HOST=unset (managed override)");
const remoteConfig: SessionMemoryConfig = {
  ...config, jevEnable: true, model: "jev-latest", obsidianExportEnabled: true, obsidianVaultPath: "/private/vault",
  jevConnection: { baseURL: "https://example.com", manageOllama: false, apiKeyEnv: "TEST_JEV_KEY", contextWindow: 4096 },
};
const env = { MEMORY_DB_PATH: "/private/history.db", TEST_JEV_KEY: "secret-never-display", OLLAMA_HOST: "private-host" };
const remoteSummary = formatConfigSummary(remoteConfig, env);
assert.equal(remoteSummary, "Config · Jev=on (jev-latest) · Obsidian=on · manageOllama=off · limit=20\nEnv · MEMORY_DB_PATH=set · TEST_JEV_KEY=set · OLLAMA_HOST=set");
assert.doesNotMatch(remoteSummary, /secret-never-display|private|example\.com/);
assert.match(formatConfigSummary(remoteConfig, {}), /TEST_JEV_KEY=unset/);
assert.match(formatConfigSummary(remoteConfig, { TEST_JEV_KEY: "  " }), /TEST_JEV_KEY=unset/);
assert.equal(formatConfigSummary({ ...config, model: "custom\nmodel" }, {}).split("\n").length, 2, "model whitespace cannot add summary lines");

const home = mkdtempSync(join(tmpdir(), "pi-config-summary-"));
const originalEnv = { ...process.env };
process.env.HOME = process.env.USERPROFILE = home;
const directory = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(directory, { recursive: true });
const configPath = join(directory, "config.json");
writeFileSync(configPath, JSON.stringify(config));
try {
  const details = { evidence: ["original transcript"] };
  const original = { content: [{ type: "text" as const, text: "Original result" }, { type: "image" as const, data: "image", mimeType: "image/png" }], details };
  const tool = withConfigSummary({
    name: "test", label: "Test", description: "Test the config summary decorator", parameters: {} as any,
    async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      assert.equal(id, "call"); assert.deepEqual(params, { topic: "history" }); assert.equal(signal, undefined); assert.equal(ctx, context);
      // Mid-call edits must not make final output disagree with the invocation snapshot.
      writeFileSync(configPath, JSON.stringify(remoteConfig));
      onUpdate?.(original);
      return original;
    },
  });
  const context = {} as any;
  const updates: any[] = [];
  const result = await tool.execute("call", { topic: "history" }, undefined, (update) => updates.push(update), context);
  assert.equal(updates.length, 1);
  assert.equal(result.content.length, 3);
  assert.deepEqual(result.content.slice(0, 2), original.content, "evidence blocks, including images, are unchanged");
  assert.strictEqual(result.details, details, "structured details retain their original identity");
  assert.deepEqual(updates[0], result);
  assert.match((result.content[2] as any).text, /Config · Jev=off/);
  assert.equal(original.content.length, 2, "decorating must not mutate the tool's original result");
  // A second invocation rereads the config rather than using a session-start snapshot.
  const second = await tool.execute("call", { topic: "history" }, undefined, undefined, context);
  assert.match((second.content[2] as any).text, /Config · Jev=on/);

  const failure = new Error("explicit tool failure");
  const failing = withConfigSummary({ name: "failure", label: "Failure", description: "Test error propagation", parameters: {} as any, async execute() { throw failure; } });
  await assert.rejects(failing.execute("call", {}, undefined, undefined, context), (error) => error === failure);
  writeFileSync(configPath, JSON.stringify({ recallLimit: 0 }));
  await assert.rejects(tool.execute("call", { topic: "history" }, undefined, undefined, context), /Invalid pi-session-memory configuration/);
  console.log("tool-config-summary.test.ts: two-line status, redaction, progress, snapshot, no mutation, errors passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(home, { recursive: true, force: true });
}
