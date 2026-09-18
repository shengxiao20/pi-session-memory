import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type MigrationSource = "claude" | "codex";
type Role = "user" | "assistant";

interface MigratedMessage {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
}

interface SourceSession {
  id: string;
  cwd: string;
  timestamp: number;
  messages: MigratedMessage[];
}

interface MigrationDefinition {
  source: MigrationSource;
  root: string;
  displayName: string;
  parse: (path: string) => SourceSession | undefined;
}

export interface ProjectSessionMigrationStats {
  scannedFiles: number;
  migratedSessions: number;
  skippedSessions: number;
  migratedMessages: number;
  issues: Array<{ path: string; error: string }>;
}

const MIGRATION_SOURCES: Record<MigrationSource, MigrationDefinition> = {
  claude: {
    source: "claude",
    root: join(homedir(), ".claude", "projects"),
    displayName: "Claude Code",
    parse: _parseClaudeSession,
  },
  codex: {
    source: "codex",
    root: join(homedir(), ".codex", "sessions"),
    displayName: "Codex",
    parse: _parseCodexSession,
  },
};

/** Convert every current-project Claude Code session into an independently resumable Pi session file. */
export function migrateClaudeProjectSessions(cwd: string): ProjectSessionMigrationStats {
  return _migrateProjectSessions(MIGRATION_SOURCES.claude, cwd);
}

/** Convert every current-project Codex session into an independently resumable Pi session file. */
export function migrateCodexProjectSessions(cwd: string): ProjectSessionMigrationStats {
  return _migrateProjectSessions(MIGRATION_SOURCES.codex, cwd);
}

/** Migrate one supported source while isolating malformed files from other source sessions. */
function _migrateProjectSessions(definition: MigrationDefinition, cwd: string): ProjectSessionMigrationStats {
  const stats: ProjectSessionMigrationStats = {
    scannedFiles: 0,
    migratedSessions: 0,
    skippedSessions: 0,
    migratedMessages: 0,
    issues: [],
  };
  for (const path of _jsonlFiles(definition.root)) {
    stats.scannedFiles++;
    try {
      const session = definition.parse(path);
      if (!session || session.cwd !== cwd) continue;
      const outputPath = _targetPath(definition.source, session);
      if (existsSync(outputPath)) {
        stats.skippedSessions++;
        continue;
      }
      _writePiSession(definition, session, outputPath);
      stats.migratedSessions++;
      stats.migratedMessages += session.messages.length;
    } catch (error) {
      stats.issues.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return stats;
}

/** Convert one Claude Code JSONL file into supported textual user and assistant messages. */
function _parseClaudeSession(path: string): SourceSession | undefined {
  const entries = _readJsonl(path);
  const firstConversation = entries.find((entry) =>
    (entry.type === "user" || entry.type === "assistant") && !entry.isMeta && !entry.isSidechain,
  );
  if (!firstConversation) return undefined;
  const id = _string(firstConversation.sessionId);
  const cwd = _string(firstConversation.cwd);
  const timestamp = _timestamp(_string(firstConversation.timestamp));
  if (!id || !cwd || timestamp === undefined) throw new Error("Claude Code conversation requires sessionId, cwd, and timestamp");

  const messages: MigratedMessage[] = [];
  for (const [index, entry] of entries.entries()) {
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isSidechain) continue;
    const role = _role(entry.message?.role);
    if (!role) continue;
    const text = _claudeText(entry.message?.content);
    if (!text || (role === "user" && _isClaudeInjectedContext(text))) continue;
    const messageId = _string(entry.uuid) ?? _string(entry.id);
    if (!messageId) throw new Error(`Claude Code textual message at entry ${index} has no stable native ID`);
    messages.push({
      id: messageId,
      role,
      text,
      timestamp: _timestamp(_string(entry.timestamp)) ?? timestamp,
    });
  }
  return { id, cwd, timestamp, messages };
}

/** Convert one Codex JSONL file into supported textual user and assistant messages. */
function _parseCodexSession(path: string): SourceSession | undefined {
  const entries = _readJsonl(path);
  const metadata = entries.find((entry) => entry.type === "session_meta")?.payload as Record<string, unknown> | undefined;
  if (!metadata) return undefined;
  const id = _string(metadata.session_id) ?? _string(metadata.id);
  const cwd = _string(metadata.cwd);
  const timestamp = _timestamp(_string(metadata.timestamp));
  if (!id || !cwd || timestamp === undefined) throw new Error("Codex session_meta requires session_id/id, cwd, and timestamp");

  const messages: MigratedMessage[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "message") continue;
    const role = _role(payload.role);
    if (!role) continue;
    const text = _codexText(payload.content);
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

/** Write one valid Pi v3 session with a linear message branch and explicit migration provenance. */
function _writePiSession(definition: MigrationDefinition, session: SourceSession, path: string): void {
  mkdirSync(join(homedir(), ".pi", "agent", "sessions", _encodedCwd(session.cwd)), { recursive: true });
  const lines: string[] = [JSON.stringify({
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date(session.timestamp).toISOString(),
    cwd: session.cwd,
  })];
  let parentId: string | null = null;
  const nameId = _entryId(definition.source, session.id, "name");
  lines.push(JSON.stringify({
    type: "session_info",
    id: nameId,
    parentId,
    timestamp: new Date(session.timestamp).toISOString(),
    name: `Migrated from ${definition.displayName}: ${session.id}`,
  }));
  parentId = nameId;
  for (const message of session.messages) {
    const id = _entryId(definition.source, session.id, message.id);
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
          api: `${definition.source}-migration`,
          provider: definition.source,
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

/** Return the deterministic Pi session-file location for one migrated source session. */
function _targetPath(source: MigrationSource, session: SourceSession): string {
  return join(homedir(), ".pi", "agent", "sessions", _encodedCwd(session.cwd), `${new Date(session.timestamp).toISOString().replace(/[.:]/g, "-")}_${source}-${session.id}.jsonl`);
}

/** Encode cwd exactly as Pi's default session directory convention. */
function _encodedCwd(cwd: string): string {
  return `--${cwd.split("/").filter(Boolean).join("-")}--`;
}

/** Create stable Pi-safe entry IDs while retaining source-specific identity namespaces. */
function _entryId(source: MigrationSource, sessionId: string, sourceId: string): string {
  return createHash("sha256").update(`${source}:${sessionId}:${sourceId}`).digest("hex").slice(0, 16);
}

/** Accept user and assistant roles only. */
function _role(value: unknown): Role | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
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

/** Extract Claude Code text from legacy string or text content blocks. */
function _claudeText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Exclude Claude Code client-injected context from migrated user conversation. */
function _isClaudeInjectedContext(text: string): boolean {
  return text.startsWith("<command-name>")
    || text.startsWith("<command-message>")
    || text.startsWith("<local-command-")
    || text.startsWith("<task-notification>")
    || text.startsWith("This session is being continued from a previous conversation");
}

/** Join supported Codex text content blocks. */
function _codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && typeof (block as { type?: unknown }).type === "string" && typeof (block as { text?: unknown }).text === "string")
    .filter((block) => block.type === "input_text" || block.type === "output_text" || block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Read every non-empty JSONL line into its ordered JSON record. */
function _readJsonl(path: string): Record<string, any>[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
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
