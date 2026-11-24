import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  recorded_cost: number;
}

export interface WorkspaceUsage extends UsageTotals {
  name: string;
  cwd_paths: string[];
  session_count: number;
  usage_entries: number;
  missing_assistant_usage: number;
}

export interface WorkspaceUsageSnapshot {
  history_root: string;
  workspaces: WorkspaceUsage[];
  copied_usage_entries: number;
  missing_assistant_usage: number;
  external_parent_files: number;
  provider_cost_entries: number;
  non_provider_cost_entries: number;
  unknown_cost_entries: number;
}

interface UsageRecord extends UsageTotals {
  identity: string;
  attribution: string;
  provider_cost: boolean | undefined;
}

interface SessionUsage {
  path: string;
  id: string;
  cwd: string;
  parent: string | undefined;
  records: UsageRecord[];
  missing_assistant_usage: number;
}

/** Read native JSONL usage on demand, without opening the index or changing source files. */
export async function getWorkspaceUsage(
  historyRoot = join(homedir(), ".pi", "agent", "sessions"),
): Promise<WorkspaceUsageSnapshot> {
  const sessions: SessionUsage[] = [];
  for (const path of await _sessionFiles(resolve(historyRoot))) sessions.push(await _readSession(path));
  const byPath = new Map(sessions.map(session => [session.path, session]));
  const ids = new Set<string>();
  const lineage = new Map<string, { root: string; depth: number }>();
  const visit = (path: string, ancestors: Set<string>): { root: string; depth: number } => {
    if (ancestors.has(path)) throw new Error(`Cyclic Pi session parent chain: ${path}`);
    const known = lineage.get(path);
    if (known) return known;
    const parent = byPath.get(path)?.parent;
    const origin = parent === undefined ? { root: path, depth: 0 } : visit(parent, new Set([...ancestors, path]));
    const value = { root: origin.root, depth: origin.depth + Number(parent !== undefined) };
    lineage.set(path, value);
    return value;
  };
  for (const session of sessions) {
    if (ids.has(session.id)) throw new Error(`Duplicate Pi session ID: ${session.id}`);
    ids.add(session.id);
    visit(session.path, new Set());
  }
  // Process ancestors first. A copied request stays attributed to its earliest available source workspace.
  sessions.sort((a, b) => lineage.get(a.path)!.depth - lineage.get(b.path)!.depth || a.path.localeCompare(b.path));
  const groups = new Map<string, WorkspaceUsage>();
  const seen = new Map<string, string>();
  const snapshot: WorkspaceUsageSnapshot = {
    history_root: resolve(historyRoot), workspaces: [], copied_usage_entries: 0,
    missing_assistant_usage: 0,
    external_parent_files: new Set(sessions.flatMap(session => session.parent !== undefined && !byPath.has(session.parent) ? [session.parent] : [])).size,
    provider_cost_entries: 0, non_provider_cost_entries: 0, unknown_cost_entries: 0,
  };
  for (const session of sessions) {
    const name = basename(session.cwd.replaceAll("\\", "/").replace(/\/+$/, ""));
    if (!name) throw new Error(`Pi session cwd has no directory name: ${session.path}`);
    let group = groups.get(name);
    if (!group) {
      group = { name, cwd_paths: [], session_count: 0, usage_entries: 0, missing_assistant_usage: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, recorded_cost: 0 };
      groups.set(name, group);
    }
    if (!group.cwd_paths.includes(session.cwd)) group.cwd_paths.push(session.cwd);
    group.session_count++;
    group.missing_assistant_usage += session.missing_assistant_usage;
    snapshot.missing_assistant_usage += session.missing_assistant_usage;
    for (const record of session.records) {
      const key = JSON.stringify([lineage.get(session.path)!.root, record.identity]);
      const fingerprint = JSON.stringify(record);
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior !== fingerprint) throw new Error(`Conflicting copied Pi usage: ${session.path}: ${record.identity}`);
        snapshot.copied_usage_entries++;
        continue;
      }
      seen.set(key, fingerprint);
      group.usage_entries++;
      for (const field of ["input", "output", "cache_read", "cache_write", "total_tokens"] as const) {
        group[field] = _tokens(group[field] + record[field], `${name}.${field}`);
      }
      group.recorded_cost = _cost(group.recorded_cost + record.recorded_cost, `${name}.recorded_cost`);
      if (record.provider_cost === true) snapshot.provider_cost_entries++;
      else if (record.provider_cost === false) snapshot.non_provider_cost_entries++;
      else snapshot.unknown_cost_entries++;
    }
  }
  snapshot.workspaces = [...groups.values()].sort((a, b) => b.total_tokens - a.total_tokens || b.recorded_cost - a.recorded_cost || a.name.localeCompare(b.name));
  for (const group of snapshot.workspaces) group.cwd_paths.sort();
  return snapshot;
}

/** Read root and workspace session files. Nested auxiliary directories stay outside discovery. */
async function _sessionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = _sessionPaths(root, entries);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    files.push(..._sessionPaths(directory, await readdir(directory, { withFileTypes: true })));
  }
  return files.sort();
}

function _sessionPaths(directory: string, entries: Dirent[]): string[] {
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => join(directory, entry.name));
}

/** Keep usage metadata only. Message bodies never enter the returned snapshot. */
async function _readSession(path: string): Promise<SessionUsage> {
  const file = await open(path, "r");
  let session: SessionUsage | undefined;
  let lineNumber = 0;
  const identities = new Set<string>();
  try {
    for await (const line of file.readLines({ autoClose: false })) {
      lineNumber++;
      if (!line.trim()) continue;
      const location = `${path}:${lineNumber}`;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch (cause) { throw new Error(`Invalid Pi JSONL: ${location}`, { cause }); }
      const entry = _object(parsed, location);
      const type = _string(entry.type, `${location}.type`);
      if (session === undefined) {
        if (type !== "session") throw new Error(`Expected Pi session header: ${location}`);
        session = {
          path, id: _string(entry.id, `${location}.id`), cwd: _string(entry.cwd, `${location}.cwd`),
          parent: entry.parentSession === undefined ? undefined : resolve(dirname(path), _string(entry.parentSession, `${location}.parentSession`)),
          records: [], missing_assistant_usage: 0,
        };
        continue;
      }
      if (type === "session") throw new Error(`Repeated Pi session header: ${location}`);
      let usage: unknown;
      let attribution = type;
      if (type === "message") {
        const message = _object(entry.message, `${location}.message`);
        if (message.role !== "assistant" && message.role !== "toolResult") continue;
        usage = message.usage;
        if (message.role === "assistant" && usage === undefined) session.missing_assistant_usage++;
        attribution = JSON.stringify([message.role, message.provider, message.model, message.toolCallId]);
      } else if (type === "usage" || type === "compaction" || type === "branch_summary") {
        usage = entry.usage;
        attribution = JSON.stringify([type, entry.provider, entry.model, entry.kind]);
        if (type === "usage" && usage === undefined) throw new Error(`Missing Pi usage: ${location}`);
      } else continue;
      if (usage === undefined) continue;
      const identity = JSON.stringify([type, _string(entry.id, `${location}.id`), _string(entry.timestamp, `${location}.timestamp`)]);
      if (identities.has(identity)) throw new Error(`Repeated Pi usage entry: ${location}`);
      identities.add(identity);
      session.records.push({ ..._readUsage(usage, location), identity, attribution });
    }
  } finally { await file.close(); }
  if (session === undefined) throw new Error(`Missing Pi session header: ${path}`);
  return session;
}

function _readUsage(value: unknown, location: string): Omit<UsageRecord, "identity" | "attribution"> {
  const usage = _object(value, `${location}.usage`);
  const input = _tokens(usage.input, `${location}.usage.input`);
  const output = _tokens(usage.output, `${location}.usage.output`);
  const cache_read = _tokens(usage.cacheRead, `${location}.usage.cacheRead`);
  const cache_write = _tokens(usage.cacheWrite, `${location}.usage.cacheWrite`);
  const cost = _object(usage.cost, `${location}.usage.cost`);
  const provider_cost = cost.totalFromProvider;
  if (provider_cost !== undefined && typeof provider_cost !== "boolean") throw new Error(`Invalid Pi cost source: ${location}`);
  return { input, output, cache_read, cache_write,
    total_tokens: _tokens(input + output + cache_read + cache_write, `${location}.usage.total`),
    recorded_cost: _cost(cost.total, `${location}.usage.cost.total`), provider_cost,
  };
}

function _object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Pi object: ${field}`);
  return value as Record<string, unknown>;
}

function _string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Pi string: ${field}`);
  return value;
}

function _tokens(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Pi token count: ${field}`);
  return value;
}

function _cost(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Pi recorded cost: ${field}`);
  return value;
}
