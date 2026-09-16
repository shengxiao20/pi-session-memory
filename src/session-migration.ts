import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodexMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface CodexSession {
  id: string;
  cwd: string;
  timestamp: number;
  messages: CodexMessage[];
}

export interface ProjectSessionMigrationStats {
  scannedFiles: number;
  migratedSessions: number;
  skippedSessions: number;
  migratedMessages: number;
  issues: Array<{ path: string; error: string }>;
}

/** Convert every Codex session recorded for cwd into an independently resumable Pi session file. */
export function migrateCodexProjectSessions(cwd: string): ProjectSessionMigrationStats {
  const stats: ProjectSessionMigrationStats = {
    scannedFiles: 0,
    migratedSessions: 0,
    skippedSessions: 0,
    migratedMessages: 0,
    issues: [],
  };
  for (const path of _jsonlFiles(join(homedir(), ".codex", "sessions"))) {
    stats.scannedFiles++;
    try {
      const session = _parseCodexSession(path);
      if (!session || session.cwd !== cwd) continue;
      const outputPath = _targetPath(session);
      if (existsSync(outputPath)) {
        stats.skippedSessions++;
        continue;
      }
      _writePiSession(session, outputPath);
      stats.migratedSessions++;
      stats.migratedMessages += session.messages.length;
    } catch (error) {
      stats.issues.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return stats;
}

/** Convert one supported Codex JSONL file into its session metadata and textual messages. */
function _parseCodexSession(path: string): CodexSession | undefined {
  const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const metadata = entries.find((entry) => entry.type === "session_meta")?.payload as Record<string, unknown> | undefined;
  if (!metadata) return undefined;
  const id = _string(metadata.session_id) ?? _string(metadata.id);
  const cwd = _string(metadata.cwd);
  const timestamp = _timestamp(_string(metadata.timestamp));
  if (!id || !cwd || timestamp === undefined) throw new Error("Codex session_meta requires session_id/id, cwd, and timestamp");

  const messages: CodexMessage[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "message") continue;
    const role = _string(payload.role);
    if (role !== "user" && role !== "assistant") continue;
    const text = _text(payload.content);
    if (!text) continue;
    const messageId = _string(payload.id)
      ?? _string(entry.id)
      ?? _string((payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined)?.turn_id);
    if (!messageId) throw new Error(`Codex textual message at entry ${index} has no stable native ID`);
    messages.push({
      id: messageId,
      role,
      text,
      timestamp: _timestamp(_string(entry.timestamp)) ?? timestamp,
    });
  }
  return { id, cwd, timestamp, messages };
}

/** Write a valid Pi v3 session with a linear message branch and an explicit migration name. */
function _writePiSession(session: CodexSession, path: string): void {
  mkdirSync(join(homedir(), ".pi", "agent", "sessions", _encodedCwd(session.cwd)), { recursive: true });
  const lines: string[] = [JSON.stringify({
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date(session.timestamp).toISOString(),
    cwd: session.cwd,
  })];
  let parentId: string | null = null;
  const nameId = _entryId(session.id, "name");
  lines.push(JSON.stringify({
    type: "session_info",
    id: nameId,
    parentId,
    timestamp: new Date(session.timestamp).toISOString(),
    name: `Migrated from Codex: ${session.id}`,
  }));
  parentId = nameId;
  for (const message of session.messages) {
    const id = _entryId(session.id, message.id);
    const timestamp = new Date(message.timestamp).toISOString();
    lines.push(JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp,
      message: message.role === "user"
        ? { role: "user", content: [{ type: "text", text: message.text }], timestamp: message.timestamp }
        : {
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          api: "codex-migration",
          provider: "codex",
          model: "unknown",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: message.timestamp,
        },
    }));
    parentId = id;
  }
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${lines.join("\n")}\n`, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

/** Return the deterministic Pi session-file location for one Codex session. */
function _targetPath(session: CodexSession): string {
  return join(homedir(), ".pi", "agent", "sessions", _encodedCwd(session.cwd), `${new Date(session.timestamp).toISOString().replace(/[.:]/g, "-")}_codex-${session.id}.jsonl`);
}

/** Encode cwd exactly as Pi's default session directory convention. */
function _encodedCwd(cwd: string): string {
  return `--${cwd.split("/").filter(Boolean).join("-")}--`;
}

/** Create stable, Pi-safe entry IDs without fabricating source message identity. */
function _entryId(sessionId: string, sourceId: string): string {
  return createHash("sha256").update(`${sessionId}:${sourceId}`).digest("hex").slice(0, 16);
}

/** Extract non-empty string values only. */
function _string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Parse an ISO timestamp only when it is valid. */
function _timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/** Join supported Codex text content blocks. */
function _text(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && typeof (block as { type?: unknown }).type === "string" && typeof (block as { text?: unknown }).text === "string")
    .filter((block) => block.type === "input_text" || block.type === "output_text" || block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Recursively enumerate source JSONL files. */
function _jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return _jsonlFiles(path);
    return entry.isFile() && path.endsWith(".jsonl") ? [path] : [];
  });
}
