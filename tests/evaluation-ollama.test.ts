import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelIdentity, parseConfig, readConfig, resolveModel, type ResolvedModels } from "../evaluation/config.ts";
import { complete, parseGrade } from "../evaluation/models.ts";
import { inspectModels } from "../evaluation/ollama.ts";

const config = readConfig("evaluation/config/locomo-smoke.json");
assert.equal(config.models.planner.backend, "ollama");
assert.equal(config.models.answer.maxTokens, 1024);
assert.equal(config.models.judge.maxTokens, 4096);
for (const [field, value, expected] of [
  ["backend", undefined, /backend/], ["thinking", null, /explicit/], ["thinking", " ", /explicit/],
  ["contextWindow", 512, /contextWindow/], ["maxTokens", 0, /Assertion/],
] as const) {
  const invalid = structuredClone(config);
  Object.assign(invalid.models.planner, { [field]: value });
  assert.throws(() => parseConfig(invalid), expected);
}
const invalidBackend = structuredClone(config);
Object.assign(invalidBackend.models.planner, { backend: "openai" });
assert.throws(() => parseConfig(invalidBackend), /Ollama controls/);

let scenario = "success";
const paths: string[] = [];
let generations = 0;
const server = createServer(async (request, response) => {
  try {
    paths.push(request.url!);
    response.setHeader("Content-Type", "application/json");
    if (scenario === "http-error") { response.writeHead(503); response.end("fixture failure"); return; }
    if (scenario === "invalid-json") { response.end("invalid JSON"); return; }
    if (request.url === "/api/version") {
      response.end(JSON.stringify({ version: scenario === "old-server" ? "0.34.4" : "0.35.0" })); return;
    }
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: scenario === "missing-model" ? [] : [{ name: "fixture:q4", digest: "a".repeat(64) }] })); return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, "fixture:q4");
    if (request.url === "/api/show") {
      response.end(JSON.stringify({ capabilities: scenario === "embedding-only" ? ["embedding"] : ["completion", "thinking"],
        thinking: scenario === "missing-thinking" ? undefined : { values: [false, "low", "medium", "xhigh"], default: "xhigh" },
        model_info: { "general.architecture": "qwen38", "qwen38.context_length": 131072 } })); return;
    }
    assert.equal(request.url, "/api/chat");
    generations++;
    assert.equal(body.truncate, false);
    assert.equal(body.shift, false);
    assert.equal(body.stream, false);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.options.num_ctx, 32768);
    assert.equal(body.options.num_predict, body.think === "low" ? 4096 : 512);
    assert.equal(body.format, "json");
    const result = { model: "fixture:q4", message: { content: '{"correct":true}', thinking: body.think === "low" ? "Fixture reasoning" : "" },
      done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 7 };
    if (scenario === "truncated") result.done_reason = "length";
    if (scenario === "interrupted") result.done = false;
    if (scenario === "wrong-model") result.model = "other:q4";
    if (scenario === "empty") result.message.content = "";
    if (scenario === "unexpected-thinking") result.message.thinking = "Unexpected reasoning";
    if (scenario === "missing-usage") Reflect.deleteProperty(result, "eval_count");
    if (scenario === "invalid-usage") result.eval_count = -1;
    if (scenario === "context-overflow") result.prompt_eval_count = 32768;
    if (scenario === "output-overflow") result.eval_count = 513;
    response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
assert(address && typeof address === "object");
const baseURL = `http://127.0.0.1:${address.port}`;
const models: ResolvedModels = {
  planner: { backend: "ollama", baseURL, apiKey: "fixture-key", model: "fixture:q4", maxTokens: 512, thinking: false, contextWindow: 32768 },
  answer: { backend: "ollama", baseURL, apiKey: "fixture-key", model: "fixture:q4", maxTokens: 1024, thinking: false, contextWindow: 32768 },
  judge: { backend: "ollama", baseURL, apiKey: "fixture-key", model: "fixture:q4", maxTokens: 4096, thinking: "low", contextWindow: 32768 },
};
const temporary = mkdtempSync(join(tmpdir(), "pi-memory-ollama-test-"));
const audit = join(temporary, "model-calls.jsonl");
try {
  const checks = await inspectModels(models, 1000);
  assert.deepEqual(paths, ["/api/version", "/api/tags", "/api/show"]);
  assert.equal(checks.planner!.digest, "a".repeat(64));
  assert.equal(checks.judge!.serverVersion, "0.35.0");
  assert.deepEqual(checks.answer!.thinking.values, [false, "low", "medium", "xhigh"]);
  assert.equal(generations, 0);
  assert(!JSON.stringify(modelIdentity(models.judge)).includes("fixture-key"));
  for (const [mode, expected] of [["old-server", />=0.35.0/], ["missing-model", /installed Ollama/],
    ["missing-thinking", /thinking.values/], ["embedding-only", /completion capability/],
    ["http-error", /HTTP 503/], ["invalid-json", /JSON/]] as const) {
    scenario = mode;
    const before = paths.length;
    await assert.rejects(() => inspectModels(models, 1000), expected);
    assert.equal(paths.length - before, ["old-server", "http-error", "invalid-json"].includes(mode) ? 1 : mode === "missing-model" ? 2 : 3);
    assert.equal(generations, 0, "Preflight errors prevent generation");
  }
  scenario = "success";
  const unsupported = structuredClone(models);
  assert(unsupported.judge.backend === "ollama");
  unsupported.judge.thinking = "high";
  await assert.rejects(() => inspectModels(unsupported, 1000), /Unsupported think/);
  unsupported.judge.thinking = "low";
  unsupported.judge.contextWindow = 131073;
  await assert.rejects(() => inspectModels(unsupported, 1000), /exceeds model limit/);
  assert.equal(generations, 0);
  const generic: ResolvedModels = { planner: { backend: "openai", baseURL: `${baseURL}/v1`, apiKey: "fixture-key", model: "generic", maxTokens: 512 },
    answer: { backend: "openai", baseURL: `${baseURL}/v1`, apiKey: "fixture-key", model: "generic", maxTokens: 512 },
    judge: { backend: "openai", baseURL: `${baseURL}/v1`, apiKey: "fixture-key", model: "generic", maxTokens: 512 } };
  const beforeGeneric = paths.length;
  assert.deepEqual(await inspectModels(generic, 1000), { planner: null, answer: null, judge: null });
  assert.equal(paths.length, beforeGeneric, "Explicit OpenAI backend avoids Ollama discovery");
  for (const role of ["planner", "judge"] as const) {
    const completion = await complete(models[role], { role, questionIndex: 0, input: { question: "fixture" }, json: true }, 1000, audit);
    assert.equal(parseGrade(completion.content), true);
    assert.equal(completion.thinking, role === "judge" ? "Fixture reasoning" : "");
    assert.deepEqual(completion.usage, { promptTokens: 11, completionTokens: 7 });
  }
  for (const [mode, expected] of [["truncated", /truncated or interrupted/], ["interrupted", /completed Ollama/],
    ["wrong-model", /different model/], ["empty", /Empty model/], ["unexpected-thinking", /despite think=false/],
    ["missing-usage", /Missing completion token/], ["invalid-usage", /Missing completion token/],
    ["context-overflow", /exceed.*context window/], ["output-overflow", /more tokens/],
    ["http-error", /HTTP 503/], ["invalid-json", /JSON/]] as const) {
    scenario = mode;
    const before = paths.length;
    await assert.rejects(() => complete(models.planner, { role: "planner", questionIndex: 0, input: {}, json: true }, 1000, audit), expected);
    assert.equal(paths.length - before, 1, "Completion errors perform one request without retry or fallback");
  }
  const auditText = readFileSync(audit, "utf8");
  assert(auditText.includes('"done_reason":"length"'), "Truncated responses remain available for auditing");
  assert(auditText.includes("Fixture reasoning"));
  assert(!auditText.includes("fixture-key"));
  const envNames = ["PI_EVAL_TEST_BASE", "PI_EVAL_TEST_KEY", "PI_EVAL_TEST_MODEL"] as const;
  const previous = envNames.map(name => process.env[name]);
  try {
    process.env.PI_EVAL_TEST_BASE = `${baseURL}/v1`;
    process.env.PI_EVAL_TEST_KEY = "fixture-key";
    process.env.PI_EVAL_TEST_MODEL = "fixture:q4";
    assert.throws(() => resolveModel({ backend: "ollama", thinking: false, contextWindow: 32768, maxTokens: 512,
      baseURLEnv: envNames[0], apiKeyEnv: envNames[1], modelEnv: envNames[2] }), /server root/);
  } finally {
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
  console.log("evaluation-ollama.test.ts: passed (explicit thinking, capabilities, budgets, native JSON/usage, audit and fail-fast errors)");
} finally {
  await new Promise<void>((resolveServer, reject) => server.close(error => error ? reject(error) : resolveServer()));
  rmSync(temporary, { recursive: true });
}
