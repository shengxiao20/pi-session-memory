import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setupConfigurationSchema } from "./setup-schema.ts";
import { readMemorySetup, configureMemory, SETUP_NOTICE } from "./setup.ts";

/** Setup tools must work before a valid configuration exists; do not wrap them with runtime config readers. */
export function registerSetupTools(registerTool: ExtensionAPI["registerTool"]): void {
  registerTool({
    name: "setup_memory", label: "Read Memory Setup Guide", executionMode: "sequential",
    description: "Use when the user asks how pi-session-memory works, how to use the plugin, or requests setup. Read the packaged setup.md and current raw configuration without writing. Explain every optional feature and ask one question per reply in the guide's order, waiting for each answer. General usage questions are not permission to write. Configuration saving requires final user approval. Missing configuration is reported as null; malformed JSON and storage errors are raised. Do not start historical review, services, import, migration or cleanup.",
    promptSnippet: "Read setup.md for plugin usage questions or sequential configuration setup.",
    promptGuidelines: [SETUP_NOTICE],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const result = readMemorySetup();
      return { content: [{ type: "text", text: `${result.guide}\n\nCurrent configuration:\n${JSON.stringify({ config_path: result.config_path, configuration: result.configuration }, null, 2)}` }], details: result };
    },
  });
  registerTool({
    name: "configure_memory", label: "Save Memory Configuration", executionMode: "sequential",
    description: "Use only after the user approves saving the final pi-session-memory setup settings. Save to the plugin's global config.json, creating a missing file only for an approved setup. Supply the complete proposed configuration, including unchanged nested settings. Preserve unrelated top-level existing keys automatically; do not supply unsupported keys. Validate the runtime schema and any enabled Obsidian vault before atomic file replacement. Return the saved path and settings. Do not store credentials or environment-only options. Do not run history operations or service checks. Errors are raised; no retry or fallback is used.",
    promptGuidelines: [SETUP_NOTICE],
    parameters: Type.Object({ configuration: setupConfigurationSchema }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = configureMemory(params.configuration);
      return { content: [{ type: "text", text: `Saved pi-session-memory configuration: ${result.config_path}\n${JSON.stringify(result.configuration, null, 2)}\nTools reread settings on invocation. Restart Pi for startup synchronization and service readiness checks. No history operations or service checks ran during this save.` }], details: result };
    },
  });
}
