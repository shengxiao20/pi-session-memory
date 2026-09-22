import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeTurn } from "../src/writer.ts";
import { getHistoryStats } from "../src/db.ts";
import { fetchSession } from "../src/fetch-session.ts";
import { formatRecallResults, recallTurns } from "../src/retriever.ts";
import { backfillAll, syncChangedHistory, type BackfillStats } from "../src/backfill.ts";
import { migrateClaudeProjectSessions, migrateCodexProjectSessions, type ProjectSessionMigrationStats } from "../src/session-migration.ts";
import { SESSION_MEMORY_HELP } from "../src/helper.ts";
import { getWhatsNew, showWhatsNewIfUpdated } from "../src/whats-new.ts";
import packageJson from "../package.json" with { type: "json" };

/** Register local cross-session transcript retrieval and source-session migration features. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    try {
      const whatsNew = showWhatsNewIfUpdated(packageJson.version);
      if (whatsNew) ctx.ui.notify(whatsNew, "info");
      const stats = syncChangedHistory();
      if (event.reason === "startup" || stats.scannedFiles > 0) {
        const summary = stats.scannedFiles > 0 ? `synced ${stats.turns} turns from ${stats.scannedFiles} changed session files` : "ready";
        ctx.ui.notify(`[session-memory] ${summary}. Run /pi-session-memory-helper for cross-session history features.`, "info");
      }
      for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error");
    } catch (err) { ctx.ui.notify(`[session-memory] history sync failed: ${String(err)}`, "error"); }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try { writeTurn(ctx); } catch (err) { ctx.ui.notify(`[session-memory] write failed: ${String(err)}`, "error"); }
  });

  pi.registerCommand("pi-session-memory-whats-new", {
    description: "Show release notes for the installed pi-session-memory version",
    handler: async (_args, ctx) => { ctx.ui.notify(getWhatsNew(packageJson.version) || `No published What's New notes for pi-session-memory v${packageJson.version}.`, "info"); },
  });
  pi.registerCommand("pi-session-memory-helper", {
    description: "Show cross-session history search and migration features",
    handler: async (_args, ctx) => { ctx.ui.notify(SESSION_MEMORY_HELP, "info"); },
  });
  pi.registerCommand("memory-status", {
    description: "Show local cross-session history storage and source statistics",
    handler: async (_args, ctx) => { ctx.ui.notify(_historyStatsSummary(getHistoryStats()), "info"); },
  });
  pi.registerCommand("memory-search", {
    description: "Search local cross-session transcript history with a literal query",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) throw new Error("Usage: /memory-search <query>");
      const results = recallTurns({ entities: [query] });
      ctx.ui.notify(formatRecallResults(results, { entities: [query] }), "info");
    },
  });
  pi.registerCommand("memory-backfill", {
    description: "Import historical Pi, Claude Code, and Codex transcript sessions into the local index",
    handler: async (_args, ctx) => { _notifyBackfill(ctx, backfillAll(), "imported"); },
  });
  pi.registerCommand("project-session-migration", {
    description: "Convert current-project Codex sessions into separate native Pi sessions for /resume",
    handler: async (_args, ctx) => { _notifySessionMigration(ctx, "Codex", migrateCodexProjectSessions(ctx.sessionManager.getCwd())); },
  });
  pi.registerCommand("project-claude-session-migration", {
    description: "Convert current-project Claude Code sessions into separate native Pi sessions for /resume",
    handler: async (_args, ctx) => { _notifySessionMigration(ctx, "Claude Code", migrateClaudeProjectSessions(ctx.sessionManager.getCwd())); },
  });

  pi.registerTool({
    name: "migrate_codex_project_sessions", label: "Migrate Codex Project Sessions",
    description: "Convert each Codex session for the current project into a separate native Pi session selectable with /resume. Use only when the user explicitly wants native Pi continuation of prior Codex work.",
    promptSnippet: "Use only when the user explicitly requests native Pi continuation of this project's prior Codex sessions.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { const stats = migrateCodexProjectSessions(ctx.sessionManager.getCwd()); return { content: [{ type: "text" as const, text: _sessionMigrationSummary("Codex", stats) }], details: stats }; },
  });
  pi.registerTool({
    name: "migrate_claude_project_sessions", label: "Migrate Claude Code Project Sessions",
    description: "Convert each Claude Code session for the current project into a separate native Pi session selectable with /resume. Use only when the user explicitly wants native Pi continuation of prior Claude Code work.",
    promptSnippet: "Use only when the user explicitly requests native Pi continuation of this project's prior Claude Code sessions.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { const stats = migrateClaudeProjectSessions(ctx.sessionManager.getCwd()); return { content: [{ type: "text" as const, text: _sessionMigrationSummary("Claude Code", stats) }], details: stats }; },
  });
  pi.registerTool({
    name: "recall_memory", label: "Search Cross-Session History",
    description: "Search past Pi, Claude Code, and Codex transcript history using 2-8 specific literal entities. Call when the user explicitly asks about a prior discussion, or after the user agrees to search history. Returns every on-demand raw transcript match; results are never automatic prompt context.",
    promptSnippet: "Use 2-8 high-signal literal entities for a request about prior work. Search is on demand; fetch a smallest useful session range only when excerpts need context.",
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 8 }),
      sources: Type.Optional(Type.Array(Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex")]))),
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      after: Type.Optional(Type.Number()),
      before: Type.Optional(Type.Number()),
    }),
    async execute(_id, options) { const results = recallTurns(options); return { content: [{ type: "text" as const, text: formatRecallResults(results, options) }], details: { totalResults: results.length, results } }; },
  });
  pi.registerTool({
    name: "fetch_session", label: "Fetch Session",
    description: "Fetch ordered persisted transcript turns from a session returned by recall_memory. Use only when a recall excerpt lacks necessary context, and request the smallest useful inclusive range. This is read-only and never creates a memory.",
    promptSnippet: "Expand a recall result only when its excerpt is insufficient, using the smallest useful range. This reads source evidence only.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1, description: "Exact session ID returned by recall_memory." }), from_turn_index: Type.Optional(Type.Number({ minimum: 0 })), to_turn_index: Type.Optional(Type.Number({ minimum: 0 })) }),
    async execute(_id, { session_id, from_turn_index, to_turn_index }) {
      const { stored } = fetchSession(session_id, from_turn_index, to_turn_index);
      const header = `## Source transcript session ${stored.session.session_id}\n**Source:** ${stored.session.source} · **Project:** \`${stored.session.cwd}\`\n**Turns fetched:** ${stored.turns.length}\n**Storage action:** none. This is read-only source evidence.`;
      const turns = stored.turns.length ? stored.turns.map((turn) => [`### Turn ${turn.turn_index} · ${new Date(turn.ts).toLocaleString()}`, `**Source turn ID:** \`${turn.turn_id}\``, `**You:** ${turn.user_text}`, turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""].filter(Boolean).join("\n")).join("\n\n") : "No persisted turns in the requested range.";
      return { content: [{ type: "text" as const, text: `${header}\n\n${turns}` }], details: { session_id, from_turn_index, to_turn_index, turnCount: stored.turns.length, fetchedTurnIds: stored.turns.map((turn) => turn.turn_id) } };
    },
  });
  pi.registerTool({
    name: "get_memory_stats", label: "Get History Storage Statistics",
    description: "Report locally indexed cross-session transcript storage totals. Use when the user asks how much Pi, Claude Code, or Codex history is stored.",
    promptSnippet: "Use when the user asks for locally indexed history totals.", parameters: Type.Object({}),
    async execute() { const stats = getHistoryStats(); return { content: [{ type: "text" as const, text: _historyStatsSummary(stats) }], details: stats }; },
  });
  pi.registerTool({
    name: "backfill_memory", label: "Import Historical Sessions",
    description: "Import all historical Pi, Claude Code, and Codex transcript sessions into the local index. Use only when the user explicitly asks to import, backfill, or rescan history.",
    promptSnippet: "Use only for an explicit request to import, backfill, or rescan historical conversation data.", parameters: Type.Object({}),
    async execute() { const stats = backfillAll(); return { content: [{ type: "text" as const, text: _backfillSummary(stats, "imported") }], details: stats }; },
  });
}
function _historyStatsSummary(stats: ReturnType<typeof getHistoryStats>): string { const sources = stats.sources.length ? stats.sources.map((source) => `${source.source}: ${source.turns} turns / ${source.sessions} sessions`).join(", ") : "no imported sources"; const newest = stats.newestTs ? new Date(stats.newestTs).toLocaleString() : "n/a"; return `[session-memory] ${stats.turns} turns across ${stats.sessions} sessions; ${sources}; newest: ${newest}`; }
function _backfillSummary(stats: BackfillStats, action: string): string { return `[session-memory] ${action} ${stats.turns} turns from ${stats.scannedFiles} files: ${stats.pi} Pi, ${stats.claude} Claude, ${stats.codex} Codex sessions`; }
function _notifyBackfill(ctx: ExtensionContext, stats: BackfillStats, action: string): void { ctx.ui.notify(_backfillSummary(stats, action), "info"); for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error"); }
function _sessionMigrationSummary(sourceLabel: string, stats: ProjectSessionMigrationStats): string { return `[session-memory] migrated ${stats.migratedSessions} ${sourceLabel} sessions (${stats.migratedMessages} messages); skipped ${stats.skippedSessions} already migrated sessions from ${stats.scannedFiles} scanned files. Use /resume to select a migrated Pi session.`; }
function _notifySessionMigration(ctx: ExtensionContext, sourceLabel: string, stats: ProjectSessionMigrationStats): void { ctx.ui.notify(_sessionMigrationSummary(sourceLabel, stats), "info"); for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${sourceLabel} migration failed (${issue.path}): ${issue.error}`, "error"); }
