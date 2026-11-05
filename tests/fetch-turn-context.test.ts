import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-fetch-context-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "history.db");
const { getDb, getHistoryStats, insertTurn, upsertSession } = await import("../src/db.ts");
const { fetchTurnContext } = await import("../src/fetch-turn-context.ts");

try {
  for (const source of ["pi", "claude", "codex"] as const) {
    const sessionId = `${source}:session`;
    upsertSession({ session_id: sessionId, source, cwd: home, started_at: 1, model_id: null, jsonl_path: join(home, `${source}.jsonl`) });
    for (const [index, suffix] of [[0, "first"], [6, "preceding"], [7, "2599a0a9"], [8, "following"], [10, "last"]] as const) {
      insertTurn({ turn_id: `${sessionId}:${suffix}`, session_id: sessionId, turn_index: index, ts: index + 1, user_text: suffix, reply_text: "reply", tool_names: null, user_message_id: suffix });
    }
    const turnId = `${sessionId}:2599a0a9`;
    const targetOnly = fetchTurnContext(turnId, 0, 0);
    assert.equal(targetOnly.target.turn_index, 7, "hash suffix must not be interpreted as a turn index");
    assert.equal(targetOnly.stored.session.session_id, sessionId);
    assert.deepEqual(targetOnly.stored.turns.map((turn) => turn.turn_id), [turnId]);
    assert.deepEqual(fetchTurnContext(turnId, 1, 1).stored.turns.map((turn) => turn.turn_index), [6, 7, 8]);
    assert.deepEqual(fetchTurnContext(turnId, 2, 2).stored.turns.map((turn) => turn.turn_index), [6, 7, 8], "windows use index positions, not row counts");
    const boundary = fetchTurnContext(turnId, 100, 100);
    assert.equal(boundary.fromTurnIndex, 0);
    assert.equal(boundary.toTurnIndex, 107);
    assert.deepEqual(boundary.stored.turns.map((turn) => turn.turn_index), [0, 6, 7, 8, 10]);
    assert.deepEqual(fetchTurnContext(`${sessionId}:first`, 3, 0).stored.turns.map((turn) => turn.turn_index), [0]);
    assert.deepEqual(fetchTurnContext(`${sessionId}:last`, 0, 3).stored.turns.map((turn) => turn.turn_index), [10]);
  }
  const stats = getHistoryStats();
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, "1", null]) {
    assert.throws(() => fetchTurnContext("pi:session:2599a0a9", invalid as number, 0), /before must be/);
    assert.throws(() => fetchTurnContext("pi:session:2599a0a9", 0, invalid as number), /after must be/);
  }
  assert.throws(() => fetchTurnContext("pi:missing:2599a0a9", 0, 0), /History turn not found/);
  assert.throws(() => fetchTurnContext("pi:session", 0, 0), /History turn not found/);
  assert.throws(() => fetchTurnContext("", 0, 0), /turn_id must be/);
  assert.throws(() => fetchTurnContext("pi:session:2599a0a9", 0, Number.MAX_SAFE_INTEGER), /safe integer range/);
  assert.deepEqual(getHistoryStats(), stats, "fetches and rejected requests must leave storage unchanged");
  console.log("fetch-turn-context tests passed");
} finally {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
}
