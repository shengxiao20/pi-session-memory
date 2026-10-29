import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_JEV_CONNECTION, getSessionMemoryConfig, type JevConnectionConfig } from "../src/config.ts";
import { JevRuntime } from "../src/jev-runtime.ts";
import { OllamaService } from "../src/ollama-service.ts";
import { filterRecallWithJev } from "../src/jev-filter.ts";

const root = mkdtempSync(join(tmpdir(), "pi-memory-systemone-"));
const env = { ...process.env };
const originalFetch = globalThis.fetch;
const originalEnsureModel = OllamaService.prototype.ensureModel;
const originalShutdown = OllamaService.prototype.shutdown;
const configPath = join(root, ".pi", "agent", "pi-session-memory", "config.json");
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.TEST_DECISION_KEY = "test-secret";
mkdirSync(join(root, ".pi", "agent", "pi-session-memory"), { recursive: true });

function config(value: unknown) {
  writeFileSync(configPath, JSON.stringify(value));
  return getSessionMemoryConfig();
}
const remote: JevConnectionConfig = { baseURL: "https://api.typesafe.ai", apiKeyEnv: "TEST_DECISION_KEY", contextWindow: 4_096, manageOllama: false };

try {
  assert.deepEqual(config({ recallLimit: 2 }).jevConnection, DEFAULT_JEV_CONNECTION);
  for (const baseURL of ["https://api.typesafe.ai", "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode", "http://127.0.0.1:11435"]) {
    const input = { ...remote, baseURL };
    assert.deepEqual(config({ recallLimit: 2, model: "any-decision-model", jevConnection: input }).jevConnection, input);
  }
  assert.deepEqual(config({ recallLimit: 2, jevConnection: { baseURL: "http://localhost:11435/", manageOllama: true } }).jevConnection, { baseURL: "http://localhost:11435/", manageOllama: true });
  for (const jevConnection of [
    null, [], {}, { ...remote, manageOllama: "false" },
    { ...remote, baseURL: "invalid" }, { ...remote, baseURL: "ftp://example.org" },
    { ...remote, baseURL: "https://user:secret@example.org" },
    { ...remote, baseURL: "https://example.org?key=secret" }, { ...remote, baseURL: "https://example.org#fragment" },
    { ...remote, baseURL: "https://example.org/v1/systemone" },
    { ...remote, apiKeyEnv: undefined }, { ...remote, apiKeyEnv: " " }, { ...remote, apiKeyEnv: "bad-name" },
    { ...remote, contextWindow: undefined }, { ...remote, contextWindow: 0 }, { ...remote, contextWindow: 1.5 },
    { ...remote, contextWindow: "4096" }, { ...remote, contextWindow: Number.MAX_SAFE_INTEGER + 1 },
    { ...remote, manageOllama: true },
    { ...remote, baseURL: "https://localhost:11434", manageOllama: true },
    { ...remote, baseURL: "http://localhost:11434/prefix", manageOllama: true },
  ]) assert.throws(() => config({ recallLimit: 2, model: "jev-latest", jevConnection }), /Invalid pi-session-memory configuration/);
  assert.throws(() => config({ recallLimit: 2, jevConnection: remote }), /unmanaged connections require explicit model/);

  let managementCalls = 0;
  let shutdownCalls = 0;
  OllamaService.prototype.ensureModel = async function(model) { managementCalls++; assert.equal(model, "custom-local-model"); return 2_048; };
  OllamaService.prototype.shutdown = function() { shutdownCalls++; };
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.endsWith("/v1/systemone"), `unmanaged requests must not call Ollama management endpoints: ${url}`);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, headers: new Headers(init?.headers), body });
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }])) }), { headers: { "Content-Type": "application/json" } });
  };
  const candidate = { turn_id: "pi:test:turn", session_id: "pi:test", turn_index: 0, source: "pi", cwd: "/work", ts: 1, user_text: "Relevant original history", reply_text: "Original reply", score: 1 };
  for (const [baseURL, model] of [
    ["https://api.typesafe.ai/", "jev-latest"],
    ["https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/", "decision-model-preview"],
    ["http://127.0.0.1:11435", "nimble"],
  ]) {
    const connection = { ...remote, baseURL };
    const runtime = new JevRuntime();
    const before = calls.length;
    assert.deepEqual(await runtime.ensureReady(true, model, connection), { state: "ready" });
    assert.equal(calls.length, before, "remote readiness must not perform model discovery or network probes");
    assert.equal(runtime.contextWindow(), 4_096);
    assert.equal(runtime.selectedModel(), model);
    const result = await filterRecallWithJev(runtime, "Complete user question", [candidate]);
    assert.deepEqual(result.results, [candidate], "the existing filter retains full originals for every backend");
    assert.equal(result.stats.model, model);
    assert.equal(result.stats.status, "filtered");
    const call = calls.at(-1)!;
    assert.equal(call.url, `${baseURL.replace(/\/+$/, "")}/v1/systemone`);
    assert.equal(call.headers.get("Authorization"), "Bearer test-secret");
    assert.equal(call.body.model, model);
    assert.equal(call.body.state.userQuestion, "Complete user question");
    assert.ok(Object.values(call.body.questions).every((question: any) => question.type === "noul"));
    assert.deepEqual(await runtime.ensureReady(true, model, { ...connection }), { state: "ready" });
    await assert.rejects(runtime.ensureReady(true, "different-model", connection), /cannot switch/);
    await assert.rejects(runtime.ensureReady(true, model, { ...connection, baseURL: "https://other.example" }), /connection cannot switch/);
    runtime.markUnavailable(new Error("test request failure"));
    assert.equal((await runtime.ensureReady(true, model, connection)).state, "unavailable", "existing unavailable state remains session-scoped");
    runtime.shutdown();
  }
  assert.equal(managementCalls, 0, "unmanaged Ollama, Jev and Qwen must never invoke local lifecycle management");
  assert.equal(shutdownCalls, 0);

  const disabled = new JevRuntime();
  delete process.env.MISSING_DECISION_KEY;
  assert.deepEqual(await disabled.ensureReady(false, "jev-latest", { ...remote, apiKeyEnv: "MISSING_DECISION_KEY" }), { state: "disabled" });
  assert.throws(() => disabled.client(), /not ready/);
  const missing = new JevRuntime();
  const beforeMissing = calls.length;
  await assert.rejects(missing.ensureReady(true, "jev-latest", { ...remote, apiKeyEnv: "MISSING_DECISION_KEY" }), /environment variable MISSING_DECISION_KEY is missing or empty/);
  assert.equal(missing.status().state, "disabled", "credential errors must not become unavailable fallback");
  process.env.MISSING_DECISION_KEY = " ";
  await assert.rejects(missing.ensureReady(true, "jev-latest", { ...remote, apiKeyEnv: "MISSING_DECISION_KEY" }), /missing or empty/);
  assert.equal(calls.length, beforeMissing);
  await assert.rejects(new JevRuntime().ensureReady(true, "jev-latest", { ...remote, apiKeyEnv: undefined }), /requires apiKeyEnv/);

  const managed = new JevRuntime();
  assert.equal((await managed.ensureReady(true, "custom-local-model", DEFAULT_JEV_CONNECTION)).state, "ready");
  assert.equal(managementCalls, 1);
  assert.equal(managed.contextWindow(), 2_048);
  await managed.client().systemOne({ questions: { relevant: { type: "noul", instructions: "Relevant?" } }, state: "original" });
  assert.equal(calls.at(-1)!.url, "http://127.0.0.1:11434/v1/systemone");
  assert.equal(calls.at(-1)!.headers.get("Authorization"), "Bearer ollama");
  await managed.ensureReady(true, "custom-local-model", DEFAULT_JEV_CONNECTION);
  assert.equal(managementCalls, 1, "local startup is reused");
  managed.shutdown();
  assert.equal(shutdownCalls, 1);
  for (const [contextWindow, expected] of [[1_024, 1_024], [4_096, 2_048]]) {
    const capped = new JevRuntime();
    await capped.ensureReady(true, "custom-local-model", { ...DEFAULT_JEV_CONNECTION, contextWindow });
    assert.equal(capped.contextWindow(), expected, "managed budgets never exceed the actual num_ctx");
    capped.shutdown();
  }
  OllamaService.prototype.ensureModel = async () => { throw new Error("test local startup failure"); };
  assert.deepEqual(await new JevRuntime().ensureReady(true, "nimble", DEFAULT_JEV_CONNECTION), { state: "unavailable", reason: "Error: test local startup failure" });

  // Execute the extracted manager with an isolated CLI fixture: no real Ollama or network needed.
  OllamaService.prototype.ensureModel = originalEnsureModel;
  OllamaService.prototype.shutdown = originalShutdown;
  // Missing CLI errors must reject normally rather than emit an unhandled process error.
  process.env.PATH = join(root, "missing-bin");
  let unhealthyCalls = 0;
  globalThis.fetch = async () => { unhealthyCalls++; return new Response("unavailable", { status: 503 }); };
  const missingService = new OllamaService("http://127.0.0.1:11435");
  await assert.rejects(missingService.ensureModel("nimble"), (error: NodeJS.ErrnoException) => error.code === "ENOENT" && error.message.includes("spawn ollama"));
  assert.equal(unhealthyCalls, 1, "a failed spawn must reject before readiness polling or model commands");
  missingService.shutdown();
  const missingRuntime = new JevRuntime();
  const missingStatus = await missingRuntime.ensureReady(true, "nimble", DEFAULT_JEV_CONNECTION);
  assert.equal(missingStatus.state, "unavailable");
  assert.match(missingStatus.reason!, /spawn ollama ENOENT/);
  missingRuntime.shutdown();

  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "ollama.log");
  process.env.TEST_OLLAMA_LOG = log;
  writeFileSync(join(bin, "ollama"), '#!/bin/sh\nprintf "%s|%s\\n" "$OLLAMA_HOST" "$*" >> "$TEST_OLLAMA_LOG"\ncase "$1" in\n  serve) exit 0 ;;\n  --version) echo "ollama version 0.35.0" ;;\n  pull) exit 0 ;;\n  *) exit 99 ;;\nesac\n');
  chmodSync(join(bin, "ollama"), 0o755);
  process.env.PATH = `${bin}:${env.PATH}`;
  const managementURLs: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    managementURLs.push(url);
    if (url.endsWith("/api/tags")) return new Response("{}");
    assert.equal(url, "http://127.0.0.1:11435/api/show");
    assert.equal(JSON.parse(String(init?.body)).model, "custom-local-model");
    return new Response(JSON.stringify({ parameters: "num_ctx 4096\n" }));
  };
  const service = new OllamaService("http://127.0.0.1:11435/");
  assert.equal(await service.ensureModel("custom-local-model"), 4_096);
  assert.deepEqual(managementURLs, ["http://127.0.0.1:11435/api/tags", "http://127.0.0.1:11435/api/show"]);
  assert.equal(readFileSync(log, "utf8"), "127.0.0.1:11435|--version\n127.0.0.1:11435|pull custom-local-model\n");
  service.shutdown();

  const healthyFetch = globalThis.fetch;
  let startupChecks = 0;
  globalThis.fetch = async (input, init) => {
    // The mocked endpoint becomes ready only after the CLI fixture actually runs.
    // A spawn event does not guarantee the child has executed its first instruction.
    if (String(input).endsWith("/api/tags") && (startupChecks++ === 0 || !readFileSync(log, "utf8").includes("127.0.0.1:11435|serve\n"))) return new Response("not running", { status: 503 });
    return healthyFetch(input, init);
  };
  const startedService = new OllamaService("http://127.0.0.1:11435");
  try {
    assert.equal(await startedService.ensureModel("custom-local-model"), 4_096, "successful spawn must proceed to readiness, version and model checks");
    assert.ok(startupChecks >= 2);
    assert.ok(readFileSync(log, "utf8").endsWith("127.0.0.1:11435|serve\n127.0.0.1:11435|--version\n127.0.0.1:11435|pull custom-local-model\n"));
  } finally { startedService.shutdown(); }
} finally {
  globalThis.fetch = originalFetch;
  OllamaService.prototype.ensureModel = originalEnsureModel;
  OllamaService.prototype.shutdown = originalShutdown;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  rmSync(root, { recursive: true, force: true });
}
console.log("jev-runtime.test.ts: passed");
