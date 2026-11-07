import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cleanMemoryToolTurns, formatMemoryToolCleanup } from "./memory-index-cleanup.ts";

/** Expose explicit manual cleanup without starting transcript recall or an OKF conclusion workflow. */
export function registerMemoryCleanupTools(registerTool: ExtensionAPI["registerTool"]): void {
  registerTool({
    name: "clean_memory_tool_turns", label: "Clean Indexed Memory Tool Turns", executionMode: "sequential",
    description: "Use only when the user explicitly requests removal of polluted pi-session-memory tool turns from SQLite. Create and verify a SQLite backup before deleting entire turns whose recorded tool names match this package, including the user text and final reply. Reinstall write-exclusion triggers. Return actual deletion counts and the backup path. Do not modify source JSONL, saved OKF files, session metadata or source tracking. This does not clear existing model context or compaction summaries. Backup or cleanup errors are raised; no retry or fallback is used.",
    parameters: Type.Object({}),
    async execute() {
      const result = cleanMemoryToolTurns();
      return { content: [{ type: "text", text: formatMemoryToolCleanup(result) }], details: result };
    },
  });
}

/** Use the shared cleanup and result formatter for the menu entry. */
export function notifyMemoryToolCleanup(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(formatMemoryToolCleanup(cleanMemoryToolTurns()), "info");
}
