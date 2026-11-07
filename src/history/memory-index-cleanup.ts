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

/** Back up the existing index before any purge or migration, then enforce the exact tool-turn policy. */
export function cleanMemoryToolTurns(): MemoryToolCleanupResult {
  const databasePath = getMemoryDbPath();
  if (!statSync(databasePath).isFile()) throw new Error(`Memory database must be an existing file: ${databasePath}`);
  const backupDirectory = join(dirname(databasePath), "pi-session-memory", "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = join(backupDirectory, `memory-before-tool-turn-cleanup-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.db`);
  // Do not use getDb(): its initialization already purges legacy turns.
  const db = new DatabaseSync(databasePath);
  try {
    _verifyIntegrity(db);
    // SQLite creates a consistent standalone snapshot, including committed WAL data.
    db.prepare("VACUUM main INTO ?").run(backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { _verifyIntegrity(backup); } finally { backup.close(); }
    return { database_path: databasePath, backup_path: backupPath, ...installMemoryTurnExclusion(db) };
  } catch (error) {
    throw new Error(`SQLite tool-turn cleanup failed. Backup target: ${backupPath}`, { cause: error });
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
