import { getDb } from "./db.ts";
import { type HistorySource, type RecallTurnResult, recallTurns } from "./retriever.ts";

export interface ProjectRecallOptions {
  /** Project directory name used only to resolve stored session CWDs. */
  project: string;
  /** Literal topic terms used only to search turns within resolved project sessions. */
  entities: string[];
  sources?: HistorySource[];
  after?: number;
  before?: number;
}

export interface ProjectSessionCandidate {
  session_id: string;
  source: HistorySource;
  cwd: string;
  started_at: number;
  turn_count: number;
  first_user_text: string;
}

export interface ProjectRecallResult {
  sessions: ProjectSessionCandidate[];
  results: RecallTurnResult[];
}

/** Resolve a project by its CWD directory name, then search only its sessions with topic entities. */
export function recallProjectMemory(options: ProjectRecallOptions): ProjectRecallResult {
  const sessions = findProjectSessions(options);
  const results = sessions.length
    ? recallTurns({ entities: options.entities, sessionIds: sessions.map((session) => session.session_id), sources: options.sources, after: options.after, before: options.before })
    : [];
  return { sessions, results };
}

/** Find sessions whose final CWD directory name exactly equals the named project. */
export function findProjectSessions(options: Pick<ProjectRecallOptions, "project" | "sources" | "after" | "before">): ProjectSessionCandidate[] {
  const filters: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.sources?.length) { filters.push(`sessions.source IN (${options.sources.map(() => "?").join(", ")})`); parameters.push(...options.sources); }
  if (options.after !== undefined) { filters.push("turns.ts >= ?"); parameters.push(options.after); }
  if (options.before !== undefined) { filters.push("turns.ts <= ?"); parameters.push(options.before); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = getDb().prepare(`SELECT sessions.session_id, sessions.source, sessions.cwd, sessions.started_at, count(turns.turn_id) AS turn_count,
    (SELECT first_turn.user_text FROM turns AS first_turn WHERE first_turn.session_id = sessions.session_id ORDER BY first_turn.turn_index LIMIT 1) AS first_user_text
    FROM sessions JOIN turns ON turns.session_id = sessions.session_id ${where}
    GROUP BY sessions.session_id ORDER BY sessions.started_at DESC, sessions.session_id`).all(...parameters) as ProjectSessionCandidate[];
  const project = _normalizeProjectName(options.project);
  return rows.filter((session) => _cwdProjectName(session.cwd) === project);
}

/** Render project metadata matching separately from literal topic matching. */
export function formatProjectRecallResults(result: ProjectRecallResult, options: ProjectRecallOptions): string {
  const header = ["# Project recall results", `**Project:** \`${options.project}\``, "**Project match:** final directory name of stored session CWD", `**Topic entities:** ${options.entities.map((entity) => `\`${entity}\``).join(", ")}`, `**Project sessions:** ${result.sessions.length}`, `**Transcript results:** ${result.results.length}`].join("\n");
  if (result.results.length) {
    const turns = result.results.map((turn) => `### Project session match · turn ${turn.turn_index}\n**Fetch session ID:** \`${turn.session_id}\` (pass this exact value to \`fetch_session.session_id\`)\n**Source turn ID:** \`${turn.turn_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n");
    return `${header}\n\n## Topic matches within the resolved project sessions\n${turns}`;
  }
  const candidates = result.sessions.length
    ? result.sessions.map((session) => `### Project session candidate\n**Fetch session ID:** \`${session.session_id}\` (pass this exact value to \`fetch_session.session_id\`)\n**Source:** ${session.source} · **CWD:** \`${session.cwd}\` · **Turns:** ${session.turn_count}\n**First user message:** ${session.first_user_text}`).join("\n\n")
    : "No sessions have a CWD whose final directory name exactly matches this project.";
  return `${header}\n\n## Project session candidates\n${candidates}`;
}

function _normalizeProjectName(project: string): string { return project.trim().toLowerCase(); }
function _cwdProjectName(cwd: string): string { return cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? ""; }
