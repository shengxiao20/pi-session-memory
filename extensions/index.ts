import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeTurn } from "../src/writer.ts";
import { confirmMemory, createMemory, deleteMemory, deleteTurn, getMemoryHistory, getMemoryStats, getSession, listMemories, pinTurnAsMemory, supersedeMemory, type MemoryKind } from "../src/db.ts";
import { recallMemories, formatRecallResults, paginateRecallResults } from "../src/retriever.ts";
import { backfillAll, syncChangedHistory, type BackfillStats } from "../src/backfill.ts";
import { migrateCodexProjectSessions, type ProjectSessionMigrationStats } from "../src/session-migration.ts";
import { SESSION_MEMORY_HELP } from "../src/helper.ts";

/** Register lifecycle persistence, memory-management commands, and the recall tool with Pi. */
export default function (pi: ExtensionAPI) {

  /** Synchronize changed external session history whenever a Pi session starts. */
  pi.on("session_start", async (event, ctx) => {
    const stats = syncChangedHistory();
    if (event.reason === "startup" || stats.scannedFiles > 0) {
      const summary = stats.scannedFiles > 0
        ? `synced ${stats.turns} turns from ${stats.scannedFiles} changed session files`
        : "ready";
      ctx.ui.notify(
        `[session-memory] ${summary}. Run /pi-session-memory-helper for an overview of cross-client memory features.`,
        "info",
      );
    }
    for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error");
  });

  // ── Write: persist each completed agent run to SQLite ────────────────────
  /** Persist the just-completed live Pi turn after the agent has settled. */
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      writeTurn(ctx);
    } catch (err) {
      ctx.ui.notify(`[session-memory] write failed: ${String(err)}`, "error");
    }
  });

  pi.registerCommand("pi-session-memory-helper", {
    description: "Show pi-session-memory features and commands",
    /** Display the static pi-session-memory feature overview without invoking the model. */
    handler: async (_args, ctx) => {
      ctx.ui.notify(SESSION_MEMORY_HELP, "info");
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show local memory storage and source statistics",
    /** Report aggregate local-memory storage statistics. */
    handler: async (_args, ctx) => {
      const stats = getMemoryStats();
      const sources = stats.sources.length
        ? stats.sources.map((source) => `${source.source}: ${source.turns} turns / ${source.sessions} sessions`).join(", ")
        : "no imported sources";
      const newest = stats.newestTs ? new Date(stats.newestTs).toLocaleString() : "n/a";
      ctx.ui.notify(`[session-memory] ${stats.turns} turns across ${stats.sessions} sessions; ${sources}; newest: ${newest}`, "info");
    },
  });

  pi.registerCommand("memory-search", {
    description: "Search local memory with a literal query and show its first five results",
    /** Search stored memory from a literal command query without rendering the entire match set. */
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) throw new Error("Usage: /memory-search <query>");
      const entities = [query];
      const page = paginateRecallResults(recallMemories({ entities }));
      ctx.ui.notify(formatRecallResults(page.results, { entities }, page), "info");
    },
  });

  pi.registerCommand("remember", {
    description: "Create an explicit durable fact memory in the current project",
    /** Store user-authored reusable knowledge independently from transcript retention. */
    handler: async (args, ctx) => {
      const content = args.trim();
      if (!content) throw new Error("Usage: /remember <text>");
      const memory = createMemory({ kind: "fact", content, project_key: ctx.sessionManager.getCwd(), source_turn_id: null, importance: 1 });
      ctx.ui.notify(`[session-memory] remembered ${memory.memory_id}`, "info");
    },
  });

  pi.registerCommand("memory-pin", {
    description: "Promote a historical turn into a durable fact memory",
    /** Preserve a selected transcript turn as an independent durable memory with provenance. */
    handler: async (args, ctx) => {
      const turnId = args.trim();
      if (!turnId) throw new Error("Usage: /memory-pin <turn-id>");
      const memory = pinTurnAsMemory(turnId);
      ctx.ui.notify(`[session-memory] pinned ${turnId} as ${memory.memory_id}`, "info");
    },
  });

  pi.registerCommand("memory-list", {
    description: "List durable memories, optionally filtered by kind",
    /** Present durable memories and their provenance for direct management. */
    handler: async (args, ctx) => {
      const kind = args.trim() as MemoryKind | "";
      if (kind && !["preference", "decision", "fact", "project_state", "task", "lesson"].includes(kind)) {
        throw new Error("Usage: /memory-list [preference|decision|fact|project_state|task|lesson]");
      }
      const memories = listMemories(kind || undefined);
      const text = memories.length
        ? memories.map((memory) => `[${memory.kind}] ${memory.memory_id}: ${memory.content}${memory.source_turn_id ? ` (source: ${memory.source_turn_id})` : ""}`).join("\n")
        : "No durable memories found.";
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("memory-confirm", {
    description: "Confirm an active durable memory remains current",
    /** Explicitly acknowledge current evidence without rewriting the memory or its provenance. */
    handler: async (args, ctx) => {
      const memoryId = args.trim();
      if (!memoryId) throw new Error("Usage: /memory-confirm <memory-id>");
      const memory = confirmMemory(memoryId);
      ctx.ui.notify(`[session-memory] confirmed ${memory.memory_id}`, "info");
    },
  });

  pi.registerCommand("memory-supersede", {
    description: "Replace one durable memory with another while retaining history",
    /** Make supersession explicit so obsolete decisions remain inspectable instead of being silently overwritten. */
    handler: async (args, ctx) => {
      const [oldMemoryId, newMemoryId, ...extra] = args.trim().split(/\s+/);
      if (!oldMemoryId || !newMemoryId || extra.length) throw new Error("Usage: /memory-supersede <old-memory-id> <new-memory-id>");
      supersedeMemory(oldMemoryId, newMemoryId);
      ctx.ui.notify(`[session-memory] superseded ${oldMemoryId} with ${newMemoryId}`, "info");
    },
  });

  pi.registerCommand("memory-history", {
    description: "Show the replacement chain containing a durable memory",
    /** Render the full predecessor-to-successor chain for an active or superseded memory. */
    handler: async (args, ctx) => {
      const memoryId = args.trim();
      if (!memoryId) throw new Error("Usage: /memory-history <memory-id>");
      const history = getMemoryHistory(memoryId);
      ctx.ui.notify(history.map((memory) => `[${memory.superseded_by ? "superseded" : "active"}] ${memory.memory_id}: ${memory.content}`).join("\n"), "info");
    },
  });

  pi.registerCommand("memory-forget", {
    description: "Permanently delete a durable memory by memory ID",
    /** Delete only the selected durable memory; its provenance turn is retained. */
    handler: async (args, ctx) => {
      const memoryId = args.trim();
      if (!memoryId) throw new Error("Usage: /memory-forget <memory-id>");
      if (!deleteMemory(memoryId)) throw new Error(`Durable memory not found: ${memoryId}`);
      ctx.ui.notify(`[session-memory] forgot ${memoryId}`, "info");
    },
  });

  pi.registerCommand("memory-delete-turn", {
    description: "Permanently delete a raw transcript turn by turn ID",
    /** Keep raw transcript deletion explicit and separate from durable-memory deletion. */
    handler: async (args, ctx) => {
      const turnId = args.trim();
      if (!turnId) throw new Error("Usage: /memory-delete-turn <turn-id>");
      if (!deleteTurn(turnId)) throw new Error(`Memory turn not found: ${turnId}`);
      ctx.ui.notify(`[session-memory] deleted transcript turn ${turnId}`, "info");
    },
  });

  pi.registerCommand("memory-backfill", {
    description: "Import historical Pi, Claude Code, and Codex sessions into memory.db",
    /** Force a full historical import regardless of saved source-file fingerprints. */
    handler: async (_args, ctx) => {
      _notifyBackfill(ctx, backfillAll(), "imported");
    },
  });

  pi.registerCommand("project-session-migration", {
    description: "Convert this project's Codex sessions into separate Pi sessions that can be resumed",
    /** Create independently resumable Pi session JSONL files from current-project Codex sessions. */
    handler: async (_args, ctx) => {
      _notifySessionMigration(ctx, migrateCodexProjectSessions(ctx.sessionManager.getCwd()));
    },
  });

  pi.registerTool({
    name: "migrate_codex_project_sessions",
    label: "Migrate Codex Project Sessions",
    description: "Convert each Codex session for the current project into a separate native Pi session that the user can select with /resume. Call only when the user explicitly wants to continue prior Codex work as a resumable Pi session. This does not index history for recall_memory and must not be used for ordinary cross-client recall or durable-memory requests.",
    promptSnippet: "Convert this project's Codex sessions into separately resumable Pi sessions only when the user explicitly requests native Pi continuation.",
    parameters: Type.Object({}),
    /** Give the agent the same native Codex-to-Pi migration available through /project-session-migration. */
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const stats = migrateCodexProjectSessions(ctx.sessionManager.getCwd());
      return {
        content: [{ type: "text" as const, text: _sessionMigrationSummary(stats) }],
        details: stats,
      };
    },
  });

  // ── Read: recall_memory tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "recall_memory",
    label: "Recall Memory",
    description: `Search this user's past conversation history across Pi, Claude Code, and Codex using high-signal literal entities. Entities are OR alternatives: any entity may recall a result, and results matching more entities rank higher. Scope filters only narrow the local search.

Invocation policy:
1. Call this tool immediately when the user explicitly asks to review, remember, summarize, continue, or compare a previous discussion about a topic. Examples:
   - "我之前关于 xxx 的实践" / "I previously worked on xxx"
   - "上次我们讨论过..." / "last time we discussed..."
   - "你还记得那个 xxx 项目吗" / "remember that xxx project?"
   - "之前那个方案怎么说的" / "what was that plan we had?"
2. When you cannot confidently answer from the current conversation and your general knowledge, but the user may have discussed the topic in prior sessions, first ask whether they want you to search their conversation history. Call this tool only after they agree.
3. Do not search history merely because a question is difficult when the user's prior discussions are not relevant.
4. Use 2–8 specific, high-signal literal entities, not the user's entire request or generic conversational words such as "问题", "开发", "有哪些", or "help". Include useful aliases, abbreviations, or Chinese/English equivalents where relevant, for example ["bug", "缺陷", "错误", "fix", "修复"].
5. If a recall returns no results, use your judgment to make up to two additional recall calls before concluding the history has no answer. Each retry must use distinct entities chosen from semantic alternatives: abbreviations or expansions, aliases, translations, product or project names, and likely wording of the underlying task or decision. For example, after no result for "SAP BTP", try alternatives such as "BTP", "Business Technology Platform", and the specific platform/topic implied by the user's question.
6. Preserve every source, project, and time filter from the original request on retries. Do not repeat equivalent entities, search indefinitely, claim a result that was not returned, or say history was searched exhaustively after fewer than three total attempts.

Memory-aware response policy:
1. Treat returned durable memories as reusable evidence, not as invisible context. In your natural-language answer, briefly state the relevant remembered conclusion and identify its source turn/session when that provenance matters to the answer.
2. A durable memory can report \`source_session_changed\` when its original session has later activity; this alone does not mean the memory is stale. When it includes **Newer evidence to compare**, compare that evidence with the memory: it may confirm, supplement, conflict with, or replace the old conclusion. Evidence can come from another newer session as well as the original session. Do not claim that the memory was updated, confirmed, or superseded unless the user explicitly chose that action.
3. After explaining a meaningful comparison, offer clear control: keep the current memory, confirm that it remains current, or create/pin a replacement and supersede the old memory. Ask which outcome they want before any persistent memory-management action.
4. When an existing durable memory resolves the question and has no comparison evidence, use it directly and avoid repeating its identical source turn. Do not mention memory mechanics unless provenance or evidence comparison is useful to the user.
5. Slash commands are user-controlled management actions. Do not instruct the user to execute a command merely to answer their question; mention the relevant command only when they want to inspect, confirm, replace, or delete a memory.

Session-expansion policy:
1. \`recall_memory\` is a discovery tool. Raw-turn results are intentionally short excerpts with session ID and turn index.
2. Call \`fetch_session\` only when a candidate's surrounding conversation is necessary to answer accurately, verify a conclusion, resolve a conflict, or inspect context around a matched turn. Use its turn bounds to request the smallest useful range.
3. Do not fetch a session when a durable memory or returned excerpt already answers the question. Do not fetch unrelated sessions merely because they were listed.

Pagination policy:
1. Each invocation returns five results. Local retrieval still evaluates every match before selecting that page.
2. When the result reports a \`nextOffset\`, call \`recall_memory\` again with the exact same entities and scope filters plus that offset only when more candidates are needed. Do not request pages merely to exhaust the result set.

Extract 2–8 specific, high-signal entities from the user's topic: project names, tool names, technologies, domain terms, identifiers, and useful Chinese/English equivalents, aliases, or abbreviations.`,
    promptSnippet: "Search cross-client Pi, Claude Code, and Codex history when the user asks about prior discussions or work.",

    parameters: Type.Object({
      entities: Type.Array(
        Type.String({ minLength: 1 }),
        {
          description: 'Two to eight high-signal literal search alternatives. Results may match any entity; include useful Chinese/English equivalents, aliases, or abbreviations. E.g. ["pi-session-memory", "bug", "缺陷", "错误", "fix", "修复"].',
          minItems: 2,
          maxItems: 8,
        },
      ),
      sources: Type.Optional(Type.Array(Type.Union([
        Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex"),
      ]))),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Exact project working directory to restrict results." })),
      after: Type.Optional(Type.Number({ description: "Inclusive Unix timestamp in milliseconds." })),
      before: Type.Optional(Type.Number({ description: "Inclusive Unix timestamp in milliseconds." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset. Each call returns five results; use the returned nextOffset with identical search and filter inputs only when more candidates are needed." })),
    }),

    /** Resolve an agent memory request into one explicit page of a fully evaluated local result set. */
    async execute(_toolCallId, { entities, sources, cwd, after, before, offset }) {
      const results = recallMemories({ entities, sources, cwd, after, before });
      const page = paginateRecallResults(results, offset);
      const text = formatRecallResults(page.results, { entities, sources, cwd, after, before }, page);
      return {
        content: [{ type: "text" as const, text }],
        details: { entities, sources, cwd, after, before, offset: page.offset, pageSize: page.results.length, totalResults: page.totalResults, nextOffset: page.nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "fetch_session",
    label: "Fetch Session",
    description: "Fetch ordered persisted conversation turns for one session returned by recall_memory. Use only when the candidate excerpt or durable memory is insufficient and surrounding context is necessary. Request the smallest useful inclusive turn-index range.",
    promptSnippet: "Expand only a recall_memory result when its excerpt is insufficient; request the smallest useful turn range.",
    parameters: Type.Object({
      session_id: Type.String({ minLength: 1, description: "Exact session ID returned by recall_memory." }),
      from_turn_index: Type.Optional(Type.Number({ minimum: 0, description: "Optional inclusive first turn index." })),
      to_turn_index: Type.Optional(Type.Number({ minimum: 0, description: "Optional inclusive last turn index." })),
    }),
    /** Expand a specifically selected persisted session without coupling search ranking to context payload size. */
    async execute(_toolCallId, { session_id, from_turn_index, to_turn_index }) {
      const stored = getSession(session_id, from_turn_index, to_turn_index);
      const header = `## Session ${stored.session.session_id}\n**Source:** ${stored.session.source} · **Project:** \`${stored.session.cwd}\`\n**Turns:** ${stored.turns.length}`;
      const turns = stored.turns.length
        ? stored.turns.map((turn) => [
          `### Turn ${turn.turn_index} · ${new Date(turn.ts).toLocaleString()}`,
          `**You:** ${turn.user_text}`,
          turn.reply_text ? `**Assistant:** ${turn.reply_text}` : "",
        ].filter(Boolean).join("\n")).join("\n\n")
        : "No persisted turns in the requested range.";
      return {
        content: [{ type: "text" as const, text: `${header}\n\n${turns}` }],
        details: { session_id, from_turn_index, to_turn_index, turnCount: stored.turns.length },
      };
    },
  });
}

/** Present one backfill result consistently for user commands and agent tool calls. */
function _backfillSummary(stats: BackfillStats, action: string): string {
  return `[session-memory] ${action} ${stats.turns} turns from ${stats.scannedFiles} files: ${stats.pi} Pi, ${stats.claude} Claude, ${stats.codex} Codex sessions`;
}

/** Notify command users of one backfill summary and every isolated import issue. */
function _notifyBackfill(ctx: ExtensionContext, stats: BackfillStats, action: string): void {
  ctx.ui.notify(_backfillSummary(stats, action), "info");
  for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error");
}

/** Report native Codex-to-Pi session migration results and isolated conversion failures. */
function _notifySessionMigration(ctx: ExtensionContext, stats: ProjectSessionMigrationStats): void {
  ctx.ui.notify(_sessionMigrationSummary(stats), "info");
  for (const issue of stats.issues) ctx.ui.notify(`[session-memory] Codex migration failed (${issue.path}): ${issue.error}`, "error");
}

/** Format a concise native-session migration result for commands and tools. */
function _sessionMigrationSummary(stats: ProjectSessionMigrationStats): string {
  return `[session-memory] migrated ${stats.migratedSessions} Codex sessions (${stats.migratedMessages} messages); skipped ${stats.skippedSessions} already migrated sessions from ${stats.scannedFiles} scanned files. Use /resume to select a migrated Pi session.`;
}
