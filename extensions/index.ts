import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeTurn } from "../src/writer.ts";
import { recallTurns, formatRecallResults } from "../src/retriever.ts";
import { backfillAll, syncChangedHistory } from "../src/backfill.ts";

export default function (pi: ExtensionAPI) {

  pi.on("session_start", async (_event, ctx) => {
    const stats = syncChangedHistory();
    if (stats.scannedFiles > 0) {
      ctx.ui.notify(
        `[session-memory] synced ${stats.turns} turns from ${stats.scannedFiles} changed session files`,
        "info",
      );
    }
  });

  // ── Write: persist each completed agent run to SQLite ────────────────────
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      writeTurn(ctx);
    } catch (err) {
      ctx.ui.notify(`[session-memory] write failed: ${String(err)}`, "error");
    }
  });

  pi.registerCommand("memory-backfill", {
    description: "Import historical Pi, Claude Code, and Codex sessions into memory.db",
    handler: async (_args, ctx) => {
      const stats = backfillAll();
      ctx.ui.notify(
        `[session-memory] imported ${stats.turns} turns from ${stats.scannedFiles} files: ${stats.pi} Pi, ${stats.claude} Claude, ${stats.codex} Codex sessions`,
        "info",
      );
    },
  });

  // ── Read: recall_memory tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "recall_memory",
    label: "Recall Memory",
    description: `Search this user's past conversation history across Pi, Claude Code, and Codex.

Invocation policy:
1. Call this tool immediately when the user explicitly asks to review, remember, summarize, continue, or compare a previous discussion about a topic. Examples:
   - "我之前关于 xxx 的实践" / "I previously worked on xxx"
   - "上次我们讨论过..." / "last time we discussed..."
   - "你还记得那个 xxx 项目吗" / "remember that xxx project?"
   - "之前那个方案怎么说的" / "what was that plan we had?"
2. When you cannot confidently answer from the current conversation and your general knowledge, but the user may have discussed the topic in prior sessions, first ask whether they want you to search their conversation history. Call this tool only after they agree.
3. Do not search history merely because a question is difficult when the user's prior discussions are not relevant.

Extract 2–5 specific entities from the user's topic: project names, tool names, technologies, domain terms, or identifiers.`, 

    parameters: Type.Object({
      entities: Type.Array(
        Type.String({ minLength: 1 }),
        {
          description: 'Key technical terms from the query. E.g. ["payroll", "LangGraph", "A2A"]',
          minItems: 1,
          maxItems: 8,
        },
      ),
    }),

    async execute(_toolCallId, { entities }) {
      const results = recallTurns(entities, 5);
      const text = formatRecallResults(results);
      return {
        content: [{ type: "text" as const, text }],
        details: { entities, resultCount: results.length },
      };
    },
  });
}
