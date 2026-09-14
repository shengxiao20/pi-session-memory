import { getDb } from "./db.ts";

export interface RecallResult {
  turn_id: string;
  source: "pi" | "claude" | "codex";
  ts: number;
  user_text: string;
  reply_text: string;
  hits: number;
}

export function recallTurns(entities: string[], topK = 5): RecallResult[] {
  if (entities.length === 0) return [];

  const scoreExpression = entities.map(() => `(
    CASE WHEN LOWER(turns.user_text) LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END +
    CASE WHEN LOWER(turns.reply_text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
  )`).join(" + ");
  const scoreParameters = entities.flatMap((entity) => {
    const pattern = _likePattern(entity);
    return [pattern, pattern];
  });

  const whereExpression = entities.map(() => `(
    LOWER(turns.user_text) LIKE ? ESCAPE '\\' OR
    LOWER(turns.reply_text) LIKE ? ESCAPE '\\'
  )`).join(" OR ");
  const whereParameters = entities.flatMap((entity) => {
    const pattern = _likePattern(entity);
    return [pattern, pattern];
  });

  return getDb().prepare(`
    SELECT
      turns.turn_id,
      sessions.source,
      turns.ts,
      turns.user_text,
      turns.reply_text,
      (${scoreExpression}) AS hits
    FROM turns
    JOIN sessions ON sessions.session_id = turns.session_id
    WHERE ${whereExpression}
    ORDER BY hits DESC, turns.ts DESC
    LIMIT ?
  `).all(...scoreParameters, ...whereParameters, topK) as RecallResult[];
}

export function formatRecallResults(results: RecallResult[]): string {
  if (results.length === 0) return "No relevant past conversations found.";

  const lines = ["## Relevant past conversations\n"];
  for (const result of results) {
    const date = new Date(result.ts).toLocaleString();
    lines.push(`### [${result.source} · ${date}]`);
    lines.push(`**You:** ${result.user_text}`);
    if (result.reply_text) {
      const preview = result.reply_text.length > 500
        ? `${result.reply_text.slice(0, 500)}…`
        : result.reply_text;
      lines.push(`**Assistant:** ${preview}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function _likePattern(entity: string): string {
  return `%${entity.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
