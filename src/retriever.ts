import { getDb } from "./db.ts";

export type HistorySource = "pi" | "claude" | "codex";
export interface RecallOptions { entities: string[]; sources?: HistorySource[]; cwd?: string; after?: number; before?: number; }
export interface RecallTurnResult { turn_id: string; session_id: string; turn_index: number; source: HistorySource; cwd: string; ts: number; user_text: string; reply_text: string; score: number; }

/** Search every matching raw local transcript turn using literal entity alternatives and strict optional scope filters. */
export function recallTurns(options: RecallOptions | string[]): RecallTurnResult[] {
  const normalized = Array.isArray(options) ? { entities: options } : options;
  const terms = normalized.entities.map((entity) => entity.toLowerCase());
  if (terms.length === 0) return [];
  const scoreExpression = terms.map(() => "CASE WHEN instr(lower(turns.user_text || ' ' || turns.reply_text), ?) > 0 THEN 1 ELSE 0 END").join(" + ");
  const filters = ["(" + terms.map(() => "instr(lower(turns.user_text || ' ' || turns.reply_text), ?) > 0").join(" OR ") + ")"];
  const scopedParameters: Array<string | number> = [];
  if (normalized.sources?.length) { filters.push(`sessions.source IN (${normalized.sources.map(() => "?").join(", ")})`); scopedParameters.push(...normalized.sources); }
  if (normalized.cwd !== undefined) { filters.push("sessions.cwd = ?"); scopedParameters.push(normalized.cwd); }
  if (normalized.after !== undefined) { filters.push("turns.ts >= ?"); scopedParameters.push(normalized.after); }
  if (normalized.before !== undefined) { filters.push("turns.ts <= ?"); scopedParameters.push(normalized.before); }
  return getDb().prepare(`SELECT turns.turn_id, turns.session_id, turns.turn_index, sessions.source, sessions.cwd, turns.ts, turns.user_text, turns.reply_text, (${scoreExpression}) AS score FROM turns JOIN sessions ON sessions.session_id = turns.session_id WHERE ${filters.join(" AND ")} ORDER BY score DESC, turns.ts DESC, turns.turn_id`).all(...terms, ...terms, ...scopedParameters) as RecallTurnResult[];
}

/** Render all raw transcript matches without implying that they are persistent summary memories. */
export function formatRecallResults(results: RecallTurnResult[], options: RecallOptions = { entities: [] }): string {
  const header = ["# Recall results", `**Entities:** ${options.entities.map((entity) => `\`${entity}\``).join(", ")}`, `**Results:** ${results.length}`].join("\n");
  const turns = results.length
    ? results.map((turn) => `### Session match · turn ${turn.turn_index}\n**Fetch session ID:** \`${turn.session_id}\` (pass this exact value to \`fetch_session.session_id\`)\n**Source turn ID:** \`${turn.turn_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n")
    : "No matching conversation history.";
  return `${header}\n\n## Matching raw conversation history\n${turns}`;
}
