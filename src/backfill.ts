import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSourceFile, replaceSourceFile, upsertSourceFile, type StoredSession } from "./db.ts";
import { isMemoryToolTurn } from "./memory-index-policy.ts";
import { buildPiTurns } from "./pi-turns.ts";

type Source = "pi";

export interface BackfillIssue {
  source: Source;
  jsonlPath: string | null;
  error: string;
}

export interface BackfillStats {
  pi: number;
  turns: number;
  scannedFiles: number;
  skippedFiles: number;
  issues: BackfillIssue[];
}

/** Pi version whose JSONL schema this importer was verified against. */
export const PI_HISTORY_SCHEMA_REFERENCE_VERSION = "0.85.1";

const SOURCE = {
  source: "pi" as const,
  root: join(homedir(), ".pi", "agent", "sessions"),
  parserVersion: "tree-turns-v1",
};

/** Reparse every Pi session file. Intended for the explicit history-import action. */
export function backfillAll(): BackfillStats {
  return _syncHistory(true);
}

/** Parse only Pi session files that are new or whose metadata or content changed. */
export function syncChangedHistory(): BackfillStats {
  return _syncHistory(false);
}

/** Synchronize native Pi JSONL history. */
function _syncHistory(force: boolean): BackfillStats {
  const stats: BackfillStats = { pi: 0, turns: 0, scannedFiles: 0, skippedFiles: 0, issues: [] };
  if (!existsSync(SOURCE.root)) return stats;
  try {
    for (const jsonlPath of _jsonlFiles(SOURCE.root)) _syncSourceFile(jsonlPath, force, stats);
    const collisions = stats.issues.filter(issue => issue.jsonlPath && issue.error.includes("UNIQUE constraint failed: sessions.session_id"));
    for (const issue of collisions) {
      stats.issues.splice(stats.issues.indexOf(issue), 1);
      _syncSourceFile(issue.jsonlPath!, force, stats);
    }
  } catch (error) {
    stats.issues.push(_backfillIssue(null, error));
  }
  return stats;
}

/** Synchronize one Pi source file without blocking other files. */
function _syncSourceFile(jsonlPath: string, force: boolean, stats: BackfillStats): void {
  try {
    const metadata = statSync(jsonlPath);
    const known = getSourceFile(jsonlPath);
    const parser_version = SOURCE.parserVersion;
    const sameParser = known?.parser_version === parser_version;
    if (!force && sameParser && known?.size === metadata.size && known.mtime_ms === metadata.mtimeMs) {
      stats.skippedFiles++;
      return;
    }

    const sha256 = _sha256(jsonlPath);
    if (!force && sameParser && known?.sha256 === sha256) {
      upsertSourceFile({ jsonl_path: jsonlPath, source: SOURCE.source, size: metadata.size, mtime_ms: metadata.mtimeMs, sha256, parser_version });
      stats.skippedFiles++;
      return;
    }

    const stored = _parsePi(jsonlPath);
    replaceSourceFile({ jsonl_path: jsonlPath, source: SOURCE.source, size: metadata.size, mtime_ms: metadata.mtimeMs, sha256, parser_version }, stored);
    if (stored) {
      stats.pi++;
      stats.turns += stored.turns.filter(turn => !isMemoryToolTurn(turn.tool_names)).length;
    }
    stats.scannedFiles++;
  } catch (error) {
    stats.issues.push(_backfillIssue(jsonlPath, error));
  }
}

/** Format an isolated Pi import failure with the schema reference version. */
function _backfillIssue(jsonlPath: string | null, error: unknown): BackfillIssue {
  const location = jsonlPath ? ` (${jsonlPath})` : "";
  const message = error instanceof Error ? error.message : String(error);
  return {
    source: "pi",
    jsonlPath,
    error: `pi history import failed${location}: ${message}. Compare the local Pi version with the supported reference ${PI_HISTORY_SCHEMA_REFERENCE_VERSION}; this may be a JSONL schema compatibility issue.`,
  };
}

/** Parse Pi's entry tree with the same turn builder used by live writes. */
function _parsePi(jsonlPath: string): StoredSession | undefined {
  const entries = _readJsonl(jsonlPath);
  const header = entries.find(entry => entry.type === "session");
  if (!header) return undefined;
  const model = entries.find(entry => entry.type === "model_change");
  const sessionId = `pi:${_messageId("Pi session.id", header.id)}`;
  return {
    session: {
      session_id: sessionId,
      source: "pi",
      cwd: header.cwd as string,
      started_at: Date.parse(header.timestamp as string),
      model_id: (model?.modelId as string | undefined) ?? null,
      jsonl_path: jsonlPath,
    },
    turns: buildPiTurns(sessionId, entries.filter(entry => entry.type !== "session") as unknown as SessionEntry[]),
  };
}

/** Read a source message ID from a known schema field. */
function _messageId(field: string, ...values: unknown[]): string {
  const id = values.find((value): value is string => typeof value === "string" && value.length > 0);
  if (!id) throw new Error(`Invalid ${field}: expected a non-empty string`);
  return id;
}

/** Hash a source JSONL file so unchanged content can skip reparsing. */
function _sha256(jsonlPath: string): string {
  return createHash("sha256").update(readFileSync(jsonlPath)).digest("hex");
}

/** Read every non-empty JSONL line into its ordered object record. */
function _readJsonl(jsonlPath: string): Record<string, unknown>[] {
  return readFileSync(jsonlPath, "utf8")
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL at line ${lineNumber}`);
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid JSONL record at line ${lineNumber}: expected an object`);
      }
      return entry as Record<string, unknown>;
    });
}

/** Recursively discover JSONL session files under the Pi session root. */
function _jsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(..._jsonlFiles(path));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}
