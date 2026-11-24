import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../evaluation/config.ts";
import { readDataset } from "../evaluation/dataset.ts";

// This explicit integration test requires eval:download. All models are local mocks.
const root = resolve(".");
const config = readConfig("evaluation/config/locomo-smoke.json");
assert.equal(readDataset(resolve(config.dataset)).length, 10);
const temporary = mkdtempSync(join(tmpdir(), "pi-memory-locomo-test-"));
const ids = [randomUUID(), randomUUID()].map(id => `offline-test-${id}`);
let failPlanner = false;
let calls = 0;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const input = JSON.parse(body.messages[1].content);
    calls++;
    if (failPlanner) { response.writeHead(503); response.end("Offline test failure"); return; }
    let content: string;
    if (body.model === "offline-planner") {
      assert.deepEqual(Object.keys(input), ["question"]);
      const name = input.question.match(/\b(?:Caroline|Melanie)\b/);
      assert(name, "Smoke questions contain a speaker name");
      content = JSON.stringify({ entities: [name[0]], primary_entity: name[0] });
    } else if (body.model === "offline-answer") {
      assert.deepEqual(Object.keys(input).sort(), ["question", "turns"]);
      assert(input.turns.length > 0 && input.turns.length <= config.memory.recallLimit);
      content = "OFFLINE_MOCK_RESPONSE";
    } else {
      assert.equal(body.model, "offline-judge");
      assert.equal(input.prediction, "OFFLINE_MOCK_RESPONSE");
      content = '{"correct":false}';
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
assert(address && typeof address === "object");
const env = { ...process.env, PI_MEMORY_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  PI_MEMORY_EVAL_API_KEY: "offline-fixture-key", PI_MEMORY_EVAL_PLANNER_MODEL: "offline-planner",
  PI_MEMORY_EVAL_ANSWER_MODEL: "offline-answer", PI_MEMORY_EVAL_JUDGE_MODEL: "offline-judge" };
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
  assert.equal(calls, 0, "doctor performs no remote calls");
  result = await command(["run", "--config", configPath, "--run-id", ids[0]]);
  assert.equal(result.code, 0, result.output);
  assert.equal(calls, 15, "Five questions use planner, answer and judge");
  const run = join(root, "evaluation", "runs", ids[0]);
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.models.answer.model, "offline-answer");
  assert(manifest.sourceSha256["src/recall/recall-workflow.ts"]);
  assert(manifest.sourceSha256["evaluation/pipeline.ts"]);
  assert(!JSON.stringify(manifest).includes("offline-fixture-key"));
  assert(existsSync(join(run, "sample-0", "memory.db")));
  assert(existsSync(join(run, "sample-0", "home", ".pi", "agent", "pi-session-memory", "config.json")));
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  assert.equal(summary.questions, 5);
  assert.equal(summary.projectJudgeAccuracy, 0, "Mock answers carry no real benchmark score");
  assert.equal(summary.totalPromptTokens, 105);
  result = await command(["run", "--config", configPath, "--run-id", ids[0]]);
  assert.notEqual(result.code, 0, "Existing run throws");
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
  console.log("evaluation-locomo.test.ts: passed (pinned real LoCoMo data, isolated CLI workers, local mock models, run provenance and failure status)");
} finally {
  await new Promise<void>((resolveServer, reject) => server.close(error => error ? reject(error) : resolveServer()));
  for (const id of ids) rmSync(join(root, "evaluation", "runs", id), { recursive: true, force: true });
  rmSync(temporary, { recursive: true });
}
