import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../evaluation/config.ts";
import { historyTurns, readDataset } from "../evaluation/dataset.ts";
import { PROMPTS } from "../evaluation/models.ts";

// This explicit integration test requires eval:download. All models are local mocks.
const root = resolve(".");
const config = readConfig("evaluation/config/locomo-smoke.json");
assert.equal(readDataset(resolve(config.dataset)).length, 10);
const temporary = mkdtempSync(join(tmpdir(), "pi-memory-locomo-test-"));
const ids = Array.from({ length: 5 }, () => `offline-test-${randomUUID()}`);
const expectedFullContext = historyTurns(readDataset(resolve(config.dataset))[0]).map(turn => ({ turnId: turn.turnId, text: turn.text, reply: "" }));
let fullContextMode = false;
let failPlanner = false;
let incompatibleThinking = false;
let calls = 0;
let metadataCalls = 0;
const digest = "a".repeat(64);
const server = createServer(async (request, response) => {
  try {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") { metadataCalls++; response.end(JSON.stringify({ version: "0.35.0" })); return; }
    if (request.url === "/api/tags") { metadataCalls++; response.end(JSON.stringify({ models: [{ name: "offline:q4", digest }] })); return; }
    if (request.url === "/api/ps") {
      response.end(JSON.stringify({ models: [{ name: "offline:q4", size: 17000000000, size_vram: 17000000000, context_length: 65536 }] })); return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, "offline:q4");
    if (request.url === "/api/show") {
      metadataCalls++;
      response.end(JSON.stringify({ capabilities: ["completion", "thinking"], thinking: incompatibleThinking ? { values: [false], default: false } : { values: [false, "low", "medium", "xhigh"], default: "xhigh" },
        model_info: { "general.architecture": "qwen38", "qwen38.context_length": 131072 } }));
      return;
    }
    assert.equal(request.url, "/api/chat");
    assert.equal(body.stream, false);
    assert.equal(body.truncate, false);
    assert.equal(body.shift, false);
    assert.equal(body.options.num_ctx, 65536);
    assert.equal(body.options.temperature, 0);
    const input = JSON.parse(body.messages[1].content);
    const role = Object.entries(PROMPTS).find(([, prompt]) => prompt === body.messages[0].content)?.[0];
    assert(role);
    assert.equal(body.think, role === "judge" ? "low" : false);
    assert.equal(body.options.num_predict, config.models[role as keyof typeof config.models].maxTokens);
    assert.equal(body.format, role === "answer" ? undefined : "json");
    calls++;
    if (failPlanner) { response.writeHead(503); response.end("Offline test failure"); return; }
    let content: string;
    if (role === "planner") {
      assert.deepEqual(Object.keys(input), ["question"]);
      const name = input.question.match(/\b(?:Caroline|Melanie)\b/);
      assert(name, "Smoke questions contain a speaker name");
      content = JSON.stringify({ entities: [name[0]], primary_entity: name[0] });
    } else if (role === "answer") {
      assert.deepEqual(Object.keys(input).sort(), ["question", "turns"]);
      if (fullContextMode) assert.deepEqual(input.turns, expectedFullContext, "Baseline includes every raw utterance");
      else assert(input.turns.length > 0 && input.turns.length <= config.memory.recallLimit);
      content = "OFFLINE_MOCK_RESPONSE";
    } else {
      assert.equal(role, "judge");
      assert.equal(input.prediction, "OFFLINE_MOCK_RESPONSE");
      content = '{"correct":false}';
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ model: "offline:q4", message: { content, ...(role === "judge" ? { thinking: "Fixture reasoning" } : {}) },
      done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 3 }));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
assert(address && typeof address === "object");
const env: NodeJS.ProcessEnv = { ...process.env, PI_MEMORY_EVAL_BASE_URL: `http://127.0.0.1:${address.port}`,
  PI_MEMORY_EVAL_API_KEY: "offline-fixture-key", PI_MEMORY_EVAL_PLANNER_MODEL: "offline:q4",
  PI_MEMORY_EVAL_ANSWER_MODEL: "offline:q4", PI_MEMORY_EVAL_JUDGE_MODEL: "offline:q4" };
const configPath = join(temporary, "config.json");
writeFileSync(configPath, JSON.stringify(config));
function command(args: string[]): Promise<{ code: number | null; output: string; }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "evaluation/cli.ts", ...args], { cwd: root, env });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolveChild({ code, output }));
  });
}
try {
  let result = await command(["doctor", "--config", configPath]);
  assert.equal(result.code, 0, result.output);
  assert.equal(calls, 0, "doctor performs no generation calls");
  assert.equal(metadataCalls, 3, "Three roles sharing one model use one version, tags and show request");
  result = await command(["run", "--config", configPath, "--run-id", ids[0]]);
  assert.equal(result.code, 0, result.output);
  assert.equal(calls, 15, "Five questions use planner, answer and judge");
  const run = join(root, "evaluation", "runs", ids[0]);
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.models.answer.model, "offline:q4");
  assert.equal(manifest.models.answer.thinking, false);
  assert.equal(manifest.models.judge.thinking, "low");
  assert.equal(manifest.modelChecks.answer.digest, digest);
  assert.equal(manifest.modelChecks.judge.serverVersion, "0.35.0");
  assert.equal(metadataCalls, 9, "Run and worker each inspect the shared model once");
  assert.deepEqual(JSON.parse(readFileSync(join(run, "sample-0", "model-checks.json"), "utf8")), manifest.modelChecks);
  assert(manifest.sourceSha256["src/recall/recall-workflow.ts"]);
  assert(manifest.sourceSha256["evaluation/pipeline.ts"]);
  assert(manifest.sourceSha256["evaluation/ollama.ts"]);
  assert(manifest.sourceSha256["evaluation/model-http.ts"]);
  assert(!JSON.stringify(manifest).includes("offline-fixture-key"));
  assert(existsSync(join(run, "sample-0", "memory.db")));
  assert(existsSync(join(run, "sample-0", "home", ".pi", "agent", "pi-session-memory", "config.json")));
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  assert.equal(summary.questions, 5);
  assert.equal(summary.projectJudgeAccuracy, 0, "Mock answers carry no real benchmark score");
  assert.equal(summary.totalPromptTokens, 105);
  const checksBeforeDuplicate = metadataCalls;
  result = await command(["run", "--config", configPath, "--run-id", ids[0]]);
  assert.notEqual(result.code, 0, "Existing run throws");
  assert.equal(metadataCalls, checksBeforeDuplicate, "Existing run performs no metadata calls");
  assert.equal(calls, 15, "Existing run performs no model calls");
  failPlanner = true;
  result = await command(["run", "--config", configPath, "--run-id", ids[1]]);
  assert.notEqual(result.code, 0);
  assert.equal(calls, 16, "HTTP errors stop immediately without retries");
  const failedRun = join(root, "evaluation", "runs", ids[1]);
  assert.equal(JSON.parse(readFileSync(join(failedRun, "manifest.json"), "utf8")).status, "failed");
  assert(!existsSync(join(failedRun, "summary.json")), "Failed runs produce no completed score summary");
  result = await command(["run", "--config", configPath, "--run-id", "../unsafe"]);
  assert.notEqual(result.code, 0);
  assert.equal(calls, 16);
  failPlanner = false;
  incompatibleThinking = true;
  result = await command(["run", "--config", configPath, "--run-id", ids[2]]);
  assert.notEqual(result.code, 0);
  assert(result.output.includes("Unsupported think"), result.output);
  assert.equal(calls, 16, "Capability mismatch prevents all generation calls");
  const incompatibleRun = join(root, "evaluation", "runs", ids[2]);
  assert.equal(JSON.parse(readFileSync(join(incompatibleRun, "manifest.json"), "utf8")).status, "failed");
  assert(!existsSync(join(incompatibleRun, "sample-0")), "Capability mismatch prevents worker creation and ingestion");
  assert(!existsSync(join(incompatibleRun, "summary.json")));
  incompatibleThinking = false;
  fullContextMode = true;
  delete env.PI_MEMORY_EVAL_PLANNER_MODEL;
  const baselineConfig = { ...config, contextCharacterLimit: 200000 };
  const baselinePath = join(temporary, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baselineConfig));
  const baselineCalls = calls;
  result = await command(["baseline", "--config", baselinePath, "--run-id", ids[3]]);
  assert.equal(result.code, 0, result.output);
  assert.equal(calls - baselineCalls, 10, "Five baseline questions require only answer and judge; planner environment is absent");
  const baselineRun = join(root, "evaluation", "runs", ids[3]);
  const baselineManifest = JSON.parse(readFileSync(join(baselineRun, "manifest.json"), "utf8"));
  assert.equal(baselineManifest.status, "completed");
  assert.equal(baselineManifest.scenario, "full-context");
  assert(!("planner" in baselineManifest.models));
  assert.equal(baselineManifest.modelChecks.planner, null);
  assert(baselineManifest.sourceSha256["evaluation/scoring.ts"]);
  assert(baselineManifest.sourceSha256["evaluation/full-context.ts"]);
  const baselineSample = join(baselineRun, "sample-0");
  assert(!existsSync(join(baselineSample, "memory.db")) && !existsSync(join(baselineSample, "home")));
  assert(!existsSync(join(baselineSample, "ingestion.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(baselineSample, "context.json"), "utf8")), expectedFullContext);
  const baselineSummary = JSON.parse(readFileSync(join(baselineRun, "summary.json"), "utf8"));
  assert.equal(baselineSummary.questions, 5);
  assert.equal(baselineSummary.totalPromptTokens, 70);
  assert(!("evidenceRecall" in baselineSummary));
  const resources = JSON.parse(readFileSync(join(baselineRun, "resources.json"), "utf8"));
  assert.equal(resources.ollama[0].models[0].context_length, 65536);
  result = await command(["worker", baselineRun, "0"]);
  assert.notEqual(result.code, 0, "Memory worker cannot execute a completed baseline manifest");
  assert(!existsSync(join(baselineSample, "memory.db")));
  writeFileSync(baselinePath, JSON.stringify({ ...baselineConfig, contextCharacterLimit: 10 }));
  const callsBeforeOverflow = calls;
  result = await command(["baseline", "--config", baselinePath, "--run-id", ids[4]]);
  assert.notEqual(result.code, 0);
  assert.equal(calls, callsBeforeOverflow, "Oversized full context fails without model generation or truncation");
  const overflowRun = join(root, "evaluation", "runs", ids[4]);
  assert.equal(JSON.parse(readFileSync(join(overflowRun, "manifest.json"), "utf8")).status, "failed");
  assert(!existsSync(join(overflowRun, "summary.json")) && !existsSync(join(overflowRun, "sample-0", "memory.db")));
  console.log("evaluation-locomo.test.ts: passed (pinned real data, isolated retrieval and full-context CLI workers, no baseline planner/database, provenance, memory snapshot and failure status)");
} finally {
  await new Promise<void>((resolveServer, reject) => server.close(error => error ? reject(error) : resolveServer()));
  for (const id of ids) rmSync(join(root, "evaluation", "runs", id), { recursive: true, force: true });
  rmSync(temporary, { recursive: true });
}
