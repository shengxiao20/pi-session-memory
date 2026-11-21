import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DISCUSSION_TURN_THRESHOLD_ENV, getDiscussionTurnThreshold, validateMemoryConfig } from "../settings/config.ts";
import { resolveKnowledgePath } from "../knowledge/knowledge-storage.ts";
import { configureMemory, readMemorySetup } from "./setup.ts";
import { CONFIG_FIELDS, completeConfigDraft, createConfigDraft, formatConfigField, getConfigFieldValue, parseConfigFieldValue, setConfigFieldValue } from "./config-fields.ts";

/** Enter submits and saves one validated field. Esc leaves that field unchanged or exits the menu. */
export async function editMemoryConfiguration(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) throw new Error("Configuration editing requires Pi TUI mode; use setup_memory and configure_memory for Agent-assisted setup");
  let current = readMemorySetup();
  for (;;) {
    const snapshot = JSON.stringify(current.configuration);
    const draft = createConfigDraft(current.configuration);
    const rows = CONFIG_FIELDS.map(field => formatConfigField(field, draft));
    const selection = await ctx.ui.select(`Configuration\n${current.config_path}\nSelect a field. Esc exits.`, rows);
    if (selection === undefined) return;
    const index = rows.indexOf(selection);
    if (index < 0) throw new Error("Unknown configuration editor selection");
    const field = CONFIG_FIELDS[index];
    const value = getConfigFieldValue(draft, field.key);
    const title = `${field.key}\n  Current: ${value === undefined ? "not set" : JSON.stringify(value)}\n  (${field.requirement}) (default: ${field.defaultLabel})\n${field.description}\nEnter saves. Esc keeps the current value.`;
    const answer = field.kind === "boolean"
      ? await ctx.ui.select(title, ["true", "false"])
      : field.kind === "enum"
        ? await ctx.ui.select(title, [...field.choices!])
        : await ctx.ui.input(title, value === undefined ? field.defaultLabel : String(value));
    if (answer === undefined) continue;
    setConfigFieldValue(draft, field, parseConfigFieldValue(field, answer));
    const proposal = completeConfigDraft(draft);
    const config = validateMemoryConfig(proposal);
    resolveKnowledgePath(config);
    if (process.env[DISCUSSION_TURN_THRESHOLD_ENV] !== undefined) getDiscussionTurnThreshold();
    const saved = await withFileMutationQueue(current.config_path, async () => {
      if (JSON.stringify(readMemorySetup().configuration) !== snapshot) throw new Error("Configuration changed while the editor was open. Reopen it before saving; no settings were overwritten.");
      return configureMemory(proposal);
    });
    current = { ...current, configuration: saved.configuration };
    ctx.ui.notify(`Saved ${field.key}.`, "info");
  }
}
