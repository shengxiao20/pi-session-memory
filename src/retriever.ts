import { createHash } from "node:crypto";
import { getDb, type MemoryKind } from "./db.ts";

export type MemorySource = "pi" | "claude" | "codex";

export interface RecallOptions {
  query: string;
  entities?: string[];
  sources?: MemorySource[];
  cwd?: string;
  after?: number;
  before?: number;
}

export interface RecallTurnResult {
  type: "turn";
  turn_id: string;
  session_id: string;
  turn_index: number;
  source: MemorySource;
  cwd: string;
  ts: number;
  user_text: string;
  reply_text: string;
  hits: number;
  score: number;
}

export interface RecallDurableMemoryResult {
  type: "memory";
  memory_id: string;
  kind: MemoryKind;
  content: string;
  project_key: string;
  source_turn_id: string | null;
  source_session_id: string | null;
  source_content_hash: string | null;
  source_turn_index: number | null;
  freshness_candidate: boolean;
  created_at: number;
  last_confirmed_at: number;
  importance: number;
  hits: number;
  score: number;
}

export type RecallResult = RecallDurableMemoryResult | RecallTurnResult;

export const RECALL_PAGE_SIZE = 5;

export interface RecallPage {
  results: RecallResult[];
  offset: number;
  totalResults: number;
  nextOffset: number | null;
}

// Recency is a bounded tie-breaker, not a replacement for literal relevance.
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Retained for compatibility with the v0.1 public retrieval helper. */
export function recallTurns(entities: string[]): RecallTurnResult[] {
  return _recallTurns({ query: entities.join(" "), entities });
}

/** Retrieve active durable memories, then raw turns not already represented by unchanged source evidence. */
export function recallMemories(options: RecallOptions): RecallResult[] {
  const durableMemories = _recallDurableMemories(options);
  const recalledTurns = _recallTurns(options);
  const freshnessCandidates = new Set(
    durableMemories
      .filter((memory) => memory.source_session_id && memory.source_turn_index !== null)
      .filter((memory) => recalledTurns.some((turn) => turn.session_id === memory.source_session_id && turn.turn_index > memory.source_turn_index!))
      .map((memory) => memory.memory_id),
  );
  const memories = durableMemories.map((memory) => ({ ...memory, freshness_candidate: freshnessCandidates.has(memory.memory_id) }));
  const coveredSourceHashes = new Map(
    memories
      .filter((memory) => memory.source_turn_id && memory.source_content_hash)
      .map((memory) => [memory.source_turn_id!, memory.source_content_hash!]),
  );
  const rawTurns = recalledTurns.filter((turn) => coveredSourceHashes.get(turn.turn_id) !== _turnContentHash(turn));
  return [...memories, ...rawTurns];
}

/** Select one fixed-size recall page without limiting the complete local retrieval result. */
export function paginateRecallResults(results: RecallResult[], offset = 0): RecallPage {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Recall offset must be a non-negative integer");
  const pageResults = results.slice(offset, offset + RECALL_PAGE_SIZE);
  const nextOffset = offset + pageResults.length < results.length ? offset + pageResults.length : null;
  return { results: pageResults, offset, totalResults: results.length, nextOffset };
}

/** Render the exact query inputs and recall results as concise Markdown for a command notification or tool response. */
export function formatRecallResults(results: RecallResult[], options?: Pick<RecallOptions, "query" | "entities" | "sources" | "cwd" | "after" | "before">, page?: Omit<RecallPage, "results">): string {
  const lines = options ? [_formatRecallQuery(options), ""] : [];
  if (results.length === 0) return [...lines, page && page.totalResults > 0 ? `No results at offset ${page.offset}; the matching result set contains ${page.totalResults} result(s).` : "No relevant past conversations found."].join("\n");

  if (page) lines.push(`**Results:** ${page.offset + 1}–${page.offset + results.length} of ${page.totalResults} (five results per page)\n`);
  lines.push("## Relevant past memories\n");
  for (const result of results) {
    if (result.type === "memory") {
      lines.push(`### [durable ${result.kind} · ${new Date(result.last_confirmed_at).toLocaleString()}]`);
      lines.push(result.content);
      lines.push(`**Memory ID:** ${result.memory_id}`);
      if (result.source_turn_id) lines.push(`**Source turn:** ${result.source_turn_id}`);
      if (result.source_session_id) lines.push(`**Source session:** ${result.source_session_id}`);
      if (result.freshness_candidate) lines.push("**Freshness:** newer matching turn exists in the source session; confirm or supersede this memory.");
    } else {
      const date = new Date(result.ts).toLocaleString();
      lines.push(`### [${result.source} · ${date}]`);
      lines.push(`**Session:** ${result.session_id} · **Turn:** ${result.turn_index}`);
      lines.push(`**Excerpt:** ${_excerpt(result.user_text || result.reply_text)}`);
      lines.push("Use `fetch_session` with this session ID when the surrounding conversation is needed.");
    }
    lines.push("");
  }
  if (page?.nextOffset !== null && page?.nextOffset !== undefined) {
    lines.push(`More matching results exist. To retrieve the next five, call \`recall_memory\` again with every same search/filter parameter and \`offset: ${page.nextOffset}\`.`);
  }
  return lines.join("\n");
}

/** Make each tool invocation auditable by showing its exact literal terms and scopes. */
function _formatRecallQuery(options: Pick<RecallOptions, "query" | "entities" | "sources" | "cwd" | "after" | "before">): string {
  const filters = [
    options.entities?.length ? `entities: ${options.entities.map((entity) => `\`${entity}\``).join(", ")}` : null,
    options.sources?.length ? `sources: ${options.sources.join(", ")}` : null,
    options.cwd ? `cwd: \`${options.cwd}\`` : null,
    options.after !== undefined ? `after: ${new Date(options.after).toISOString()}` : null,
    options.before !== undefined ? `before: ${new Date(options.before).toISOString()}` : null,
  ].filter(Boolean);
  return `**Search query:** \`${options.query}\`${filters.length ? `  \\n**Filters:** ${filters.join(" · ")}` : ""}`;
}

/** Keep discovery results small; full persisted turn text belongs to fetch_session. */
function _excerpt(text: string, maxLength = 240): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

/** Search active durable memories with the same escaped literal matching used for transcript recall. */
function _recallDurableMemories(options: RecallOptions): RecallDurableMemoryResult[] {
  const terms = _terms(options);
  if (terms.length === 0) return [];
  const scoreExpression = terms.map(() => "CASE WHEN LOWER(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END").join(" + ");
  const parameters = terms.map(_likePattern);
  const filters = terms.map(() => "LOWER(content) LIKE ? ESCAPE '\\'");
  const filterParameters: Array<string | number> = terms.map(_likePattern);
  filters.push("superseded_by IS NULL");
  if (options.cwd) {
    filters.push("project_key = ?");
    filterParameters.push(options.cwd);
  }
  if (options.after !== undefined) {
    filters.push("last_confirmed_at >= ?");
    filterParameters.push(options.after);
  }
  if (options.before !== undefined) {
    filters.push("last_confirmed_at <= ?");
    filterParameters.push(options.before);
  }
  return getDb().prepare(`
    SELECT memory_id, kind, content, project_key, source_turn_id, source_session_id, source_content_hash, source_turn_index, created_at, last_confirmed_at, importance,
      (${scoreExpression}) AS hits
    FROM memories
    WHERE ${filters.join(" AND ")}
    ORDER BY hits DESC, importance DESC, last_confirmed_at DESC
  `).all(...parameters, ...filterParameters)
    .map((memory) => ({ ...memory, type: "memory" as const, freshness_candidate: false, score: memory.hits + memory.importance })) as RecallDurableMemoryResult[];
}

/** Retrieve and rank locally stored turns using literal query terms and optional scopes. */
function _recallTurns(options: RecallOptions): RecallTurnResult[] {
  const terms = _terms(options);
  if (terms.length === 0) return [];
  const scoreExpression = terms.map(() => `(CASE WHEN LOWER(turns.user_text) LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END + CASE WHEN LOWER(turns.reply_text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(" + ");
  const scoreParameters = terms.flatMap((term) => _likeParameters(term));
  const whereExpressions = terms.map(() => "(LOWER(turns.user_text) LIKE ? ESCAPE '\\' OR LOWER(turns.reply_text) LIKE ? ESCAPE '\\')");
  const whereParameters = terms.flatMap((term) => _likeParameters(term));
  const filters = [...whereExpressions];
  const filterParameters: Array<string | number> = [...whereParameters];
  if (options.sources?.length) {
    filters.push(`sessions.source IN (${options.sources.map(() => "?").join(", ")})`);
    filterParameters.push(...options.sources);
  }
  if (options.cwd) {
    filters.push("sessions.cwd = ?");
    filterParameters.push(options.cwd);
  }
  if (options.after !== undefined) {
    filters.push("turns.ts >= ?");
    filterParameters.push(options.after);
  }
  if (options.before !== undefined) {
    filters.push("turns.ts <= ?");
    filterParameters.push(options.before);
  }
  const candidates = getDb().prepare(`
    SELECT turns.turn_id, turns.session_id, turns.turn_index, sessions.source, sessions.cwd, turns.ts, turns.user_text, turns.reply_text,
      (${scoreExpression}) AS hits
    FROM turns JOIN sessions ON sessions.session_id = turns.session_id
    WHERE ${filters.join(" AND ")}
    ORDER BY hits DESC, turns.ts DESC
  `).all(...scoreParameters, ...filterParameters) as Array<Omit<RecallTurnResult, "type" | "score">>;
  const newestTs = candidates.reduce((newest, result) => Math.max(newest, result.ts), 0);
  const results = candidates.map((result) => ({ ...result, type: "turn" as const, score: result.hits + _recencyScore(result.ts, newestTs) + (options.cwd === result.cwd ? 0.8 : 0) })).sort((left, right) => right.score - left.score || right.ts - left.ts);
  return results;
}

/** Hash the current raw turn evidence using the same representation captured during pinning. */
function _turnContentHash(turn: RecallTurnResult): string {
  return createHash("sha256").update(JSON.stringify([turn.user_text, turn.reply_text])).digest("hex");
}

/** Build a de-duplicated set of non-empty literal search terms from the request. */
function _terms(options: RecallOptions): string[] {
  return [...new Set([options.query, ...(options.entities ?? [])].map((term) => term.trim()).filter(Boolean))];
}

/** Produce matching user and assistant SQL LIKE parameters for one term. */
function _likeParameters(term: string): [string, string] {
  const pattern = _likePattern(term);
  return [pattern, pattern];
}

/** Convert one literal search term into an escaped, case-normalized SQL LIKE pattern. */
function _likePattern(term: string): string {
  return `%${term.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** Return a bounded recency bonus relative to the newest candidate timestamp. */
function _recencyScore(ts: number, newestTs: number): number {
  return Math.max(0, 0.5 * (1 - (newestTs - ts) / RECENCY_WINDOW_MS));
}
