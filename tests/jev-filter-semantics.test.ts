import assert from "node:assert/strict";
import { filterRecallWithJev } from "../src/relevance/jev-filter.ts";
import type { JevRuntime } from "../src/relevance/jev-runtime.ts";
import type { RecallTurnResult } from "../src/contracts/recall.ts";

interface Request {
  state: { userQuestion: string };
  questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
}

function _runtime(contextWindow: number, scores: number[]) {
  const requests: Request[] = [];
  let answerIndex = 0;
  let active = 0;
  const runtime = {
    selectedModel: () => "nimble",
    contextWindow: () => contextWindow,
    client: () => ({
      async systemOne(request: Request) {
        active++;
        assert.equal(active, 1, "batch requests run sequentially");
        requests.push(request);
        try {
          await Promise.resolve();
          return { answers: Object.fromEntries(Object.keys(request.questions).map(key => {
            const value = scores[answerIndex++];
            assert.ok(Number.isFinite(value), "every segment has an explicit fixture score");
            return [key, { noul: value }];
          })) };
        } finally { active--; }
      },
    }),
  } as unknown as JevRuntime;
  return { runtime, requests, answered: () => answerIndex };
}

function _turn(id: string, user: string, reply: string, score: number): RecallTurnResult {
  return { turn_id: id, session_id: "pi:fixture", turn_index: 0, source: "pi", cwd: "/fixture", ts: 0,
    user_text: user, reply_text: reply, score };
}

const question = "原始问题：哪些历史证据能帮助回答？";
const original = [_turn("A", "字".repeat(600), "🙂".repeat(300), 11), _turn("B", "brief", "reply", 7)];
const snapshot = JSON.stringify(original);
const fixture = _runtime(2100, [0.20, 0.80, 0.30, 0.40]);
const result = await filterRecallWithJev(fixture.runtime, question, original);
assert.equal(fixture.answered(), 4);
assert.ok(fixture.requests.length > 1, "the winning segment can be in a later batch");
assert.deepEqual(result.results, [original[0]]);
assert.equal(result.results[0], original[0], "retain the original complete turn object");
assert.deepEqual(result.filteredOut, [{ turn: original[1], noul: 0.40 }]);
assert.deepEqual(result.stats, { status: "filtered", model: "nimble", contextWindow: 2100, reviewed: 2, retained: 1, filtered: 1, truncated: 1 });
assert.equal(JSON.stringify(original), snapshot);
const segments: string[] = [];
for (const request of fixture.requests) {
  assert.equal(request.state.userQuestion, question);
  assert.ok(Object.keys(request.questions).length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(request), "utf8") <= 2100 - 256 - Buffer.byteLength(question, "utf8"));
  for (const value of Object.values(request.questions)) {
    assert.equal(value.type, "noul");
    const match = value.instructions.match(/Segment (\d+) of (\d+)\.\n\n([\s\S]*)$/)!;
    assert.ok(match);
    const segment = match[3];
    assert.ok(Buffer.byteLength(segment, "utf8") <= 1024);
    assert.equal(Buffer.from(segment).toString("utf8"), segment);
    segments.push(segment);
  }
}
assert.equal(segments.slice(0, 3).join(""), `User: ${original[0].user_text}\n\nAssistant: ${original[0].reply_text}`);
assert.equal(segments[3], `User: ${original[1].user_text}\n\nAssistant: ${original[1].reply_text}`);

const boundary = _runtime(100_000, [0.50, 0.90, 0.49]);
const ordered = [_turn("X", "first", "reply", 10), _turn("Y", "second", "reply", 9), _turn("Z", "third", "reply", 8)];
const boundaryResult = await filterRecallWithJev(boundary.runtime, "q", ordered);
assert.deepEqual(boundaryResult.results, [ordered[0], ordered[1]], "inclusive threshold retains original ranking, not Noul ranking");
assert.deepEqual(boundaryResult.filteredOut, [{ turn: ordered[2], noul: 0.49 }]);
assert.equal(boundaryResult.stats.truncated, 0);

const capped = _runtime(100_000, Array(65).fill(0.80));
await filterRecallWithJev(capped.runtime, "q", Array.from({ length: 65 }, (_, index) => _turn(`small-${index}`, "u", "a", 65 - index)));
assert.deepEqual(capped.requests.map(request => Object.keys(request.questions).length), [64, 1]);
const impossible = _runtime(1000, []);
await assert.rejects(filterRecallWithJev(impossible.runtime, "字".repeat(100), [ordered[0]]));
assert.equal(impossible.requests.length, 0);
console.log("Jev filter semantics passed: shared question, UTF-8-safe complete segmentation, sequential bounded batches, cross-batch max, 0.5 threshold, original ranking and audit values.");
