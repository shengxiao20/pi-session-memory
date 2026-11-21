import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_PROMPTS } from "../../prompts/tools.ts";
import { cleanMemoryToolTurns, formatMemoryToolCleanup } from "./memory-index-cleanup.ts";

/** Expose explicit manual cleanup without starting transcript recall or an OKF conclusion workflow. */
export function registerMemoryCleanupTools(registerTool: ExtensionAPI["registerTool"]): void {
  registerTool({
    name: "clean_memory_tool_turns", label: "Clean Indexed Memory Tool Turns", executionMode: "sequential",
    description: TOOL_PROMPTS.clean_memory_tool_turns.description,
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
