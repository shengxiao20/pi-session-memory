import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMemoryDbPath } from "./db.ts";
import { installMemoryTurnExclusion, type MemoryTurnCleanupCounts } from "./memory-index-policy.ts";

export interface MemoryToolCleanupResult extends MemoryTurnCleanupCounts {
  database_path: string;
  backup_path: string;
}

export interface SessionDeletionResult {
  maximum_turns: number;
  removed_sessions: number;
  removed_turns: number;
  database_path: string;
  backup_path: string;
}

/** Back up the existing index before any purge or migration, then enforce the exact tool-turn policy. */
export function cleanMemoryToolTurns(): MemoryToolCleanupResult {
  return _withIndexBackup("tool-turn-cleanup", "tool-turn cleanup", (db, saveBackup) => {
    saveBackup();
    return installMemoryTurnExclusion(db);
  });
}

/** Delete sessions at or below the inclusive limit, together with their turns, after a verified backup. */
export function deleteSessionsAtOrBelowTurnCount(maximumTurns: number): SessionDeletionResult {
  if (!Number.isSafeInteger(maximumTurns) || maximumTurns < 0) throw new Error("Maximum turns must be a non-negative safe integer");
  return _withIndexBackup("session-deletion", "session deletion", (db, saveBackup) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      saveBackup();
      db.prepare(`
        CREATE TEMP TABLE session_deletion_targets AS
        SELECT sessions.session_id
        FROM sessions LEFT JOIN turns ON turns.session_id = sessions.session_id
        GROUP BY sessions.session_id
        HAVING COUNT(turns.turn_id) <= ?
      `).run(maximumTurns);
      const removedTurns = Number(db.prepare("DELETE FROM turns WHERE session_id IN (SELECT session_id FROM temp.session_deletion_targets)").run().changes);
      const removedSessions = Number(db.prepare("DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM temp.session_deletion_targets)").run().changes);
      db.exec("COMMIT");
      return { maximum_turns: maximumTurns, removed_sessions: removedSessions, removed_turns: removedTurns };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/** Share backup publication, verification and resource cleanup across explicit index deletion operations. */
function _withIndexBackup<T extends object>(suffix: string, action: string, execute: (db: DatabaseSync, saveBackup: () => void) => T): T & { database_path: string; backup_path: string } {
  const databasePath = getMemoryDbPath();
  if (!statSync(databasePath).isFile()) throw new Error(`Memory database must be an existing file: ${databasePath}`);
  const backupDirectory = join(dirname(databasePath), "pi-session-memory", "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = join(backupDirectory, `memory-before-${suffix}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.db`);
  // Do not use getDb(): its initialization already purges legacy turns.
  const db = new DatabaseSync(databasePath);
  try {
    _verifyIntegrity(db);
    const saveBackup = () => {
      // The separate read-only source can copy committed WAL data while the deletion holds its write lock.
      const source = new DatabaseSync(databasePath, { readOnly: true });
      try { source.prepare("VACUUM main INTO ?").run(backupPath); } finally { source.close(); }
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try { _verifyIntegrity(backup); } finally { backup.close(); }
    };
    return { database_path: databasePath, backup_path: backupPath, ...execute(db, saveBackup) };
  } catch (error) {
    throw new Error(`SQLite ${action} failed. Backup target: ${backupPath}`, { cause: error });
  } finally {
    db.close();
  }
}

function _verifyIntegrity(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${JSON.stringify(rows)}`);
}

/** Report only counts and paths; never return the deleted turn bodies. */
export function formatMemoryToolCleanup(result: MemoryToolCleanupResult): string {
  return `[session-memory] SQLite cleanup removed ${result.removed_turns} package-tool turns; ${result.after_turns} turns remain.\nDatabase: ${result.database_path}\nBackup: ${result.backup_path}\nJSONL and saved OKF files are unchanged. Existing model context and compaction summaries are not cleared.`;
}
