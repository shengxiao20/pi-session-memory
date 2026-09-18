import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSourceFile, insertTurn, upsertSession, upsertSourceFile } from "./db.ts";

type Source = "pi" | "claude" | "codex";
type Role = "user" | "assistant";

interface ImportedMessage {
  id: string;
  role: Role;
  text: string;
  ts: number;
  toolNames: string[];
}

interface ImportedSession {
  source: Source;
  nativeSessionId: string;
  cwd: string;
  startedAt: number;
  modelId: string | null;
  jsonlPath: string;
  messages: ImportedMessage[];
}

export interface BackfillIssue {
  source: Source;
  jsonlPath: string | null;
  error: string;
}

export interface BackfillStats {
  pi: number;
  claude: number;
  codex: number;
  turns: number;
  scannedFiles: number;
  skippedFiles: number;
  issues: BackfillIssue[];
}

/** Versions whose Claude Code and Codex JSONL schemas this importer was verified against. */
export const HISTORY_SCHEMA_REFERENCE_VERSIONS = {
  pi: "0.85.1",
  claude: "2.1.234",
  codex: "0.154.0",
} as const;

const SOURCES: Array<{ source: Source; root: string; parse: (path: string) => ImportedSession | undefined }> = [
  { source: "pi", root: join(homedir(), ".pi", "agent", "sessions"), parse: _parsePi },
  { source: "claude", root: join(homedir(), ".claude", "projects"), parse: _parseClaude },
  { source: "codex", root: join(homedir(), ".codex", "sessions"), parse: _parseCodex },
];

/** Reparse every known source file. Intended for the explicit /memory-backfill command. */
export function backfillAll(): BackfillStats {
  return _syncHistory(true);
}

/** Parse only source files that are new or whose metadata/content changed. */
export function syncChangedHistory(): BackfillStats {
  return _syncHistory(false);
}

/** Synchronize all configured JSONL sources. */
function _syncHistory(force: boolean): BackfillStats {
  const stats: BackfillStats = { pi: 0, claude: 0, codex: 0, turns: 0, scannedFiles: 0, skippedFiles: 0, issues: [] };
  for (const definition of SOURCES) {
    if (!existsSync(definition.root)) continue;
    try {
      for (const jsonlPath of _jsonlFiles(definition.root)) _syncSourceFile(definition, jsonlPath, force, stats);
    } catch (error) {
      stats.issues.push(_backfillIssue(definition.source, null, error));
    }
  }
  return stats;
}

/** Synchronize one source file without allowing its failure to block other files or sources. */
function _syncSourceFile(definition: typeof SOURCES[number], jsonlPath: string, force: boolean, stats: BackfillStats): void {
  try {
    const metadata = statSync(jsonlPath);
    const known = getSourceFile(jsonlPath);
    if (!force && known?.size === metadata.size && known.mtime_ms === metadata.mtimeMs) {
      stats.skippedFiles++;
      return;
    }

    const sha256 = _sha256(jsonlPath);
    if (!force && known?.sha256 === sha256) {
      upsertSourceFile({ jsonl_path: jsonlPath, source: definition.source, size: metadata.size, mtime_ms: metadata.mtimeMs, sha256 });
      stats.skippedFiles++;
      return;
    }

    const session = definition.parse(jsonlPath);
    if (session) {
      stats[definition.source]++;
      stats.turns += _persist(session);
      upsertSourceFile({ jsonl_path: jsonlPath, source: definition.source, size: metadata.size, mtime_ms: metadata.mtimeMs, sha256 });
    }
    stats.scannedFiles++;
  } catch (error) {
    stats.issues.push(_backfillIssue(definition.source, jsonlPath, error));
  }
}

/** Format an isolated source failure with the reference version for schema comparison. */
function _backfillIssue(source: Source, jsonlPath: string | null, error: unknown): BackfillIssue {
  const location = jsonlPath ? ` (${jsonlPath})` : "";
  const message = error instanceof Error ? error.message : String(error);
  return {
    source,
    jsonlPath,
    error: `${source} history import failed${location}: ${message}. Compare the local ${source} version with the supported reference ${HISTORY_SCHEMA_REFERENCE_VERSIONS[source]}; this may be a JSONL schema compatibility issue.`,
  };
}

/** Convert one normalized source session into paired, idempotently stored memory turns. */
function _persist(session: ImportedSession): number {
  const sessionId = `${session.source}:${session.nativeSessionId}`;
  upsertSession({
    session_id: sessionId,
    source: session.source,
    cwd: session.cwd,
    started_at: session.startedAt,
    model_id: session.modelId,
    jsonl_path: session.jsonlPath,
  });

  let turnIndex = 0;
  let user: ImportedMessage | undefined;
  let replyText = "";
  const toolNames: string[] = [];
  let persisted = 0;

  /** Persist the current user-plus-assistant accumulation when a turn boundary is reached. */
  const flush = () => {
    if (!user || !replyText.trim()) return;
    const inserted = insertTurn({
      turn_id: `${sessionId}:${user.id}`,
      session_id: sessionId,
      turn_index: turnIndex++,
      ts: user.ts,
      user_text: user.text,
      reply_text: replyText.trim(),
      tool_names: toolNames.length ? JSON.stringify([...new Set(toolNames)]) : null,
      user_message_id: user.id,
    });
    if (inserted) persisted++;
  };

  for (const message of session.messages) {
    if (message.role === "user") {
      flush();
      user = message;
      replyText = "";
      toolNames.length = 0;
      continue;
    }
    if (!user) continue;
    if (message.text) replyText += (replyText ? "\n" : "") + message.text;
    toolNames.push(...message.toolNames);
  }
  flush();
  return persisted;
}

/** Parse a Pi JSONL session into the source-neutral import representation. */
function _parsePi(jsonlPath: string): ImportedSession | undefined {
  const entries = _readJsonl(jsonlPath);
  const header = entries.find((entry) => entry.type === "session");
  if (!header) return undefined;
  const model = entries.find((entry) => entry.type === "model_change");
  const messages: ImportedMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = _piText(message);
    if (!text) continue;
    const toolNames = message.role === "assistant"
      ? message.content.filter((block: any) => block.type === "toolCall").map((block: any) => block.name)
      : [];
    messages.push({
      id: _messageId("Pi entry.id", entry.id),
      role: message.role,
      text,
      ts: message.timestamp,
      toolNames,
    });
  }

  return {
    source: "pi",
    nativeSessionId: header.id,
    cwd: header.cwd,
    startedAt: Date.parse(header.timestamp),
    modelId: model?.modelId ?? null,
    jsonlPath,
    messages,
  };
}

/** Parse non-meta Claude Code conversation records into normalized messages. */
function _parseClaude(jsonlPath: string): ImportedSession | undefined {
  const entries = _readJsonl(jsonlPath);
  const firstConversation = entries.find((entry) =>
    (entry.type === "user" || entry.type === "assistant") && !entry.isMeta && !entry.isSidechain,
  );
  if (!firstConversation?.sessionId) return undefined;

  const messages: ImportedMessage[] = [];
  for (const entry of entries) {
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isSidechain) continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = _claudeText(entry.message);
    if (!text || (role === "user" && _isClaudeInjectedContext(text))) continue;
    const toolNames = role === "assistant"
      ? entry.message.content.filter((block: any) => block.type === "tool_use").map((block: any) => block.name)
      : [];
    // Workaround: Claude Code JSONL schema differs by version; message IDs may be in uuid or id.
    messages.push({
      id: _messageId("Claude entry.uuid or entry.id", entry.uuid, entry.id),
      role,
      text,
      ts: Date.parse(entry.timestamp),
      toolNames,
    });
  }

  return {
    source: "claude",
    nativeSessionId: firstConversation.sessionId,
    cwd: firstConversation.cwd ?? "",
    startedAt: Date.parse(firstConversation.timestamp),
    modelId: null,
    jsonlPath,
    messages,
  };
}

/** Parse Codex session metadata and response-message envelopes into normalized messages. */
function _parseCodex(jsonlPath: string): ImportedSession | undefined {
  const entries = _readJsonl(jsonlPath);
  const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
  if (!meta?.session_id) return undefined;

  const messages: ImportedMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue;
    const text = _codexText(payload);
    if (!text || (payload.role === "user" && _isCodexInjectedContext(text))) continue;
    // Workaround: Codex JSONL schema differs by version; legacy sessions store the ID as metadata.turn_id.
    messages.push({
      id: _messageId(
        "Codex payload.id, entry.id, or metadata.turn_id",
        payload.id,
        entry.id,
        payload.internal_chat_message_metadata_passthrough?.turn_id,
      ),
      role: payload.role,
      text,
      ts: Date.parse(entry.timestamp),
      toolNames: [],
    });
  }

  return {
    source: "codex",
    nativeSessionId: meta.session_id,
    cwd: meta.cwd ?? "",
    startedAt: Date.parse(meta.timestamp),
    modelId: meta.model_provider ?? null,
    jsonlPath,
    messages,
  };
}

/** Read a source message ID from a known schema field without inventing one for malformed records. */
function _messageId(field: string, ...values: unknown[]): string {
  const id = values.find((value): value is string => typeof value === "string" && value.length > 0);
  if (!id) throw new Error(`Invalid ${field}: expected a non-empty string`);
  return id;
}

/** Extract Pi text content while excluding thinking and non-text blocks. */
function _piText(message: any): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Extract Claude Code text content from either legacy strings or content blocks. */
function _claudeText(message: any): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Extract user input and assistant output text from a Codex message payload. */
function _codexText(message: any): string {
  return message.content
    .filter((block: any) => block.type === "input_text" || block.type === "output_text")
    .map((block: any) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Identify Claude Code client-injected text that must not become user memory. */
function _isClaudeInjectedContext(text: string): boolean {
  return text.startsWith("<command-name>")
    || text.startsWith("<command-message>")
    || text.startsWith("<local-command-")
    || text.startsWith("<task-notification>")
    || text.startsWith("This session is being continued from a previous conversation");
}

/** Identify Codex environment or IDE context that must not become user memory. */
function _isCodexInjectedContext(text: string): boolean {
  return text.startsWith("# AGENTS.md instructions")
    || text.startsWith("<environment_context>")
    || text.startsWith("# Context from my IDE setup:")
    || text.startsWith("<image name=");
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

/** Recursively discover JSONL session files under a source root. */
function _jsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(..._jsonlFiles(path));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}
