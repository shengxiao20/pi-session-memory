import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-history-turns-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.MEMORY_DB_PATH = join(home, "history.db");
const { getDb, getSession, getSourceFile } = await import("../src/db.ts");
const { syncChangedHistory, backfillAll } = await import("../src/backfill.ts");
const { buildPiTurns } = await import("../src/pi-turns.ts");
const { writeTurn } = await import("../src/writer.ts");
const timestamp = "2026-06-06T12:00:00Z";
const header = { type: "session", version: 3, id: "tree", timestamp, cwd: "/work/tree" };
const message = (id: string, parentId: string | null, role: string, text: string, extra: unknown[] = []): SessionEntry => ({
  type: "message", id, parentId, timestamp,
  message: { role, timestamp: 1, content: [...(text ? [{ type: "text", text }] : []), ...extra] },
}) as SessionEntry;
const tool = (name: string) => ({ type: "toolCall", id: name, name, arguments: {} });
const save = (path: string, records: unknown[]) => writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

try {
  const piRoot = join(home, ".pi", "agent", "sessions");
  mkdirSync(piRoot, { recursive: true });
  const path = join(piRoot, "tree.jsonl");
  const entries: SessionEntry[] = [
    message("u1", null, "user", "Question A"),
    message("a1", "u1", "assistant", "Answer A", [tool("read")]),
    message("u2", "a1", "user", "Question B"),
    message("a2", "u2", "assistant", "Answer B"),
    { type: "custom", id: "metadata", parentId: "u1", timestamp, customType: "test", data: {} },
    message("a1b", "metadata", "assistant", "Alternate answer A", [tool("bash")]),
    message("u3", "a1b", "user", "Interrupted request"),
    message("u4", "u3", "user", "Next request"),
    message("a4", "u4", "assistant", "Next answer"),
    message("u5", null, "user", "Tools only"),
    message("a5", "u5", "assistant", "", [tool("write"), tool("write")]),
    message("image", "a5", "user", "", [{ type: "image", data: "test", mimeType: "image/png" }]),
    message("image-reply", "image", "assistant", "Not evidence for Tools only", [tool("image-tool")]),
    message("u6", "image-reply", "user", "Last interrupted request"),
  ];
  save(path, [header, ...entries]);
  assert.deepEqual(syncChangedHistory().issues, []);
  const stored = getSession("pi:tree");
  assert.deepEqual(stored.turns.map((turn) => [turn.user_message_id, turn.turn_index, turn.reply_text]), [
    ["u1", 0, "Answer A\nAlternate answer A"], ["u2", 1, "Answer B"],
    ["u3", 2, ""], ["u4", 3, "Next answer"], ["u5", 4, ""], ["u6", 6, ""],
  ], "branch replies belong to their closest user ancestor; incomplete turns retain their positions");
  assert.equal(stored.turns[0].tool_names, '["read","bash"]');
  assert.equal(stored.turns[4].tool_names, '["write"]', "tool-only replies survive and names are deduplicated");
  assert.deepEqual(getSession("pi:tree", 2, 3).turns.map((turn) => turn.user_message_id), ["u3", "u4"]);
  assert.equal(syncChangedHistory().skippedFiles, 1);
  assert.deepEqual(buildPiTurns("pi:tree", entries), stored.turns.map((turn) => ({ ...turn })));

  // The real-time writer must use full-history positions and refresh, not ignore, existing turns.
  let branch = entries.slice(0, 2);
  const ctx = { sessionManager: {
    getSessionId: () => "tree", getBranch: () => branch, getEntries: () => entries,
    getHeader: () => header, getCwd: () => header.cwd, getSessionFile: () => path,
  } } as unknown as ExtensionContext;
  writeTurn(ctx);
  assert.deepEqual(getSession("pi:tree"), stored, "live writing from an old branch must not erase alternate replies");
  entries.push(message("a1c", "a1b", "assistant", "Final additional answer", [tool("edit")]));
  branch = [entries[0], entries[5], entries.at(-1)!];
  writeTurn(ctx);
  const updated = getSession("pi:tree").turns[0];
  assert.equal(updated.reply_text, "Answer A\nAlternate answer A\nFinal additional answer");
  assert.equal(updated.tool_names, '["read","bash","edit"]');
  writeTurn(ctx);
  assert.deepEqual(getSession("pi:tree").turns[0], updated, "repeated settled events cannot duplicate text");
  branch = [entries[0], entries[5], entries[6], entries[7], entries[8]];
  writeTurn(ctx);
  assert.equal(getSession("pi:tree").turns[3].turn_index, 3, "active branch position is not the persisted global position");
  save(path, [header, ...entries]);
  const beforeSync = getSession("pi:tree");
  assert.deepEqual(syncChangedHistory().issues, []);
  assert.deepEqual(getSession("pi:tree"), beforeSync, "reimport preserves live incomplete turns, replies, tools, and indices");

  // Parser version changes must invalidate both metadata and content-hash skips.
  getDb().exec("UPDATE source_files SET parser_version = '' WHERE source = 'pi'; DELETE FROM turns WHERE user_message_id = 'u3'");
  assert.equal(syncChangedHistory().pi, 1);
  assert.deepEqual(getSession("pi:tree"), beforeSync);
  const sourceBeforeError = getSourceFile(path);
  save(path, [header, message("orphan", "missing-parent", "assistant", "must not overwrite")]);
  assert.match(syncChangedHistory().issues[0].error, /Invalid Pi parentId/);
  assert.deepEqual(getSession("pi:tree"), beforeSync);
  assert.deepEqual(getSourceFile(path), sourceBeforeError, "invalid tree leaves the prior index and parser metadata intact");
  assert.throws(() => buildPiTurns("pi:tree", [entries[0], entries[0]]), /unique non-empty string/);
  save(path, [header, ...entries]);

  const claudeRoot = join(home, ".claude", "projects");
  const codexRoot = join(home, ".codex", "sessions");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  save(join(claudeRoot, "incomplete.jsonl"), [
    { type: "user", uuid: "c1", sessionId: "incomplete", cwd: "/work", timestamp, message: { role: "user", content: "Interrupted Claude" } },
    { type: "user", uuid: "c2", sessionId: "incomplete", cwd: "/work", timestamp, message: { role: "user", content: "Claude tool request" } },
    { type: "assistant", uuid: "ca2", sessionId: "incomplete", timestamp, message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
    { type: "user", uuid: "c3", sessionId: "incomplete", cwd: "/work", timestamp, message: { role: "user", content: "Final incomplete Claude" } },
  ]);
  save(join(codexRoot, "incomplete.jsonl"), [
    { type: "session_meta", payload: { id: "incomplete", cwd: "/work", timestamp } },
    ...[["d1", "user", "Interrupted Codex"], ["d2", "user", "Next Codex"], ["da2", "assistant", "Codex reply"], ["d3", "user", "Final incomplete Codex"]].map(([id, role, text]) => ({
      type: "response_item", timestamp, payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    })),
  ]);
  assert.deepEqual(syncChangedHistory().issues, []);
  const claude = getSession("claude:incomplete");
  const codex = getSession("codex:incomplete");
  assert.deepEqual(claude.turns.map((turn) => [turn.turn_index, turn.reply_text, turn.tool_names]), [[0, "", null], [1, "", '["Read"]'], [2, "", null]]);
  assert.deepEqual(codex.turns.map((turn) => [turn.turn_index, turn.reply_text]), [[0, ""], [1, "Codex reply"], [2, ""]]);
  getDb().exec("UPDATE source_files SET parser_version = ''; DELETE FROM turns WHERE reply_text = ''");
  const refreshed = syncChangedHistory();
  assert.deepEqual(refreshed.issues, []);
  assert.deepEqual([refreshed.pi, refreshed.claude, refreshed.codex], [1, 1, 1]);
  assert.deepEqual(getSession("pi:tree"), beforeSync);
  assert.deepEqual(getSession("claude:incomplete"), claude);
  assert.deepEqual(getSession("codex:incomplete"), codex);
  assert.deepEqual(backfillAll().issues, []);
  console.log("history-turns.test.ts: branch ownership, live refresh, incomplete turns, stable indices, parser upgrade passed");
} finally {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
}
