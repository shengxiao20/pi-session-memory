import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, readConfig, resolveModel } from "../evaluation/config.ts";
import { historyTurns, parseDataset, readDataset } from "../evaluation/dataset.ts";
import { evidenceMetric, summarize, tokenF1, type QuestionResult } from "../evaluation/metrics.ts";
import { parseGrade, parsePlan } from "../evaluation/models.ts";

const fixture = [{ sample_id: "camping", conversation: {
  speaker_a: "Alice", speaker_b: "Bob", session_1_date_time: "1:56 pm on 8 May, 2023",
  session_1: [{ speaker: "Alice", dia_id: "D1:1", text: "I went camping at Lake Pine.", blip_caption: "a tent by a lake" }],
  session_2_date_time: "1:14 pm on 25 May, 2023", session_2: [{ speaker: "Bob", dia_id: "D2:1", text: "I bought a book." }],
}, qa: [{ question: "Where did Alice go camping?", answer: "Lake Pine", category: 4, evidence: ["D1:1"] }],
observation: { session_1_observation: "PRIVATE_ANNOTATION" }, session_summary: "PRIVATE_SUMMARY" }];

async function worker(directory: string): Promise<void> {
  const config = readConfig(join(directory, "config.json"));
  const { evaluateSample } = await import("../evaluation/pipeline.ts");
  const results = await evaluateSample(parseDataset(fixture)[0], config, directory);
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summarize(results)));
}

async function tests(): Promise<void> {
  const config = readConfig(resolve("evaluation/config/locomo-smoke.json"));
  for (const role of ["planner", "answer", "judge"] as const) {
    const { baseURLEnv, apiKeyEnv, modelEnv, maxTokens } = config.models[role];
    config.models[role] = { backend: "openai", baseURLEnv, apiKeyEnv, modelEnv, maxTokens };
  }
  assert.throws(() => parseConfig({ ...config, categories: [5] }));
  assert.throws(() => parseConfig({ ...config, sampleIndices: [0, 0] }));
  assert.throws(() => parseConfig({ ...config, memory: { ...config.memory, recallMode: "discussion" } }));
  assert.throws(() => parseConfig({ ...config, memory: { ...config.memory, jevConnection: { ...config.memory.jevConnection, manageOllama: true } } }));
  assert.throws(() => resolveModel({ backend: "openai", baseURLEnv: "PI_EVAL_TEST_MISSING_ENV", apiKeyEnv: "PI_EVAL_TEST_MISSING_KEY", modelEnv: "PI_EVAL_TEST_MISSING_MODEL", maxTokens: 5 }));
  assert.throws(() => parseDataset([]));
  assert.throws(() => parseDataset([fixture[0], fixture[0]]));
  const badDate = structuredClone(fixture);
  badDate[0].conversation.session_1_date_time = "1:56 pm on 31 February, 2023";
  assert.throws(() => parseDataset(badDate));
  const history = historyTurns(parseDataset(fixture)[0]);
  assert.equal(history.length, 2);
  assert(history[0].text.includes("Image caption: a tent by a lake"));
  assert.equal(history[0].timestamp, Date.UTC(2023, 4, 8, 13, 56));
  assert(!JSON.stringify(history).includes("PRIVATE_ANNOTATION"));
  assert(!JSON.stringify(history).includes("PRIVATE_SUMMARY"));
  assert(!JSON.stringify(history).includes(fixture[0].qa[0].question));
  assert.equal(tokenF1("the Lake Pine", "Lake Pine"), 1);
  assert.equal(tokenF1("lake lake", "lake"), 2 / 3);
  assert.equal(tokenF1("mountains", "lake"), 0);
  assert.equal(evidenceMetric(["D1:1", "D2:1"], ["D1:1"], new Set(["D1:1", "D2:1"])).recall, 0.5);
  assert.equal(evidenceMetric([], [], new Set()).status, "empty");
  assert.deepEqual(evidenceMetric(["D1:1; D2:1"], ["D1:1"], new Set(["D1:1", "D2:1"])),
    { status: "invalid", invalidIds: ["D1:1; D2:1"], recall: null, complete: null });
  assert.throws(() => parseGrade('{"correct":"true"}'));
  assert.throws(() => parseGrade('{"correct":true,"extra":1}'));
  assert.throws(() => parsePlan('```json\n{}\n```', "question"));
  assert.throws(() => summarize([]));

  const temporary = mkdtempSync(join(tmpdir(), "pi-memory-evaluation-test-"));
  let scenario = "success";
  let jevCalls = 0;
  const calls: { model: string; input: Record<string, unknown>; }[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/v1/systemone") {
        jevCalls++;
        response.writeHead(503);
        response.end("fixture Jev failure");
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-key");
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const input = JSON.parse(body.messages[1].content);
      calls.push({ model: body.model, input });
      assert.equal(body.temperature, 0);
      if (scenario === "http-error") { response.writeHead(503); response.end("fixture model failure"); return; }
      let content: string;
      if (body.model === "fixture-planner") {
        assert.deepEqual(input, { question: fixture[0].qa[0].question });
        content = JSON.stringify({ entities: ["camping", "Alice"], primary_entity: scenario === "invalid-plan" ? "unknown phrase" : "camping" });
      } else if (body.model === "fixture-answer") {
        assert.deepEqual(Object.keys(input).sort(), ["question", "turns"]);
        assert.equal(input.turns.length, 1);
        assert(input.turns[0].text.includes("Lake Pine"));
        assert(!JSON.stringify(input).includes("PRIVATE_"));
        content = "Lake Pine";
      } else {
        assert.equal(body.model, "fixture-judge");
        assert.deepEqual(input, { question: fixture[0].qa[0].question, gold_answer: "Lake Pine", prediction: "Lake Pine" });
        content = '{"correct":true}';
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: scenario === "truncated" ? "length" : "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, PI_MEMORY_EVAL_BASE_URL: `${baseURL}/v1`,
    PI_MEMORY_EVAL_API_KEY: "fixture-key", PI_MEMORY_EVAL_PLANNER_MODEL: "fixture-planner",
    PI_MEMORY_EVAL_ANSWER_MODEL: "fixture-answer", PI_MEMORY_EVAL_JUDGE_MODEL: "fixture-judge" };
  async function launch(name: string, limit = 60000, homeOverride?: string, jev = false): Promise<{ code: number | null; output: string; directory: string; }> {
    const directory = join(temporary, name);
    mkdirSync(directory);
    const testConfig = { ...config, memory: { ...config.memory, recallLimit: 1, jevEnable: jev,
      jevConnection: { ...config.memory.jevConnection, baseURL, apiKeyEnv: "PI_MEMORY_EVAL_API_KEY" } }, contextCharacterLimit: limit };
    writeFileSync(join(directory, "config.json"), JSON.stringify(testConfig));
    return new Promise((resolveChild, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", directory], {
        cwd: process.cwd(), env: { ...env, HOME: homeOverride ?? join(directory, "home"), USERPROFILE: join(directory, "home"), MEMORY_DB_PATH: join(directory, "memory.db") },
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject);
      child.once("exit", code => resolveChild({ code, output, directory }));
    });
  }
  try {
    const invalidFile = join(temporary, "invalid-dataset.json");
    writeFileSync(invalidFile, JSON.stringify(fixture));
    assert.throws(() => readDataset(invalidFile));
    for (const name of ["first", "second"]) {
      const result = await launch(name);
      assert.equal(result.code, 0, result.output);
      const [row] = readFileSync(join(result.directory, "results.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as QuestionResult);
      assert.equal(row.evidence.recall, 1);
      assert.equal(row.retrieved.length, 1);
      assert.equal(row.duplicatesRemoved, 1, "Real global/project recall deduplicates exact turn IDs");
      assert.equal(row.correct, true);
      assert.equal(row.promptTokens, 21);
      assert.equal(row.completionTokens, 9);
      assert.equal(row.retrieved[0].turnId, "camping:D1:1");
      const audit = readFileSync(join(result.directory, "model-calls.jsonl"), "utf8");
      assert(!audit.includes("fixture-key"), "API keys stay outside artifacts");
      assert(!audit.includes("PRIVATE_"), "Annotations stay outside model inputs");
    }
    assert.deepEqual(calls.map(call => call.model), ["fixture-planner", "fixture-answer", "fixture-judge", "fixture-planner", "fixture-answer", "fixture-judge"]);
    let result = await launch("unsafe-home", 60000, tmpdir());
    assert.notEqual(result.code, 0);
    const beforeLimit = calls.length;
    result = await launch("context-limit", 1);
    assert.notEqual(result.code, 0);
    assert.equal(calls.length - beforeLimit, 1, "Context errors prevent answer and judge calls");
    for (const name of ["invalid-plan", "truncated", "http-error"]) {
      scenario = name;
      const before = calls.length;
      result = await launch(name);
      assert.notEqual(result.code, 0);
      assert.equal(calls.length - before, 1, "Errors stop the run without retry or fallback");
    }
    scenario = "jev-error";
    const beforeJev = calls.length;
    result = await launch("jev-error", 60000, undefined, true);
    assert.notEqual(result.code, 0);
    assert(result.output.includes("503"), result.output);
    assert.equal(jevCalls, 1, "Jev errors stop without retry");
    assert.equal(calls.length - beforeJev, 1, "Jev errors prevent answer and judge calls, with no literal-recall fallback");
  } finally {
    await new Promise<void>((resolveServer, reject) => server.close(error => error ? reject(error) : resolveServer()));
    rmSync(temporary, { recursive: true });
  }
  console.log("evaluation.test.ts: passed (isolated real SQLite recall, local mock models, metrics, no-leakage checks and explicit failures)");
}

if (process.argv[2] === "--worker") await worker(process.argv[3]);
else await tests();
