import assert from "node:assert/strict";
import { filterRecallWithJev } from "../src/jev-filter.ts";
import type { RecallTurnResult } from "../src/retriever.ts";

interface CapturedRequest {
  state: { userQuestion: string };
  questions: Record<string, { instructions: string }>;
}
const requests: CapturedRequest[] = [];
const runtime = {
  selectedModel() { return "tev1:0.8b"; },
  contextWindow() { return 2_050; },
  client() {
    return {
      async systemOne(request: CapturedRequest) {
        requests.push(request);
        return {
          answers: Object.fromEntries(Object.entries(request.questions).map(([key, value]) => [
            key,
            { noul: value.instructions.includes("User: retain") ? 0.9 : 0.1 },
          ])),
        };
      },
    };
  },
} as any;

function turn(index: number, prefix = index % 2 === 0 ? "retain" : "reject"): RecallTurnResult {
  return {
    turn_id: `turn-${index}`,
    session_id: "session",
    turn_index: index,
    source: "pi",
    cwd: "/project",
    ts: index,
    user_text: `${prefix}-${index}-${"中".repeat(1_500)}`,
    reply_text: "答".repeat(1_500),
    score: 1,
  };
}

const candidates = Array.from({ length: 70 }, (_, index) => turn(index));
const filtered = await filterRecallWithJev(runtime, "哪些记录真正相关？", candidates);

assert.ok(requests.length > 1, "large recall input must be split across requests");
assert.ok(requests.every((request) => Object.keys(request.questions).length <= 64), "each request must contain at most 64 segment questions");
assert.ok(requests.every((request) => request.state.userQuestion === "哪些记录真正相关？"), "every request must retain the complete user question as shared state");
assert.ok(requests.every((request) => Buffer.byteLength(JSON.stringify(request), "utf8") <= 2_050 - 256 - Buffer.byteLength("哪些记录真正相关？", "utf8")), "each request must fit the selected model's effective context window");
assert.deepEqual(filtered.results.map(({ turn_index }) => turn_index), candidates.filter(({ turn_index }) => turn_index % 2 === 0).map(({ turn_index }) => turn_index), "filtering must preserve literal candidate order");
assert.deepEqual(filtered.filteredOut.map(({ turn, noul }) => [turn.turn_index, noul]), candidates.filter(({ turn_index }) => turn_index % 2 === 1).map(({ turn_index }) => [turn_index, 0.1]), "filtered-out evidence must preserve original order and expose noul relevance");
assert.deepEqual(filtered.stats, { status: "filtered", model: "tev1:0.8b", contextWindow: 2_050, reviewed: 70, retained: 35, filtered: 35, truncated: 70 });

requests.length = 0;
const oversized = turn(999, `retain-${"汉".repeat(30_000)}`);
const oversizedResult = await filterRecallWithJev(runtime, "question", [oversized]);
assert.deepEqual(oversizedResult.results, [oversized], "a relevant segment must retain its original unsliced candidate");
assert.ok(requests.flatMap((request) => Object.values(request.questions)).length > 1, "one oversized candidate must be judged in multiple UTF-8-safe segments");
assert.ok(requests.every((request) => Buffer.byteLength(JSON.stringify(request), "utf8") <= 2_050 - 256 - Buffer.byteLength("question", "utf8")));

console.log("jev-filter.test.ts: passed");
