import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-memory-${process.pid}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { getDb, insertTurn, upsertSession } = await import("../src/db.ts");
const { recallTurns } = await import("../src/retriever.ts");

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}

cleanup();

upsertSession({
  session_id: "pi:test",
  source: "pi",
  cwd: "/tmp",
  started_at: 1,
  model_id: null,
  jsonl_path: "/tmp/test.jsonl",
});

assert.equal(insertTurn({
  turn_id: "pi:test:user-1",
  session_id: "pi:test",
  turn_index: 0,
  ts: 1,
  user_text: "literal 100% and a_b",
  reply_text: "first reply",
  tool_names: null,
  user_message_id: "user-1",
}), true);

assert.equal(insertTurn({
  turn_id: "pi:test:user-2",
  session_id: "pi:test",
  turn_index: 1,
  ts: 2,
  user_text: "wildcard 100x and acb",
  reply_text: "second reply",
  tool_names: null,
  user_message_id: "user-2",
}), true);

assert.equal(insertTurn({
  turn_id: "pi:test:user-1",
  session_id: "pi:test",
  turn_index: 0,
  ts: 1,
  user_text: "duplicate",
  reply_text: "duplicate",
  tool_names: null,
  user_message_id: "user-1",
}), false);

assert.deepEqual(recallTurns(["100%"], 10).map((result) => result.turn_id), ["pi:test:user-1"]);
assert.deepEqual(recallTurns(["a_b"], 10).map((result) => result.turn_id), ["pi:test:user-1"]);
assert.equal(getDb().prepare("SELECT count(*) AS count FROM turns").get().count, 2);

cleanup();
console.log("core.test.ts: passed");
