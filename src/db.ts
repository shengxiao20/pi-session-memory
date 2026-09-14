import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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

CREATE TABLE IF NOT EXISTS source_files (
  jsonl_path TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   REAL NOT NULL,
  sha256     TEXT NOT NULL
);
`;

let _db: DatabaseSync | undefined;

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

export interface SourceFileRow {
  jsonl_path: string;
  source: "pi" | "claude" | "codex";
  size: number;
  mtime_ms: number;
  sha256: string;
}

export function getSourceFile(jsonlPath: string): SourceFileRow | undefined {
  return getDb().prepare(`
    SELECT jsonl_path, source, size, mtime_ms, sha256
    FROM source_files
    WHERE jsonl_path = ?
  `).get(jsonlPath) as SourceFileRow | undefined;
}

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

export function upsertSession(row: SessionRow): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO sessions (session_id, source, cwd, started_at, model_id, jsonl_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.session_id, row.source, row.cwd, row.started_at, row.model_id, row.jsonl_path);
}

export function insertTurn(row: TurnRow): boolean {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO turns
      (turn_id, session_id, turn_index, ts, user_text, reply_text, tool_names, user_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.turn_id, row.session_id, row.turn_index, row.ts,
    row.user_text, row.reply_text, row.tool_names, row.user_message_id,
  );
  return result.changes === 1;
}
