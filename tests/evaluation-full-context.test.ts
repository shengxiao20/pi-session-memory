import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, readConfig } from "../evaluation/locomo/config.ts";
import { historyTurns, parseDataset } from "../evaluation/locomo/dataset.ts";
import { evaluateFullContext, summarizeFullContext } from "../evaluation/locomo/full-context.ts";
import { PROMPTS } from "../evaluation/locomo/models.ts";

const temporary = mkdtempSync(join(tmpdir(), "pi-memory-full-context-test-"));
const sample = parseDataset([{ sample_id: "baseline", conversation: {
  session_2: [{ speaker: "Mira", dia_id: "D2:1", text: "We reached Pine Lake.", blip_caption: "A lake" }],
  session_2_date_time: "1:00 pm on 3 May, 2024",
  session_1: [{ speaker: "Kai", dia_id: "D1:1", text: "We leave tomorrow." }],
  session_1_date_time: "1:00 pm on 2 May, 2024",
}, observation: "EXCLUDED_OBSERVATION", summary: "EXCLUDED_SUMMARY", qa: [
  { question: "Where did Mira arrive?", answer: "GOLD_MUST_STAY_IN_JUDGE", category: 1, evidence: ["D2:1"] },
  { question: "When did Kai leave?", answer: "SECOND_GOLD", category: 4, evidence: ["D1:1"] },
] }])[0];
const expected = historyTurns(sample).map(turn => ({ turnId: turn.turnId, text: turn.text, reply: "" }));
let calls = 0;
let mode = "normal";
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const input = JSON.parse(body.messages[1].content);
    const role = Object.entries(PROMPTS).find(([, prompt]) => prompt === body.messages[0].content)?.[0];
    assert(role === "answer" || role === "judge", "Baseline never calls planner");
    calls++;
    if (mode === "http") { response.writeHead(503); response.end("Baseline failure"); return; }
    if (role === "answer") {
      assert.deepEqual(Object.keys(input).sort(), ["question", "turns"]);
      assert.deepEqual(input.turns, expected, "Every raw turn appears in original session order");
      assert(!text.includes("GOLD_MUST_STAY_IN_JUDGE") && !text.includes("SECOND_GOLD"));
      assert(!text.includes("EXCLUDED_OBSERVATION") && !text.includes("EXCLUDED_SUMMARY"));
      assert.equal(body.max_tokens, 1024);
    } else {
      assert.deepEqual(Object.keys(input).sort(), ["gold_answer", "prediction", "question"]);
      assert.equal(input.prediction, "BASELINE_MOCK");
      assert(!("turns" in input));
      assert.equal(body.max_tokens, 4096);
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ finish_reason: mode === "truncated" ? "length" : "stop",
      message: { content: role === "answer" ? "BASELINE_MOCK" : mode === "badgrade" ? '{"correct":"false"}' : '{"correct":false}' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address === "object");
process.env.PI_MEMORY_EVAL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.PI_MEMORY_EVAL_API_KEY = "baseline-test-secret";
process.env.PI_MEMORY_EVAL_ANSWER_MODEL = "mock";
process.env.PI_MEMORY_EVAL_JUDGE_MODEL = "mock";
delete process.env.PI_MEMORY_EVAL_PLANNER_MODEL;
const config = readConfig("evaluation/locomo/config/locomo-full-context-smoke.json");
for (const role of ["planner", "answer", "judge"] as const) {
  const model = config.models[role];
  config.models[role] = { backend: "openai", baseURLEnv: model.baseURLEnv, apiKeyEnv: model.apiKeyEnv, modelEnv: model.modelEnv, maxTokens: model.maxTokens };
}
parseConfig(config);
function directory(name: string) {
  const path = join(temporary, name);
  mkdirSync(path);
  process.env.HOME = process.env.USERPROFILE = join(path, "home");
  process.env.MEMORY_DB_PATH = join(path, "memory.db");
  return path;
}
try {
  const output = directory("completed");
  const results = await evaluateFullContext(sample, config, output);
  assert.equal(calls, 4, "Two questions require only answer and judge");
  assert.equal(results.length, 2);
  assert(results.every(result => result.contextTurnCount === 2 && result.promptTokens === 14 && result.completionTokens === 6));
  assert(results.every(result => !("retrieved" in result) && !("query" in result) && !("evidence" in result)));
  assert(!existsSync(join(output, "memory.db")) && !existsSync(join(output, "home")) && !existsSync(join(output, "ingestion.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(output, "context.json"), "utf8")), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "context-info.json"), "utf8")).includedAnnotations, []);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "model-checks.json"), "utf8")), { planner: null, answer: null, judge: null });
  const summary = summarizeFullContext(results);
  assert.equal(summary.projectJudgeAccuracy, 0, "Mock grades represent no real benchmark score");
  assert.equal(summary.totalPromptTokens, 28);
  assert(!("evidenceRecall" in summary) && !("retrievalMeanMs" in summary));
  const audit = readFileSync(join(output, "model-calls.jsonl"), "utf8");
  assert(!audit.includes("baseline-test-secret"));
  assert.deepEqual(audit.trim().split("\n").map(line => JSON.parse(line).role), ["answer", "judge", "answer", "judge"]);
  await assert.rejects(evaluateFullContext(sample, { ...config, contextCharacterLimit: 10 }, directory("overflow")));
  assert.equal(calls, 4, "Oversized raw context fails before generation");
  mode = "http";
  await assert.rejects(evaluateFullContext(sample, config, directory("http")));
  assert.equal(calls, 5, "HTTP failure has no retry or retrieval fallback");
  mode = "truncated";
  const truncated = directory("truncated");
  await assert.rejects(evaluateFullContext(sample, config, truncated));
  assert.equal(calls, 6, "Truncated answer never calls judge");
  assert(existsSync(join(truncated, "model-calls.jsonl")));
  assert(!existsSync(join(truncated, "results.jsonl")));
  mode = "badgrade";
  const bad = directory("badgrade");
  await assert.rejects(evaluateFullContext(sample, config, bad));
  assert.equal(calls, 8);
  assert(!existsSync(join(bad, "results.jsonl")));
  console.log("evaluation-full-context.test.ts: passed (complete ordered raw context, scoring-only annotations, shared prompts, no planner/database/retrieval, audit and fail-fast errors)");
} finally {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  rmSync(temporary, { recursive: true });
}
