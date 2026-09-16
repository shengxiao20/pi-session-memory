import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const DB_PATH = process.env.MEMORY_DB_PATH ?? join(homedir(), ".pi", "agent", "memory.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'pi',
  cwd         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  model_id    TEXT,
  jsonl_path  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  turn_id     TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(session_id),
  turn_index  INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  user_text   TEXT NOT NULL,
  reply_text  TEXT NOT NULL,
  tool_names  TEXT,
  user_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_turns_ts      ON turns(ts DESC);

CREATE TABLE IF NOT EXISTS memories (
  memory_id         TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK(kind IN ('preference', 'decision', 'fact', 'project_state', 'task', 'lesson')),
  content           TEXT NOT NULL,
  project_key       TEXT NOT NULL,
  source_turn_id    TEXT,
  source_session_id TEXT,
  source_content_hash TEXT,
  source_turn_index INTEGER,
  created_at        INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  importance        REAL NOT NULL,
  superseded_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_key);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by, last_confirmed_at DESC);

CREATE TABLE IF NOT EXISTS source_files (
  jsonl_path TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   REAL NOT NULL,
  sha256     TEXT NOT NULL
);
`;

let _db: DatabaseSync | undefined;

/** Open the singleton SQLite database and ensure its schema is ready for use. */
export function getDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec(SCHEMA);
  _migrate(_db);
  return _db;
}

/** Apply additive schema migrations required by newer memory formats. */
function _migrate(db: DatabaseSync): void {
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "source")) {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'pi'");
  }

  const turnColumns = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
  if (!turnColumns.some((column) => column.name === "user_message_id")) {
    db.exec("ALTER TABLE turns ADD COLUMN user_message_id TEXT");
    db.exec("DELETE FROM turns WHERE user_message_id IS NULL");
    db.exec("DELETE FROM sessions WHERE session_id NOT IN (SELECT DISTINCT session_id FROM turns)");
  }

  const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!memoryColumns.some((column) => column.name === "source_session_id")) {
    db.exec("ALTER TABLE memories ADD COLUMN source_session_id TEXT");
  }
  if (!memoryColumns.some((column) => column.name === "source_content_hash")) {
    db.exec("ALTER TABLE memories ADD COLUMN source_content_hash TEXT");
  }
  if (!memoryColumns.some((column) => column.name === "source_turn_index")) {
    db.exec("ALTER TABLE memories ADD COLUMN source_turn_index INTEGER");
  }
}

export interface SessionRow {
  session_id: string;
  source:     "pi" | "claude" | "codex";
  cwd:        string;
  started_at: number;
  model_id:   string | null;
  jsonl_path: string;
}

export interface TurnRow {
  turn_id:    string;
  session_id: string;
  turn_index: number;
  ts:         number;
  user_text:  string;
  reply_text: string;
  tool_names: string | null;
  user_message_id: string;
}

export interface StoredSession {
  session: SessionRow;
  turns: TurnRow[];
}

export type MemoryKind = "preference" | "decision" | "fact" | "project_state" | "task" | "lesson";

export interface MemoryRow {
  memory_id: string;
  kind: MemoryKind;
  content: string;
  project_key: string;
  source_turn_id: string | null;
  source_session_id: string | null;
  source_content_hash: string | null;
  source_turn_index: number | null;
  created_at: number;
  last_confirmed_at: number;
  importance: number;
  superseded_by: string | null;
}

export interface SourceFileRow {
  jsonl_path: string;
  source: "pi" | "claude" | "codex";
  size: number;
  mtime_ms: number;
  sha256: string;
}

/** Create an explicit durable memory that remains independent from transcript retention. */
export function createMemory(input: Omit<MemoryRow, "memory_id" | "source_session_id" | "source_content_hash" | "source_turn_index" | "created_at" | "last_confirmed_at" | "superseded_by"> & {
  memory_id?: string;
  source_session_id?: string | null;
  source_content_hash?: string | null;
  source_turn_index?: number | null;
  created_at?: number;
  last_confirmed_at?: number;
}): MemoryRow {
  const memory: MemoryRow = {
    memory_id: input.memory_id ?? randomUUID(),
    kind: input.kind,
    content: input.content,
    project_key: input.project_key,
    source_turn_id: input.source_turn_id,
    source_session_id: input.source_session_id ?? null,
    source_content_hash: input.source_content_hash ?? null,
    source_turn_index: input.source_turn_index ?? null,
    created_at: input.created_at ?? Date.now(),
    last_confirmed_at: input.last_confirmed_at ?? input.created_at ?? Date.now(),
    importance: input.importance,
    superseded_by: null,
  };
  getDb().prepare(`
    INSERT INTO memories
      (memory_id, kind, content, project_key, source_turn_id, source_session_id, source_content_hash, source_turn_index, created_at, last_confirmed_at, importance, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.memory_id, memory.kind, memory.content, memory.project_key, memory.source_turn_id, memory.source_session_id, memory.source_content_hash, memory.source_turn_index,
    memory.created_at, memory.last_confirmed_at, memory.importance, memory.superseded_by,
  );
  return memory;
}

/** Promote a historical turn into a durable fact with a permanent provenance reference. */
export function pinTurnAsMemory(turnId: string): MemoryRow {
  const turn = getDb().prepare(`
    SELECT turns.turn_id, turns.session_id, turns.turn_index, turns.user_text, turns.reply_text, sessions.cwd
    FROM turns JOIN sessions ON sessions.session_id = turns.session_id
    WHERE turns.turn_id = ?
  `).get(turnId) as { turn_id: string; session_id: string; turn_index: number; user_text: string; reply_text: string; cwd: string } | undefined;
  if (!turn) throw new Error(`Memory turn not found: ${turnId}`);
  const content = turn.reply_text ? `User: ${turn.user_text}\nAssistant: ${turn.reply_text}` : turn.user_text;
  return createMemory({
    kind: "fact",
    content,
    project_key: turn.cwd,
    source_turn_id: turn.turn_id,
    source_session_id: turn.session_id,
    source_content_hash: _turnContentHash(turn.user_text, turn.reply_text),
    source_turn_index: turn.turn_index,
    importance: 1,
  });
}

/** Hash the exact source evidence copied into a pinned durable memory. */
function _turnContentHash(userText: string, replyText: string): string {
  return createHash("sha256").update(JSON.stringify([userText, replyText])).digest("hex");
}

/** List durable memories, optionally narrowed to one validated memory kind. */
export function listMemories(kind?: MemoryKind): MemoryRow[] {
  const statement = kind
    ? getDb().prepare(`SELECT * FROM memories WHERE kind = ? ORDER BY last_confirmed_at DESC, memory_id`)
    : getDb().prepare(`SELECT * FROM memories ORDER BY last_confirmed_at DESC, memory_id`);
  return (kind ? statement.all(kind) : statement.all()) as MemoryRow[];
}

/** Mark an active memory as recently reviewed without changing its content or provenance. */
export function confirmMemory(memoryId: string): MemoryRow {
  const memory = getDb().prepare("SELECT * FROM memories WHERE memory_id = ? AND superseded_by IS NULL").get(memoryId) as MemoryRow | undefined;
  if (!memory) throw new Error(`Active durable memory not found: ${memoryId}`);
  const last_confirmed_at = Date.now();
  getDb().prepare("UPDATE memories SET last_confirmed_at = ? WHERE memory_id = ?").run(last_confirmed_at, memoryId);
  return { ...memory, last_confirmed_at };
}

/** Explicitly replace one active memory with another while retaining the old record as history. */
export function supersedeMemory(oldMemoryId: string, newMemoryId: string): void {
  if (oldMemoryId === newMemoryId) throw new Error("A memory cannot supersede itself");
  const db = getDb();
  const oldMemory = db.prepare("SELECT memory_id, superseded_by FROM memories WHERE memory_id = ?").get(oldMemoryId) as { memory_id: string; superseded_by: string | null } | undefined;
  const newMemory = db.prepare("SELECT memory_id FROM memories WHERE memory_id = ?").get(newMemoryId) as { memory_id: string } | undefined;
  if (!oldMemory) throw new Error(`Durable memory not found: ${oldMemoryId}`);
  if (!newMemory) throw new Error(`Durable memory not found: ${newMemoryId}`);
  if (oldMemory.superseded_by) throw new Error(`Durable memory is already superseded: ${oldMemoryId}`);
  db.prepare("UPDATE memories SET superseded_by = ? WHERE memory_id = ?").run(newMemoryId, oldMemoryId);
}

/** Return the complete oldest-to-newest replacement chain containing a durable memory. */
export function getMemoryHistory(memoryId: string): MemoryRow[] {
  const db = getDb();
  let current = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId) as MemoryRow | undefined;
  if (!current) throw new Error(`Durable memory not found: ${memoryId}`);
  while (true) {
    const predecessor = db.prepare("SELECT * FROM memories WHERE superseded_by = ?").get(current.memory_id) as MemoryRow | undefined;
    if (!predecessor) break;
    current = predecessor;
  }
  const history = [current];
  while (current.superseded_by) {
    current = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(current.superseded_by) as MemoryRow;
    history.push(current);
  }
  return history;
}

/** Permanently delete one durable memory without altering its source transcript turn. */
export function deleteMemory(memoryId: string): boolean {
  return getDb().prepare("DELETE FROM memories WHERE memory_id = ?").run(memoryId).changes === 1;
}

/** Look up the persisted fingerprint for a source JSONL file. */
export function getSourceFile(jsonlPath: string): SourceFileRow | undefined {
  return getDb().prepare(`
    SELECT jsonl_path, source, size, mtime_ms, sha256
    FROM source_files
    WHERE jsonl_path = ?
  `).get(jsonlPath) as SourceFileRow | undefined;
}

/** Store the latest metadata and content hash for an imported source file. */
export function upsertSourceFile(row: SourceFileRow): void {
  getDb().prepare(`
    INSERT INTO source_files (jsonl_path, source, size, mtime_ms, sha256)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jsonl_path) DO UPDATE SET
      source = excluded.source,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      sha256 = excluded.sha256
  `).run(row.jsonl_path, row.source, row.size, row.mtime_ms, row.sha256);
}

/** Insert session metadata when a source session is first encountered. */
export function upsertSession(row: SessionRow): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO sessions (session_id, source, cwd, started_at, model_id, jsonl_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.session_id, row.source, row.cwd, row.started_at, row.model_id, row.jsonl_path);
}

/** Read one persisted session and an optional inclusive range of its ordered conversation turns. */
export function getSession(sessionId: string, fromTurnIndex?: number, toTurnIndex?: number): StoredSession {
  const session = getDb().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
  if (!session) throw new Error(`Memory session not found: ${sessionId}`);
  const filters = ["session_id = ?"];
  const parameters: Array<string | number> = [sessionId];
  if (fromTurnIndex !== undefined) {
    filters.push("turn_index >= ?");
    parameters.push(fromTurnIndex);
  }
  if (toTurnIndex !== undefined) {
    filters.push("turn_index <= ?");
    parameters.push(toTurnIndex);
  }
  const turns = getDb().prepare(`
    SELECT turn_id, session_id, turn_index, ts, user_text, reply_text, tool_names, user_message_id
    FROM turns
    WHERE ${filters.join(" AND ")}
    ORDER BY turn_index
  `).all(...parameters) as TurnRow[];
  return { session, turns };
}

export interface MemoryStats {
  sessions: number;
  turns: number;
  oldestTs: number | null;
  newestTs: number | null;
  sources: Array<{ source: "pi" | "claude" | "codex"; sessions: number; turns: number }>;
}

/** Summarize locally stored sessions and turns for memory management UI. */
export function getMemoryStats(): MemoryStats {
  const summary = getDb().prepare(`
    SELECT count(*) AS turns, min(ts) AS oldestTs, max(ts) AS newestTs
    FROM turns
  `).get() as { turns: number; oldestTs: number | null; newestTs: number | null };
  const sessionCount = getDb().prepare("SELECT count(*) AS count FROM sessions").get() as { count: number };
  const sources = getDb().prepare(`
    SELECT sessions.source, count(DISTINCT sessions.session_id) AS sessions, count(turns.turn_id) AS turns
    FROM sessions
    LEFT JOIN turns ON turns.session_id = sessions.session_id
    GROUP BY sessions.source
    ORDER BY sessions.source
  `).all() as MemoryStats["sources"];
  return { sessions: sessionCount.count, turns: summary.turns, oldestTs: summary.oldestTs, newestTs: summary.newestTs, sources };
}

/** Permanently remove one turn and clean up its session if it becomes empty. */
export function deleteTurn(turnId: string): boolean {
  const db = getDb();
  const turn = db.prepare("SELECT session_id FROM turns WHERE turn_id = ?").get(turnId) as { session_id: string } | undefined;
  if (!turn) return false;
  // Delete the turn and its now-empty session atomically; a failed cleanup must not leave partial state.
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM turns WHERE turn_id = ?").run(turnId);
    // Session metadata exists only to support its turns, so remove it after the final turn is forgotten.
    db.prepare(`
      DELETE FROM sessions
      WHERE session_id = ?
        AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.session_id)
    `).run(turn.session_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/** Idempotently insert a normalized conversation turn and report whether it was new. */
export function insertTurn(row: TurnRow): boolean {
  const values: Array<string | number | bigint | Uint8Array | null> = [
    row.turn_id, row.session_id, row.turn_index, row.ts,
    row.user_text, row.reply_text, row.tool_names, row.user_message_id,
  ];
  values.forEach((value, index) => _assertSqliteValue(value, index + 1));

  const result = getDb().prepare(`
    INSERT OR IGNORE INTO turns
      (turn_id, session_id, turn_index, ts, user_text, reply_text, tool_names, user_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...values);
  return result.changes === 1;
}

/** Reject unsupported SQLite values before binding them to an INSERT statement. */
function _assertSqliteValue(value: unknown, parameter: number): asserts value is string | number | bigint | Uint8Array | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return;
  throw new TypeError(`SQLite parameter ${parameter} must be string, number, bigint, Uint8Array, or null; received ${typeof value}`);
}
