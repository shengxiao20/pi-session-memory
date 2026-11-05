import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeTurn } from "../src/writer.ts";
import { getHistoryStats } from "../src/db.ts";
import { fetchTurnContext } from "../src/fetch-turn-context.ts";
import { formatRecallResults, recallTurns } from "../src/retriever.ts";
import { MemoryOutput, OKF_OUTPUT_NOTICE } from "../src/memory-output.ts";
import { MemoryContext, withMemoryContext } from "../src/memory-context.ts";
import { KNOWLEDGE_FIRST_NOTICE } from "../src/memory-knowledge.ts";
import { registerMemoryKnowledgeTools } from "../src/memory-knowledge-tools.ts";
import { meetingConclusionSchema } from "../src/meeting-conclusion-schema.ts";
import { registerSetupTools } from "../src/setup-tools.ts";
import { SETUP_REQUEST } from "../src/setup.ts";
import { recallSequentially } from "../src/recall-workflow.ts";
import { backfillAll, syncChangedHistory, type BackfillStats } from "../src/backfill.ts";
import { migrateClaudeProjectSessions, migrateCodexProjectSessions, type ProjectSessionMigrationStats } from "../src/session-migration.ts";
import { notifyMemoryToolCleanup, registerMemoryCleanupTools } from "../src/memory-index-cleanup-tools.ts";
import { formatProjectRecallResults, recallProjectMemory } from "../src/project-retriever.ts";
import { validateRecallQuery } from "../src/recall-query.ts";
import { getSessionMemoryConfig, getEnabledConsultation } from "../src/config.ts";
import { ConsultationRuntime } from "../src/consultation-runtime.ts";
import { registerConsultationTools } from "../src/consultation-tools.ts";
import { ConsultationPresentation } from "../src/consultation-presentation.ts";
import { consultationGuidance } from "../src/consultation-guidance.ts";
import { CONFIG_SUMMARY_PREFIX, withConfigSummary } from "../src/tool-config-summary.ts";
import { JevRuntime } from "../src/jev-runtime.ts";
import { filterRecallWithJev, type JevFilterStats } from "../src/jev-filter.ts";

/** Register local cross-session transcript retrieval and source-session migration features. */
export default function (pi: ExtensionAPI) {
  const output = new MemoryOutput();
  const memory = new MemoryContext();
  pi.on("context", (event) => ({ messages: memory.inject(event.messages) }));
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") return { message: memory.finalize(output.finalize(event.message)) };
  });
  const jevRuntime = new JevRuntime();
  const consultationRuntime = new ConsultationRuntime();
  const consultationPresentation = new ConsultationPresentation();
  const registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(withMemoryContext(withConfigSummary(tool), memory));
  pi.on("session_start", async (_event, ctx) => {
    output.reset(); memory.reset();
    consultationPresentation.restore(ctx.sessionManager.getBranch());
    try {
      const stats = syncChangedHistory();
      for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error");
    } catch (err) {
      ctx.ui.notify(`[session-memory] history sync failed: ${String(err)}`, "error");
      return;
    }
    let config: ReturnType<typeof getSessionMemoryConfig>;
    try { config = getSessionMemoryConfig(); }
    catch (err) {
      ctx.ui.notify(`[session-memory] configuration failed: ${String(err)}. Ask the agent to run setup_memory and create or repair the configuration after approval. No configuration was created and no default settings were enabled.`, "error");
      return;
    }
    try {
      const jev = await jevRuntime.ensureReady(config.jevEnable, config.model, config.jevConnection);
      if (jev.state === "ready") ctx.ui.notify(`[session-memory] jev is ready to review recalled turns with ${config.model}.`, "info");
      if (jev.state === "unavailable") ctx.ui.notify(`[session-memory] jev unavailable; literal recall remains active: ${jev.reason}`, "warning");
    } catch (err) { ctx.ui.notify(`[session-memory] jev startup failed: ${String(err)}`, "error"); }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try { await consultationRuntime.close(); } finally { output.reset(); memory.reset(); }
    try { writeTurn(ctx); } catch (err) { ctx.ui.notify(`[session-memory] write failed: ${String(err)}`, "error"); }
  });
  pi.on("session_shutdown", async () => { jevRuntime.shutdown(); try { await consultationRuntime.close(); } finally { output.reset(); memory.reset(); } });
  pi.on("session_before_switch", async () => { try { await consultationRuntime.close(); } finally { output.reset(); memory.reset(); } });
  registerConsultationTools(registerTool, consultationRuntime, consultationPresentation, output);
  registerSetupTools((tool) => pi.registerTool(withMemoryContext(tool, memory)));
  registerMemoryKnowledgeTools(registerTool, output);

  pi.registerCommand("pi-session-memory", {
    description: "Open setup, history import, project-session migration, or indexed-tool-turn cleanup. Transcript search is handled by Agent tools.",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("/pi-session-memory accepts no arguments");
      await _openSessionMemoryMenu(pi, ctx);
    },
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
    name: "recall_memory", label: "Recall History · Global → Project", executionMode: "sequential",
    description: "Use only when the user explicitly asks to look back at earlier work or historical conversations, and inspect_memory_knowledge found no clearly matching saved document. Do not call for ordinary questions or merely because a topic appeared before. One call with 2-8 literal topic entities, a required primary_entity and the complete question automatically searches all indexed Pi, Claude Code, and Codex turns globally, then uses those same entities to discover stored session CWD final-directory names and search only matched sessions. Each stage adds +10 once per turn for a case-insensitive literal match of primary_entity before ranking and limiting results. Retain a complete core phrase verbatim from the user question as primary_entity and include it in entities; do not split, translate or paraphrase it. Other unique entity matches add +1 each. Each stage keeps its existing limit and optional Jev filtering. After both stages finish, project results are deduplicated by the turn_id values actually returned globally; removed results are not refilled. Global and project results are displayed separately. No current Pi session, project, CWD, source, session, or time context is used to scope retrieval; no separate project recall call is needed. When enableDiscussion is true in configuration, show up to three native Pi candidate sessions and their indexed evidence in a TUI checklist. Resume only user-confirmed sessions for sequential private consultation, excluding the active main session. Return consultation answers instead of raw recall sections for this request only. Consultation uses in-memory copies of original sessions and never appends questions or answers to their JSONL files. Intermediate results reach the main model through temporary context; only lightweight tool records and final OKF text are persisted. Compare answers, optionally follow up privately, then save OKF minutes or cancel within this run. Remaining participants are released when the main agent settles. Do not automatically replace consultation with transcript fetching.",
    promptSnippet: "For explicit user look-back requests only, after saved OKF descriptions show no clear match. Call once with literal entities, primary_entity and the complete question. Keep the complete core phrase verbatim. Global recall runs before entity-discovered project recall; never infer scope from the current session or CWD. Discussion uses user-confirmed sessions, not transcript fallback.",
    promptGuidelines: [KNOWLEDGE_FIRST_NOTICE, OKF_OUTPUT_NOTICE],
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1, description: "Literal topic entities used for both global transcript search and stored session directory-name discovery, then transcript search in those discovered sessions." }), { minItems: 2, maxItems: 8 }),
      primary_entity: Type.String({ minLength: 1, description: "Complete core name or phrase copied verbatim from question, not split, translated or paraphrased. Must also occur in entities. Its case-insensitive literal match adds +10 once per turn before ranking and LIMIT." }),
      question: Type.String({ minLength: 1, description: "The complete user question containing primary_entity verbatim, also used by optional Jev filtering in both recall stages." }),
    }),
    async execute(_id, options, signal, update, ctx) {
      const consultationConfig = getEnabledConsultation();
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
      if (consultationConfig) {
        const consultation = await consultationRuntime.start([...global.results, ...project.results], options.question, ctx, signal);
        consultationPresentation.remember(consultation);
        if (consultation.consultation_id !== null) output.startDiscussion();
        return {
          content: [{ type: "text" as const, text: `## Private historical-session consultation\n${JSON.stringify(consultation, null, 2)}\n${consultationGuidance(consultation.consultation_id)}` }],
          details: { mode: "consultation", consultation },
        };
      }
      output.addTranscript([...global.results, ...project.results]);
      return {
        content: [{ type: "text" as const, text: globalText }, { type: "text" as const, text: `${projectText}\n\n${OKF_OUTPUT_NOTICE}\nSources: ${JSON.stringify(output.sourceIds())}` }],
        details: {
          mode: "transcript",
          returnedResults: global.results.length + project.results.length,
          global: { returnedResults: global.results.length, results: global.results, jev: global.stats, jevFilteredOut: global.filteredOut },
          project: { totalSessions: project.sessions.length, returnedResults: project.results.length, sessions: project.sessions, results: project.results, duplicatesRemoved: project.duplicatesRemoved, jev: project.stats, jevFilteredOut: project.filteredOut },
        },
      };
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const { isError } = context;
      if ((result.details as { mode?: string } | undefined)?.mode === "consultation" || (isError && getEnabledConsultation())) {
        return consultationPresentation.render("recall_memory", result, { expanded, isPartial }, theme, {}, isError);
      }
      const text = result.content.filter((block) => block.type === "text").map((block) =>
        expanded || isPartial || isError || block.text.startsWith(CONFIG_SUMMARY_PREFIX) ? block.text : block.text.split("\n")[0].replace(/^# /, ""),
      ).join("\n\n");
      // Style each line so terminal default colors cannot obscure the tool result.
      return new Text(text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
    },
  });
  registerTool({
    name: "review_jev_filtered", label: "Review Jev-Filtered Recall Evidence", executionMode: "sequential",
    description: "Use only within an explicit user-requested historical review, after recall_memory, to audit possible Jev false negatives. Re-run global and entity-discovered project-session literal recall and display only turns Jev filtered out, with each turn's maximum Jev noul relevance. Use to audit possible Jev false negatives after recall; supply the same entities, primary_entity and question. Available to the main agent regardless of Discussion configuration. Do not invoke automatically as a consultation fallback. Uses the same +10 complete primary phrase bonus before the result limit.",
    promptSnippet: "During an explicit historical review only: inspect possible Jev false negatives after recall. Reuse the original entities, primary_entity and complete question; no runtime or project parameter is available. Discussion does not disable this tool for the main agent. Do not automatically replace consultation with this audit.",
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 8 }),
      primary_entity: Type.String({ minLength: 1, description: "Reuse primary_entity from recall_memory: a verbatim core phrase from question also included in entities; complete phrase hits add +10 once per turn." }),
      question: Type.String({ minLength: 1, description: "The complete original user question used for Jev relevance judgment." }),
    }),
    async execute(_id, options, _signal, update) {
      validateRecallQuery(options);
      const globalLiteral = recallTurns({ entities: options.entities, primary_entity: options.primary_entity });
      const projectLiteral = recallProjectMemory(options).results;
      const literal = [...new Map([...globalLiteral, ...projectLiteral].map((turn) => [turn.turn_id, turn])).values()];
      const reviewed = await _reviewWithJev(jevRuntime, options.question, literal, (message) => update?.({ content: [{ type: "text", text: message }], details: { message } }));
      const text = `${_jevSummary(reviewed.stats)}\n\n${_formatJevFilteredOut(reviewed.filteredOut)}`;
      output.addTranscript(reviewed.filteredOut.map(({ turn }) => turn));
      return { content: [{ type: "text" as const, text: `${text}\n\n${OKF_OUTPUT_NOTICE}\nSources: ${JSON.stringify(output.sourceIds())}` }], details: { returnedResults: reviewed.filteredOut.length, results: reviewed.filteredOut, jev: reviewed.stats } };
    },
  });
  registerTool({
    name: "fetch_session",  label: "Fetch Session", executionMode: "sequential",
    description: "Use only within an explicit user-requested historical review when a recalled excerpt lacks context. Fetch ordered persisted transcript context around an exact turn_id returned by recall_memory or review_jev_filtered. Use when an excerpt lacks necessary context. Available to the main agent regardless of Discussion configuration; do not invoke automatically as a consultation fallback. Copy the exact Fetch turn ID and request the smallest useful before/after window. Zero for both reads only the target turn. This is read-only and never creates a memory.",
    promptSnippet: "During an explicit historical review only: expand an insufficient recall excerpt with its exact Fetch turn ID and the smallest useful before/after window. Never infer turn indexes from ID suffixes. This reads source evidence only. Discussion does not disable this tool for the main agent. Do not automatically replace consultation with transcript fetching.",
    promptGuidelines: [OKF_OUTPUT_NOTICE],
    parameters: Type.Object({ turn_id: Type.String({ minLength: 1, description: "Exact Fetch turn ID returned by recall_memory or review_jev_filtered. Copy the full value; do not parse its suffix." }), before: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Number of turn-index positions before the target. Use 0 for no preceding context." }), after: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Number of turn-index positions after the target. Use 0 for no following context." }) }),
    async execute(_id, { turn_id, before, after }) {
      const { stored, target, fromTurnIndex, toTurnIndex } = fetchTurnContext(turn_id, before, after);
      output.addTranscript(stored.turns.map(turn => ({ ...turn, source: stored.session.source, cwd: stored.session.cwd, score: 0 })));
      const header = `## Source transcript session ${stored.session.session_id}\n**Source:** ${stored.session.source} · **Project:** \`${stored.session.cwd}\`\n**Target turn ID:** \`${turn_id}\` · **Target turn index:** ${target.turn_index}\n**Requested turn-index range:** ${fromTurnIndex}–${toTurnIndex} (inclusive)\n**Turns fetched:** ${stored.turns.length}\n**Storage action:** none. This is read-only source evidence.`;
      const turns = stored.turns.length ? stored.turns.map((turn) => [`### Turn ${turn.turn_index} · ${new Date(turn.ts).toLocaleString()}`, `**Source turn ID:** \`${turn.turn_id}\``, `**You:** ${turn.user_text}`, turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""].filter(Boolean).join("\n")).join("\n\n") : "No persisted turns in the requested range.";
      return { content: [{ type: "text" as const, text: `${header}\n\n${turns}\n\n${OKF_OUTPUT_NOTICE}\nSources: ${JSON.stringify(output.sourceIds())}` }], details: { turn_id, before, after, session_id: stored.session.session_id, target_turn_index: target.turn_index, from_turn_index: fromTurnIndex, to_turn_index: toTurnIndex, turnCount: stored.turns.length, fetchedTurnIds: stored.turns.map((turn) => turn.turn_id) } };
    },
  });
  registerTool({
    name: "finish_memory_recall", label: "Save Recall OKF Conclusion", executionMode: "sequential",
    description: "Save a conclusion only after retrieving transcripts for an explicit user look-back request in this run. Do not call for ordinary questions or when reusing saved OKF knowledge. Use after comparing the retrieved evidence and before the final answer. Provide the complete question, a short content description that does not copy that question, and all conclusion sections; use None for absent sections. Cite transcript-N IDs returned with the evidence. Saves draft OKF v0.2 minutes and portable evidence to the default knowledge root, or the configured Obsidian vault when enabled. The final assistant message uses the exact saved document. For active Discussion, use finish_session_consultation instead.",
    promptGuidelines: [OKF_OUTPUT_NOTICE],
    parameters: Type.Object({ question: Type.String({ minLength: 1 }), conclusion: meetingConclusionSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = output.save(params.question, params.conclusion, ctx.sessionManager.getSessionId());
      return { content: [{ type: "text", text: result.markdown }], details: result };
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
  registerMemoryCleanupTools(registerTool);
}
const SESSION_MEMORY_ACTIONS = {
  setup: "Setup — explain optional features and save approved configuration",
  clean: "Clean indexed tool turns — back up SQLite and remove complete package-tool turns",
  backfill: "Import historical sessions — rescan Pi, Claude Code, and Codex history",
  migrate: "Migrate project sessions — make Claude Code and Codex sessions available in /resume",
} as const;

/** Open the operations that users can start directly from the command menu. */
async function _openSessionMemoryMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const selection = await ctx.ui.select("pi-session-memory", Object.values(SESSION_MEMORY_ACTIONS));
  if (!selection) return;
  if (selection === SESSION_MEMORY_ACTIONS.setup) {
    pi.sendUserMessage(SETUP_REQUEST);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.backfill) {
    _notifyBackfill(ctx, backfillAll(), "imported");
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.migrate) {
    _notifyProjectMigration(ctx, _migrateProjectSources(ctx.sessionManager.getCwd()));
    return;
  }
  notifyMemoryToolCleanup(ctx);
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
    ? filteredOut.map(({ turn, noul }) => `## Filtered turn · noul relevance ${noul.toFixed(3)}\n**Fetch turn ID:** \`${turn.turn_id}\` (pass this exact value to \`fetch_session.turn_id\`)\n**Session ID:** \`${turn.session_id}\`\n**You:** ${turn.user_text}\n${turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""}`).join("\n\n")
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
