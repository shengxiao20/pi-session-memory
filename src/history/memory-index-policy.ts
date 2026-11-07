import type { DatabaseSync } from "node:sqlite";

/** Exact current and retired tool names owned by pi-session-memory. No topic or text matching. */
export const SESSION_MEMORY_TOOL_NAMES = [
  "inspect_memory_knowledge", "read_memory_knowledge", "recall_memory", "fetch_session", "review_jev_filtered",
  "follow_up_session", "finish_session_consultation", "finish_memory_recall", "cancel_session_consultation",
  "get_memory_stats", "backfill_memory", "migrate_project_sessions", "clean_memory_tool_turns", "setup_memory", "configure_memory",
  "recall_project_memory", "export_recall_to_obsidian", "migrate_claude_project_sessions", "migrate_codex_project_sessions",
] as const;

/** Exclude an entire indexed turn if its recorded calls include any package tool. Invalid metadata throws. */
export function isMemoryToolTurn(toolNames: string | null): boolean {
  if (toolNames === null) return false;
  const names: unknown = JSON.parse(toolNames);
  if (!Array.isArray(names) || !names.every(name => typeof name === "string")) throw new Error("tool_names must be a JSON array of strings");
  return names.some(name => (SESSION_MEMORY_TOOL_NAMES as readonly string[]).includes(name));
}

/** Counts refer to the same locked cleanup transaction, not the earlier backup snapshot. */
export interface MemoryTurnCleanupCounts { before_turns: number; removed_turns: number; after_turns: number; }

/** Purge existing package-tool turns and enforce exclusion for all SQLite connections, including older writers. */
export function installMemoryTurnExclusion(db: DatabaseSync): MemoryTurnCleanupCounts {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = Number(db.prepare("SELECT count(*) AS count FROM turns").get()!.count);
    for (const row of db.prepare("SELECT tool_names FROM turns").iterate()) isMemoryToolTurn(row.tool_names as string | null);
    db.exec(`
      DROP TRIGGER IF EXISTS pi_session_memory_exclude_insert;
      DROP TRIGGER IF EXISTS pi_session_memory_exclude_update;
      CREATE TRIGGER pi_session_memory_exclude_insert BEFORE INSERT ON turns
      WHEN ${_toolMatch("NEW.tool_names")}
      BEGIN
        DELETE FROM turns WHERE turn_id = NEW.turn_id;
        SELECT RAISE(IGNORE);
      END;
      CREATE TRIGGER pi_session_memory_exclude_update BEFORE UPDATE ON turns
      WHEN ${_toolMatch("NEW.tool_names")}
      BEGIN
        DELETE FROM turns WHERE turn_id = OLD.turn_id;
        SELECT RAISE(IGNORE);
      END;
      DELETE FROM turns WHERE ${_toolMatch("turns.tool_names")};
    `);
    const after = Number(db.prepare("SELECT count(*) AS count FROM turns").get()!.count);
    db.exec("COMMIT");
    return { before_turns: before, removed_turns: before - after, after_turns: after };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function _toolMatch(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) AS tool WHERE tool.value IN (${SESSION_MEMORY_TOOL_NAMES.map(name => `'${name}'`).join(", ")}))`;
}
