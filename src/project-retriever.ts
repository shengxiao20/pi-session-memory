import { getDb } from "./db.ts";
import { getRecallLimit } from "./config.ts";
import { type RecallTurnResult, recallTurns } from "./retriever.ts";

export interface ProjectRecallOptions {
  /** Literal entities used both to discover stored session directory names and search matched sessions' turns. */
  entities: string[];
  /** Complete phrase bonus for transcript ranking; low-level literal retrieval may omit it. */
  primary_entity?: string;
}

export interface ProjectSessionCandidate {
  session_id: string;
  source: "pi";
  cwd: string;
  started_at: number;
  turn_count: number;
  first_user_text: string;
}

export interface ProjectRecallResult {
  sessions: ProjectSessionCandidate[];
  results: RecallTurnResult[];
}

/** Discover sessions when any entity's normalized token sequence occurs in the final CWD directory name, then search those sessions' turns. */
export function recallProjectMemory(options: ProjectRecallOptions): ProjectRecallResult {
  const projectSessions = findProjectSessions(options);
  const results = projectSessions.length
    ? recallTurns({ entities: options.entities, primary_entity: options.primary_entity, sessionIds: projectSessions.map((session) => session.session_id) })
    : [];
  const resultSessionIds = new Set(results.map((result) => result.session_id));
  const sessions = results.length
    ? projectSessions.filter((session) => resultSessionIds.has(session.session_id))
    : projectSessions.slice(0, getRecallLimit());
  return { sessions, results };
}

/** Find stored sessions whose final CWD directory name matches at least one supplied entity. */
export function findProjectSessions(options: ProjectRecallOptions): ProjectSessionCandidate[] {
  const rows = getDb().prepare(`SELECT sessions.session_id, sessions.source, sessions.cwd, sessions.started_at, count(turns.turn_id) AS turn_count,
    (SELECT first_turn.user_text FROM turns AS first_turn WHERE first_turn.session_id = sessions.session_id ORDER BY first_turn.turn_index LIMIT 1) AS first_user_text
    FROM sessions JOIN turns ON turns.session_id = sessions.session_id
    GROUP BY sessions.session_id ORDER BY sessions.started_at DESC, sessions.session_id`).all() as ProjectSessionCandidate[];
  const entityTokenSequences = options.entities.map(_projectTokens).filter((tokens) => tokens.length > 0);
  if (!entityTokenSequences.length) throw new Error("Entities must contain at least one letter or number");
  return rows.filter((session) => {
    const directoryTokens = _projectTokens(_cwdProjectName(session.cwd));
    return entityTokenSequences.some((entityTokens) => _containsTokenSequence(directoryTokens, entityTokens));
  });
}

/** Render entity-to-session-name discovery separately from matched-session turn search. */
export function formatProjectRecallResults(result: ProjectRecallResult, options: ProjectRecallOptions): string {
  const header = ["# Project recall results", ...(options.primary_entity === undefined ? [] : [`**Primary entity:** \`${options.primary_entity}\` · transcript complete phrase bonus: +10`]), `**Session-name entities:** ${options.entities.map((entity) => `\`${entity}\``).join(", ")}`, "**Session-name match:** any entity's normalized token sequence in the final directory name of stored session CWDs", `**Matched sessions:** ${result.sessions.length}`, `**Transcript results:** ${result.results.length}`].join("\n");
  if (result.results.length) {
    const turns = result.results.map((turn) => `### Matched project session · turn ${turn.turn_index}\n**Fetch turn ID:** \`${turn.turn_id}\` (pass this exact value to \`fetch_session.turn_id\`)\n**Session ID:** \`${turn.session_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n");
    return `${header}\n\n## Entity matches within discovered project sessions\n${turns}`;
  }
  const candidates = result.sessions.length
    ? result.sessions.map((session) => `### Matched project session candidate\n**Session ID:** \`${session.session_id}\` (metadata only; no matching turn to fetch)\n**Source:** ${session.source} · **CWD:** \`${session.cwd}\` · **Turns:** ${session.turn_count}\n**First user message:** ${session.first_user_text}`).join("\n\n")
    : "No stored session CWD final-directory name matches any supplied entity.";
  return `${header}\n\n## Project session candidates\n${candidates}`;
}

function _projectTokens(value: string): string[] { return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function _containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  return tokens.some((_, index) => sequence.every((token, offset) => tokens[index + offset] === token));
}
function _cwdProjectName(cwd: string): string { return cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""; }
