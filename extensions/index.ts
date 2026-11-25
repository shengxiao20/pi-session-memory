import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeTurn } from "../src/history/writer.ts";
import { getHistoryStats, getSessionTurnDistribution } from "../src/history/db.ts";
import { getWorkspaceUsage } from "../src/history/workspace-usage.ts";
import { showWorkspaceUsage, WORKSPACE_USAGE_LABEL } from "../src/presentation/workspace-usage.ts";
import { fetchTurnContext } from "../src/history/fetch-turn-context.ts";
import { formatRecallResults, recallTurns } from "../src/recall/retriever.ts";
import { selectRecallMode } from "../src/recall/recall-mode.ts";
import { MemoryOutput, OKF_OUTPUT_NOTICE } from "../src/presentation/memory-output.ts";
import { deleteSessionsByTurnCount, SESSION_DELETION_LABEL, showDatabaseSessionManagement } from "../src/presentation/database-session-management.ts";
import { MemoryContext, withMemoryContext } from "../src/presentation/memory-context.ts";
import { registerMemoryKnowledgeTools } from "../src/knowledge/memory-knowledge-tools.ts";
import { registerSetupTools } from "../src/setup/setup-tools.ts";
import { editMemoryConfiguration } from "../src/setup/config-editor.ts";
import { SETUP_REQUEST } from "../src/setup/setup.ts";
import { recallSequentially } from "../src/recall/recall-workflow.ts";
import { backfillAll, type BackfillStats } from "../src/history/backfill.ts";
import { notifyMemoryToolCleanup, registerMemoryCleanupTools } from "../src/history/memory-index-cleanup-tools.ts";
import { deleteSessionsAtOrBelowTurnCount } from "../src/history/memory-index-cleanup.ts";
import { formatProjectRecallResults, recallProjectMemory } from "../src/recall/project-retriever.ts";
import { validateRecallQuery } from "../src/recall/recall-query.ts";
import { getSessionMemoryConfig, getDiscussionConfiguration } from "../src/settings/config.ts";
import { ConsultationRuntime } from "../src/consultation/consultation-runtime.ts";
import { registerConsultationTools } from "../src/consultation/consultation-tools.ts";
import { ConsultationPresentation } from "../src/presentation/consultation-presentation.ts";
import { consultationGuidance } from "../src/presentation/consultation-guidance.ts";
import { CONFIG_SUMMARY_PREFIX, withConfigSummary } from "../src/presentation/tool-config-summary.ts";
import { JevRuntime } from "../src/relevance/jev-runtime.ts";
import { filterRecallWithJev, type JevFilterStats, type JevFilteredOutTurn } from "../src/relevance/jev-filter.ts";
import type { RecallTurnResult } from "../src/contracts/recall.ts";
import { COMMAND_DESCRIPTION, TOOL_PROMPTS } from "../prompts/tools.ts";
import { TOOL_NAMES } from "../prompts/tool-names.ts";
import { PARAMETER_HELP } from "../prompts/parameters.ts";

/** Register local Pi cross-session transcript retrieval features. */
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
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("/pi-session-memory accepts no arguments");
      await _openSessionMemoryMenu(pi, ctx);
    },
  });

  registerTool({
    name: TOOL_NAMES.recallMemory, label: "Recall History · Global → Project", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.recallMemory].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.recallMemory].promptSnippet,
    promptGuidelines: TOOL_PROMPTS[TOOL_NAMES.recallMemory].promptGuidelines,
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1, description: PARAMETER_HELP.recall.entities })),
      primary_entity: Type.String({ minLength: 1, description: PARAMETER_HELP.recall.primaryEntity }),
      question: Type.String({ minLength: 1, description: PARAMETER_HELP.recall.question }),
    }),
    async execute(_id, options, signal, update, ctx) {
      const configuredMode = getSessionMemoryConfig().recallMode;
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
      let mode = await selectRecallMode(configuredMode, { global: global.results.length, project: project.results.length }, ctx, signal);
      let fallbackReason: string | undefined;
      if (mode === undefined) return {
        content: [{ type: "text", text: "Recall mode selection cancelled. No transcripts were added and no historical agents were opened." }],
        details: { mode: "cancelled", configuredMode, returnedResults: 0 },
      };
      if (mode === "discussion") {
        const consultation = await consultationRuntime.start([...global.results, ...project.results], options.question, ctx, signal);
        if (consultation.status === "no_eligible_sessions") {
          mode = "normal";
          fallbackReason = consultation.reason;
        } else {
          consultationPresentation.remember(consultation);
          if (consultation.consultation_id !== null) output.startDiscussion();
          return {
            content: [{ type: "text" as const, text: `## Private historical-session consultation\n${JSON.stringify(consultation, null, 2)}\n${consultationGuidance(consultation.consultation_id)}` }],
            details: { mode: "consultation", configuredMode, recallMode: mode, consultation },
          };
        }
      }
      output.addTranscript([...global.results, ...project.results]);
      return {
        content: [{ type: "text" as const, text: globalText }, { type: "text" as const, text: `${projectText}\n\n${OKF_OUTPUT_NOTICE}\nSources: ${JSON.stringify(output.sourceIds())}` }],
        details: {
          mode: "transcript", configuredMode, recallMode: mode, fallbackReason,
          returnedResults: global.results.length + project.results.length,
          global: { returnedResults: global.results.length, results: global.results, jev: global.stats, jevFilteredOut: global.filteredOut },
          project: { totalSessions: project.sessions.length, returnedResults: project.results.length, sessions: project.sessions, results: project.results, duplicatesRemoved: project.duplicatesRemoved, jev: project.stats, jevFilteredOut: project.filteredOut },
        },
      };
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const { isError } = context;
      if ((result.details as { mode?: string } | undefined)?.mode === "consultation" || (isError && getDiscussionConfiguration())) {
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
    name: TOOL_NAMES.reviewJevFiltered, label: "Review Jev-Filtered Recall Evidence", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.reviewJevFiltered].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.reviewJevFiltered].promptSnippet,
    parameters: Type.Object({
      entities: Type.Array(Type.String({ minLength: 1 })),
      primary_entity: Type.String({ minLength: 1, description: PARAMETER_HELP.recall.reviewPrimaryEntity }),
      question: Type.String({ minLength: 1, description: PARAMETER_HELP.recall.reviewQuestion }),
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
    name: TOOL_NAMES.fetchSession,  label: "Fetch Session", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.fetchSession].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.fetchSession].promptSnippet,
    promptGuidelines: TOOL_PROMPTS[TOOL_NAMES.fetchSession].promptGuidelines,
    parameters: Type.Object({ turn_id: Type.String({ minLength: 1, description: PARAMETER_HELP.recall.fetchTurnId }), before: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: PARAMETER_HELP.recall.fetchBefore }), after: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: PARAMETER_HELP.recall.fetchAfter }) }),
    async execute(_id, { turn_id, before, after }) {
      const { stored, target, fromTurnIndex, toTurnIndex } = fetchTurnContext(turn_id, before, after);
      output.addTranscript(stored.turns.map(turn => ({ ...turn, source: stored.session.source, cwd: stored.session.cwd, score: 0 })));
      const header = `## Source transcript session ${stored.session.session_id}\n**Source:** ${stored.session.source} · **Project:** \`${stored.session.cwd}\`\n**Target turn ID:** \`${turn_id}\` · **Target turn index:** ${target.turn_index}\n**Requested turn-index range:** ${fromTurnIndex}–${toTurnIndex} (inclusive)\n**Turns fetched:** ${stored.turns.length}\n**Storage action:** none. This is read-only source evidence.`;
      const turns = stored.turns.length ? stored.turns.map((turn) => [`### Turn ${turn.turn_index} · ${new Date(turn.ts).toLocaleString()}`, `**Source turn ID:** \`${turn.turn_id}\``, `**You:** ${turn.user_text}`, turn.reply_text ? `**Assistant:** ${turn.reply_text}` : ""].filter(Boolean).join("\n")).join("\n\n") : "No persisted turns in the requested range.";
      return { content: [{ type: "text" as const, text: `${header}\n\n${turns}\n\n${OKF_OUTPUT_NOTICE}\nSources: ${JSON.stringify(output.sourceIds())}` }], details: { turn_id, before, after, session_id: stored.session.session_id, target_turn_index: target.turn_index, from_turn_index: fromTurnIndex, to_turn_index: toTurnIndex, turnCount: stored.turns.length, fetchedTurnIds: stored.turns.map((turn) => turn.turn_id) } };
    },
  });
  registerTool({
    name: TOOL_NAMES.getMemoryStats, label: "Get History Storage Statistics",
    description: TOOL_PROMPTS[TOOL_NAMES.getMemoryStats].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.getMemoryStats].promptSnippet, parameters: Type.Object({}),
    async execute() { const stats = getHistoryStats(); return { content: [{ type: "text" as const, text: _historyStatsSummary(stats) }], details: stats }; },
  });
  registerTool({
    name: TOOL_NAMES.backfillMemory, label: "Import Historical Sessions",
    description: TOOL_PROMPTS[TOOL_NAMES.backfillMemory].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.backfillMemory].promptSnippet, parameters: Type.Object({}),
    async execute() { const stats = backfillAll(); return { content: [{ type: "text" as const, text: _backfillSummary(stats, "imported") }], details: stats }; },
  });
  registerMemoryCleanupTools(registerTool);
}
const SESSION_MEMORY_ACTIONS = {
  setup: "Agentic setup",
  edit: "Edit configuration",
  database: "Database session management",
  workspaceUsage: WORKSPACE_USAGE_LABEL,
  deleteSessions: SESSION_DELETION_LABEL,
  clean: "Clean indexed tool turns",
  backfill: "Import history",
} as const;

/** Open the operations that users can start directly from the command menu. */
async function _openSessionMemoryMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const selection = await ctx.ui.select("pi-session-memory", Object.values(SESSION_MEMORY_ACTIONS));
  if (!selection) return;
  if (selection === SESSION_MEMORY_ACTIONS.edit) {
    await editMemoryConfiguration(ctx);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.setup) {
    pi.sendUserMessage(SETUP_REQUEST);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.database) {
    await showDatabaseSessionManagement(ctx, getSessionTurnDistribution);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.workspaceUsage) {
    await showWorkspaceUsage(ctx, getWorkspaceUsage);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.deleteSessions) {
    await deleteSessionsByTurnCount(ctx, deleteSessionsAtOrBelowTurnCount);
    return;
  }
  if (selection === SESSION_MEMORY_ACTIONS.backfill) {
    _notifyBackfill(ctx, backfillAll(), "imported");
    return;
  }
  if (selection !== SESSION_MEMORY_ACTIONS.clean) throw new Error("Unknown pi-session-memory menu selection");
  notifyMemoryToolCleanup(ctx);
}

function _historyStatsSummary(stats: ReturnType<typeof getHistoryStats>): string { const sources = stats.sources.length ? stats.sources.map((source) => `${source.source}: ${source.turns} turns / ${source.sessions} sessions`).join(", ") : "no imported sources"; const newest = stats.newestTs ? new Date(stats.newestTs).toLocaleString() : "n/a"; return `[session-memory] ${stats.turns} turns across ${stats.sessions} sessions; ${sources}; newest: ${newest}`; }
function _backfillSummary(stats: BackfillStats, action: string): string { return `[session-memory] ${action} ${stats.turns} turns from ${stats.scannedFiles} files: ${stats.pi} Pi sessions`; }
function _notifyBackfill(ctx: ExtensionContext, stats: BackfillStats, action: string): void { ctx.ui.notify(_backfillSummary(stats, action), "info"); for (const issue of stats.issues) ctx.ui.notify(`[session-memory] ${issue.error}`, "error"); }

async function _reviewWithJev(runtime: JevRuntime, question: string, results: RecallTurnResult[], progress: (message: string) => void): Promise<{ results: RecallTurnResult[]; filteredOut: JevFilteredOutTurn[]; stats: JevFilterStats }> {
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

function _formatJevFilteredOut(filteredOut: JevFilteredOutTurn[]): string {
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
