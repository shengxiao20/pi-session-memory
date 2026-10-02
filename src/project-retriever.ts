import { getDb } from "./db.ts";
import { getRecallLimit } from "./config.ts";
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

/** Resolve a project by normalized final CWD directory-name tokens, then search only its sessions with topic entities. */
export function recallProjectMemory(options: ProjectRecallOptions): ProjectRecallResult {
  const projectSessions = findProjectSessions(options);
  const results = projectSessions.length
    ? recallTurns({ entities: options.entities, sessionIds: projectSessions.map((session) => session.session_id), sources: options.sources, after: options.after, before: options.before })
    : [];
  const resultSessionIds = new Set(results.map((result) => result.session_id));
  const sessions = results.length
    ? projectSessions.filter((session) => resultSessionIds.has(session.session_id))
    : projectSessions.slice(0, getRecallLimit());
  return { sessions, results };
}

/** Find sessions whose final CWD directory name contains every normalized named-project token. */
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
  const projectTokens = _projectTokens(options.project);
  if (!projectTokens.length) throw new Error("Project must contain at least one letter or number");
  return rows.filter((session) => projectTokens.every((token) => _projectTokens(_cwdProjectName(session.cwd)).includes(token)));
}

/** Render project metadata matching separately from literal topic matching. */
export function formatProjectRecallResults(result: ProjectRecallResult, options: ProjectRecallOptions): string {
  const header = ["# Project recall results", `**Project:** \`${options.project}\``, "**Project match:** normalized tokens in the final directory name of stored session CWDs", `**Topic entities:** ${options.entities.map((entity) => `\`${entity}\``).join(", ")}`, `**Project sessions:** ${result.sessions.length}`, `**Transcript results:** ${result.results.length}`].join("\n");
  if (result.results.length) {
    const turns = result.results.map((turn) => `### Project session match · turn ${turn.turn_index}\n**Fetch session ID:** \`${turn.session_id}\` (pass this exact value to \`fetch_session.session_id\`)\n**Source turn ID:** \`${turn.turn_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n");
    return `${header}\n\n## Topic matches within the resolved project sessions\n${turns}`;
  }
  const candidates = result.sessions.length
    ? result.sessions.map((session) => `### Project session candidate\n**Fetch session ID:** \`${session.session_id}\` (pass this exact value to \`fetch_session.session_id\`)\n**Source:** ${session.source} · **CWD:** \`${session.cwd}\` · **Turns:** ${session.turn_count}\n**First user message:** ${session.first_user_text}`).join("\n\n")
    : "No sessions have a CWD whose final directory name contains every normalized project token.";
  return `${header}\n\n## Project session candidates\n${candidates}`;
}

function _projectTokens(project: string): string[] { return project.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function _cwdProjectName(cwd: string): string { return cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""; }
