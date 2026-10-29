import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeTurn } from "../src/writer.ts";
import { getHistoryStats } from "../src/db.ts";
import { fetchSession } from "../src/fetch-session.ts";
import { formatRecallResults, recallTurns } from "../src/retriever.ts";
import { exportSearchResultsToObsidian } from "../src/obsidian-export.ts";
import { formatProjectRecallResults, recallProjectMemory } from "../src/project-retriever.ts";
import { recallSequentially } from "../src/recall-workflow.ts";
import { backfillAll, syncChangedHistory, type BackfillStats } from "../src/backfill.ts";
import { migrateClaudeProjectSessions, migrateCodexProjectSessions, type ProjectSessionMigrationStats } from "../src/session-migration.ts";
import { SESSION_MEMORY_HELP } from "../src/helper.ts";
import { getWhatsNew, showWhatsNewIfUpdated } from "../src/whats-new.ts";
import { getSessionMemoryConfig } from "../src/config.ts";
import { CONFIG_SUMMARY_PREFIX, withConfigSummary } from "../src/tool-config-summary.ts";
import { JevRuntime } from "../src/jev-runtime.ts";
import { filterRecallWithJev, type JevFilterStats } from "../src/jev-filter.ts";
import packageJson from "../package.json" with { type: "json" };

/** Register local cross-session transcript retrieval and source-session migration features. */
export default function (pi: ExtensionAPI) {
  const jevRuntime = new JevRuntime();
  const registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(withConfigSummary(tool));
  pi.on("session_start", async (_event, ctx) => {
    try {
      const whatsNew = showWhatsNewIfUpdated(packageJson.version);
      if (whatsNew) ctx.ui.notify(whatsNew, "info");
      const stats = syncChangedHistory();
      const config = getSessionMemoryConfig();
      const jev = await jevRuntime.ensureReady(config.jevEnable, config.model, config.jevConnection);
      if (jev.state === "ready") ctx.ui.notify(`[session-memory] jev is ready to review recalled turns with ${config.model}.`, "info");
      if (jev.state === "unavailable") ctx.ui.notify(`[session-memory] jev unavailable; literal recall remains active: ${jev.reason}`, "warning");
      for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error");
    } catch (err) { ctx.ui.notify(`[session-memory] history sync failed: ${String(err)}`, "error"); }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try { writeTurn(ctx); } catch (err) { ctx.ui.notify(`[session-memory] write failed: ${String(err)}`, "error"); }
  });
  pi.on("session_shutdown", () => { jevRuntime.shutdown(); });

  pi.registerCommand("pi-session-memory", {
    description: "Open a selectable menu for local history search, indexing, migration, help, and release notes",
    handler: async (_args, ctx) => { await _openSessionMemoryMenu(ctx); },
  });

  registerTool({
    name: "migrate_project_sessions", label: "Migrate Project Sessions",
    description: "Convert current-project Claude Code and Codex sessions into separate native Pi sessions selectable with /resume. Use only when the user explicitly wants native Pi continuation; omit sources to migrate both, or select only the requested source.",
    promptSnippet: "Use only when the user explicitly requests native Pi continuation of prior Claude Code or Codex work. Omit sources to migrate both.",
    parameters: Type.Object({
      sources: Type.Optional(Type.Array(Type.Union([Type.Literal("claude"), Type.Literal("codex")]), { minItems: 1, uniqueItems: true, description: "Sources to migrate; omit to migrate both Claude Code and Codex." })),
    }),
    async execute(_id, { sources }, _signal, _update, ctx) {
      const migrations = _migrateProjectSources(ctx.sessionManager.getCwd(), sources);
      return { content: [{ type: "text" as const, text: _projectMigrationSummary(migrations) }], details: migrations };
    },
  });
  registerTool({
    name: "recall_memory", label: "Recall History · Global → Project",
    description: "Use for any question about prior conversations or prior work. One call with 2-8 literal topic entities and the complete question automatically searches all indexed Pi, Claude Code, and Codex turns globally, then uses those same entities to discover stored session CWD final-directory names and search only matched sessions. Each stage keeps its existing ranking, limit, and optional Jev filtering. After both stages finish, project results are deduplicated by the turn_id values actually returned globally; removed results are not refilled. Global and project results are displayed separately. No current Pi session, project, CWD, source, session, or time context is used; no separate project recall call is needed.",
    promptSnippet: "For every prior-conversation or prior-work question, call recall_memory once with literal entities and the complete question. It automatically runs global recall first, then entity-discovered project recall, removing already-returned turn IDs from final project output. Never scope or infer from the current Pi session, project, or CWD.",
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1, description: "Literal topic entities used for both global transcript search and stored session directory-name discovery, then transcript search in those discovered sessions." }), { minItems: 2, maxItems: 8 }),
      question: Type.String({ minLength: 1, description: "The complete user question used by optional Jev filtering in both recall stages." }),
    }),
    async execute(_id, options, _signal, update) {
      const { global, project } = await recallSequentially(
        options,
        (question, results, progress) => _reviewWithJev(jevRuntime, question, results, progress),
        (progress) => update?.({ content: [{ type: "text", text: progress.message }], details: progress }),
      );
      const globalText = _recallStageText(`Global recall · returned turns: ${global.results.length}`, global.stats, formatRecallResults(global.results, options));
      const projectResultsText = project.results.length
        ? formatProjectRecallResults(project, options)
        : "No additional project turns returned after the existing project search, optional Jev review, and exact turn_id deduplication.";
      const projectText = _recallStageText(`Project recall · new turns: ${project.results.length} · duplicates removed: ${project.duplicatesRemoved}`, project.stats, projectResultsText);
      _exportSearchResultsIfEnabled("Recall search", `${globalText}\n\n${projectText}`);
      return {
        content: [{ type: "text" as const, text: globalText }, { type: "text" as const, text: projectText }],
        details: {
          returnedResults: global.results.length + project.results.length,
          global: { returnedResults: global.results.length, results: global.results, jev: global.stats, jevFilteredOut: global.filteredOut },
          project: { totalSessions: project.sessions.length, returnedResults: project.results.length, sessions: project.sessions, results: project.results, duplicatesRemoved: project.duplicatesRemoved, jev: project.stats, jevFilteredOut: project.filteredOut },
        },
      };
    },
    renderResult(result, { expanded, isPartial }, theme, { isError }) {
      const text = result.content.filter((block) => block.type === "text").map((block) =>
        expanded || isPartial || isError || block.text.startsWith(CONFIG_SUMMARY_PREFIX) ? block.text : block.text.split("\n")[0].replace(/^# /, ""),
      ).join("\n\n");
      // Style each line so terminal default colors cannot obscure the tool result.
      return new Text(text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
    },
  });
  registerTool({
    name: "review_jev_filtered", label: "Review Jev-Filtered Recall Evidence",
    description: "Re-run global and entity-discovered project-session literal recall and display only turns Jev filtered out, with each turn's maximum Jev noul relevance. Use when auditing possible Jev false negatives after recall; supply the same entities and question.",
    promptSnippet: "Use only to inspect possible Jev false negatives after recall. Reuse the original entities and complete question; no runtime or project parameter is available.",
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 8 }),
      question: Type.String({ minLength: 1, description: "The complete original user question used for Jev relevance judgment." }),
    }),
    async execute(_id, options, _signal, update) {
      const globalLiteral = recallTurns(options.entities);
      const projectLiteral = recallProjectMemory({ entities: options.entities }).results;
      const literal = [...new Map([...globalLiteral, ...projectLiteral].map((turn) => [turn.turn_id, turn])).values()];
      const reviewed = await _reviewWithJev(jevRuntime, options.question, literal, (message) => update({ content: [{ type: "text", text: message }] }));
      const text = `${_jevSummary(reviewed.stats)}\n\n${_formatJevFilteredOut(reviewed.filteredOut)}`;
      _exportSearchResultsIfEnabled("Jev filtered recall search", text);
      return { content: [{ type: "text" as const, text }], details: { returnedResults: reviewed.filteredOut.length, results: reviewed.filteredOut, jev: reviewed.stats } };
    },
  });
  registerTool({
    name: "fetch_session",  label: "Fetch Session",
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
  registerTool({
    name: "get_memory_stats", label: "Get History Storage Statistics",
    description: "Report locally indexed cross-session transcript storage totals. Use when the user asks how much Pi, Claude Code, or Codex history is stored.",
    promptSnippet: "Use when the user asks for locally indexed history totals.", parameters: Type.Object({}),
    async execute() { const stats = getHistoryStats(); return { content: [{ type: "text" as const, text: _historyStatsSummary(stats) }], details: stats }; },
  });
  registerTool({
    name: "backfill_memory", label: "Import Historical Sessions",
    description: "Import all historical Pi, Claude Code, and Codex transcript sessions into the local index. Use only when the user explicitly asks to import, backfill, or rescan history.",
    promptSnippet: "Use only for an explicit request to import, backfill, or rescan historical conversation data.", parameters: Type.Object({}),
    async execute() { const stats = backfillAll(); return { content: [{ type: "text" as const, text: _backfillSummary(stats, "imported") }], details: stats }; },
  });
}
const SESSION_MEMORY_ACTIONS = {
  help: "Help — explain history search, indexing, and migration",
  whatsNew: `What's new — pi-session-memory v${packageJson.version}`,
  status: "Storage status — show indexed session and turn totals",
  search: "Search history — search global history with Chinese | English topics",
  projectSearch: "Search project history — discover a named project by session directory name",
  backfill: "Import historical sessions — rescan Pi, Claude Code, and Codex history",
  migrate: "Migrate project sessions — make Claude Code and Codex sessions available in /resume",
} as const;

/** Open every manual pi-session-memory capability from one selectable slash-command menu. */
async function _openSessionMemoryMenu(ctx: ExtensionCommandContext): Promise<void> {
  const selection = await ctx.ui.select("pi-session-memory", Object.values(SESSION_MEMORY_ACTIONS));
  if (!selection) return;
  if (selection === SESSION_MEMORY_ACTIONS.help) return ctx.ui.notify(SESSION_MEMORY_HELP, "info");
  if (selection === SESSION_MEMORY_ACTIONS.whatsNew) return ctx.ui.notify(getWhatsNew(packageJson.version) || `No published What's New notes for pi-session-memory v${packageJson.version}.`, "info");
  if (selection === SESSION_MEMORY_ACTIONS.status) return ctx.ui.notify(_historyStatsSummary(getHistoryStats()), "info");
  if (selection === SESSION_MEMORY_ACTIONS.backfill) return _notifyBackfill(ctx, backfillAll(), "imported");
  if (selection === SESSION_MEMORY_ACTIONS.migrate) return _notifyProjectMigration(ctx, _migrateProjectSources(ctx.sessionManager.getCwd()));
  if (selection === SESSION_MEMORY_ACTIONS.search) return _searchHistoryFromMenu(ctx);
  return _searchProjectHistoryFromMenu(ctx);
}

async function _searchHistoryFromMenu(ctx: ExtensionCommandContext): Promise<void> {
  const entities = _bilingualTopics(await ctx.ui.input("Search local history", "Chinese topic | English topic"));
  if (!entities) return;
  const results = recallTurns({ entities });
  const text = formatRecallResults(results, { entities });
  ctx.ui.notify(text, "info");
  _exportSearchResultsIfEnabled("Menu recall search", text);
}

async function _searchProjectHistoryFromMenu(ctx: ExtensionCommandContext): Promise<void> {
  const entities = _bilingualTopics(await ctx.ui.input("Search project session names and turns", "Chinese topic | English topic"));
  if (!entities) return;
  const options = { entities };
  const projectResults = recallProjectMemory(options);
  const text = formatProjectRecallResults(projectResults, options);
  ctx.ui.notify(text, "info");
  _exportSearchResultsIfEnabled("Menu project recall search", text);
}

function _exportSearchResultsIfEnabled(title: string, content: string): void {
  const config = getSessionMemoryConfig();
  if (!config.obsidianExportEnabled) return;
  exportSearchResultsToObsidian(config.obsidianVaultPath!, title, content);
}

function _bilingualTopics(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entities = value.split(/\s+\|\s+/).map((topic) => topic.trim()).filter(Boolean);
  if (entities.length !== 2) throw new Error("Enter exactly two topics as <Chinese topic> | <English topic>");
  return entities;
}

function _historyStatsSummary(stats: ReturnType<typeof getHistoryStats>): string { const sources = stats.sources.length ? stats.sources.map((source) => `${source.source}: ${source.turns} turns / ${source.sessions} sessions`).join(", ") : "no imported sources"; const newest = stats.newestTs ? new Date(stats.newestTs).toLocaleString() : "n/a"; return `[session-memory] ${stats.turns} turns across ${stats.sessions} sessions; ${sources}; newest: ${newest}`; }
function _backfillSummary(stats: BackfillStats, action: string): string { return `[session-memory] ${action} ${stats.turns} turns from ${stats.scannedFiles} files: ${stats.pi} Pi, ${stats.claude} Claude, ${stats.codex} Codex sessions`; }
function _notifyBackfill(ctx: ExtensionContext, stats: BackfillStats, action: string): void { ctx.ui.notify(_backfillSummary(stats, action), "info"); for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error"); }
type ProjectMigrationSource = "claude" | "codex";
type ProjectMigrationResults = Record<ProjectMigrationSource, ProjectSessionMigrationStats>;

function _migrateProjectSources(cwd: string, sources: ProjectMigrationSource[] = ["claude", "codex"]): Partial<ProjectMigrationResults> {
  return Object.fromEntries(sources.map((source) => [source, source === "claude" ? migrateClaudeProjectSessions(cwd) : migrateCodexProjectSessions(cwd)])) as Partial<ProjectMigrationResults>;
}
function _projectMigrationSummary(migrations: Partial<ProjectMigrationResults>): string {
  const summaries = Object.entries(migrations).map(([source, stats]) => {
    const label = source === "claude" ? "Claude Code" : "Codex";
    return `${label}: ${stats.migratedSessions} migrated, ${stats.skippedSessions} skipped, ${stats.migratedMessages} messages from ${stats.scannedFiles} files`;
  });
  return `[session-memory] project session migration complete — ${summaries.join("; ")}. Use /resume to select a migrated Pi session.`;
}
function _notifyProjectMigration(ctx: ExtensionContext, migrations: Partial<ProjectMigrationResults>): void {
  ctx.ui.notify(_projectMigrationSummary(migrations), "info");
  for (const [source, stats] of Object.entries(migrations)) for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${source} migration failed (${issue.path}): ${issue.error}`, "error");
}

async function _reviewWithJev(runtime: JevRuntime, question: string, results: import("../src/retriever.ts").RecallTurnResult[], progress: (message: string) => void): Promise<{ results: import("../src/retriever.ts").RecallTurnResult[]; filteredOut: import("../src/jev-filter.ts").JevFilteredOutTurn[]; stats: JevFilterStats }> {
  const config = getSessionMemoryConfig();
  if (!config.jevEnable) return { results, filteredOut: [], stats: { status: "disabled", model: config.model, contextWindow: 0, reviewed: 0, retained: results.length, filtered: 0, truncated: 0, reason: "jevEnable is false" } };
  const status = await runtime.ensureReady(true, config.model, config.jevConnection);
  if (status.state !== "ready") return { results, filteredOut: [], stats: { status: "unavailable", model: config.model, contextWindow: 0, reviewed: 0, retained: results.length, filtered: 0, truncated: 0, reason: status.reason ?? "Jev runtime is not ready" } };
  progress(`[session-memory] jev reviewing ${results.length} recalled turns…`);
  try {
    const filtered = await filterRecallWithJev(runtime, question, results);
    progress(`[session-memory] jev retained ${filtered.stats.retained} of ${filtered.stats.reviewed} recalled turns; filtered ${filtered.stats.filtered}.`);
    return filtered;
  } catch (error) {
    runtime.markUnavailable(error);
    const reason = String(error);
    progress(`[session-memory] jev unavailable; literal recall remains active: ${reason}`);
    return { results, filteredOut: [], stats: { status: "unavailable", model: config.model, contextWindow: 0, reviewed: 0, retained: results.length, filtered: 0, truncated: 0, reason } };
  }
}

function _formatJevFilteredOut(filteredOut: import("../src/jev-filter.ts").JevFilteredOutTurn[]): string {
  const header = `# Jev filtered-out evidence\n**Turns:** ${filteredOut.length}\n**Interpretation:** noul relevance is Jev's probability that a turn is directly relevant. The displayed value is the maximum noul across this turn's segments; values below 0.5 were excluded from normal recall.`;
  const turns = filteredOut.length
    ? filteredOut.map(({ turn, noul }) => `## Filtered turn · noul relevance ${noul.toFixed(3)}\n**Fetch session ID:** \`${turn.session_id}\`\n**Source turn ID:** \`${turn.turn_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n")
    : "No turns were filtered out by Jev.";
  return `${header}\n\n${turns}`;
}

function _recallStageText(title: string, stats: JevFilterStats, recallText: string): string {
  const status = stats.status === "disabled" ? "" : ` · Jev: ${stats.status}`;
  return `# ${title}${status}\n\n${_withOptionalJevSummary(stats, recallText)}`;
}

function _withOptionalJevSummary(stats: JevFilterStats, recallText: string): string {
  return stats.status === "disabled" ? recallText : `${_jevSummary(stats)}\n\n${recallText}`;
}

function _jevSummary(stats: JevFilterStats): string {
  const reason = stats.reason ? `\n**Reason:** ${stats.reason}` : "";
  return `# Jev result\n**Status:** ${stats.status}\n**Model:** ${stats.model}\n**Context window:** ${stats.contextWindow || "unavailable"} tokens\n**Reviewed:** ${stats.reviewed}\n**Retained:** ${stats.retained}\n**Filtered:** ${stats.filtered}\n**Segmented turns:** ${stats.truncated}${reason}`;
}
