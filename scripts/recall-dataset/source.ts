import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isMemoryToolTurn } from "../../src/history/memory-index-policy.ts";
import { containsSecret, isEvaluationText, redact } from "./privacy.ts";
import type { CorpusTurn, ExportResult } from "./types.ts";

interface Row {
  turn_id: string; session_id: string; cwd: string; turn_index: number; ts: number;
  user_text: string; reply_text: string; tool_names: string | null;
}

/** Use a read-only snapshot; never call the production DB opener, which migrates and cleans. */
export function exportCorpus(path: string, cutoff?: number): ExportResult {
  assert(cutoff === undefined || Number.isSafeInteger(cutoff) && cutoff >= 0, "Invalid cutoff");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const rows = db.prepare(`SELECT t.turn_id, t.session_id, s.cwd, t.turn_index, t.ts,
      t.user_text, t.reply_text, t.tool_names FROM turns t JOIN sessions s USING(session_id)
      WHERE s.source = 'pi' AND t.ts <= ? ORDER BY s.cwd, t.ts, t.turn_id`)
      .all(cutoff ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    assert(rows.length > 0, "No indexed Pi turns before the cutoff");
    const projects = [...new Set(rows.map(row => row.cwd))].sort();
    const sessions = [...new Set(rows.map(row => row.session_id))].sort();
    const projectIds = new Map(projects.map((cwd, index) => [cwd, `project-${String(index + 1).padStart(3, "0")}`]));
    const sessionIds = new Map(sessions.map((id, index) => [id, `session-${String(index + 1).padStart(4, "0")}`]));
    const exclusions = { memory_tool: 0, secret: 0, evaluation: 0, empty: 0, oversized: 0 };
    const corpus: CorpusTurn[] = [];
    for (const row of rows) {
      assert(typeof row.user_text === "string" && typeof row.reply_text === "string", "Invalid transcript text");
      assert(Number.isSafeInteger(row.ts) && Number.isSafeInteger(row.turn_index), "Invalid transcript ordering");
      const text = `${row.user_text}\n${row.reply_text}`;
      if (isMemoryToolTurn(row.tool_names)) { exclusions.memory_tool++; continue; }
      if (containsSecret(text)) { exclusions.secret++; continue; }
      if (isEvaluationText(text)) { exclusions.evaluation++; continue; }
      if (!row.user_text.trim() || !row.reply_text.trim()) { exclusions.empty++; continue; }
      if (text.length > 80000) { exclusions.oversized++; continue; }
      const user = redact(row.user_text), reply = redact(row.reply_text);
      corpus.push({ turn_id: row.turn_id, session_id: sessionIds.get(row.session_id)!, project_id: projectIds.get(row.cwd)!,
        turn_index: row.turn_index, timestamp: row.ts, user_text: user.text, reply_text: reply.text,
        redactions: user.count + reply.count });
    }
    assert(corpus.length > 0, "No eligible corpus turns");
    db.exec("COMMIT");
    return { corpus, cutoff_timestamp: cutoff ?? Math.max(...rows.map(row => row.ts)), exclusions };
  } finally { db.close(); }
}

export function validateCorpus(corpus: CorpusTurn[]): void {
  assert(Array.isArray(corpus) && corpus.length > 0, "Empty corpus");
  const ids = new Set<string>();
  const sessionProjects = new Map<string, string>();
  for (const turn of corpus) {
    for (const key of ["turn_id", "session_id", "project_id", "user_text", "reply_text"] as const)
      assert(typeof turn[key] === "string" && turn[key].trim(), `Invalid ${key}`);
    assert(!ids.has(turn.turn_id), "Duplicate corpus turn"); ids.add(turn.turn_id);
    assert(Number.isSafeInteger(turn.timestamp) && turn.timestamp >= 0 && Number.isSafeInteger(turn.turn_index) && turn.turn_index >= 0, "Invalid turn ordering");
    assert(Number.isSafeInteger(turn.redactions) && turn.redactions >= 0, "Invalid redaction count");
    assert(!containsSecret(`${turn.user_text}\n${turn.reply_text}`), "Credential-like material in corpus");
    assert(!isEvaluationText(`${turn.user_text}\n${turn.reply_text}`), "Evaluation contamination in corpus");
    const existing = sessionProjects.get(turn.session_id);
    assert(existing === undefined || existing === turn.project_id, "Session spans projects");
    sessionProjects.set(turn.session_id, turn.project_id);
  }
}
