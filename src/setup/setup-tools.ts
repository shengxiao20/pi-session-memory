import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_PROMPTS } from "../../prompts/tools.ts";
import { TOOL_NAMES } from "../../prompts/tool-names.ts";
import { setupReadResponse, setupSavedResponse } from "../../prompts/responses.ts";
import { setupConfigurationSchema } from "./setup-schema.ts";
import { getMemoryConfigPath } from "../settings/config.ts";
import { readMemorySetup, configureMemory } from "./setup.ts";

/** Setup tools must work before a valid configuration exists; do not wrap them with runtime config readers. */
export function registerSetupTools(registerTool: ExtensionAPI["registerTool"]): void {
  registerTool({
    name: TOOL_NAMES.setupMemory, label: "Read Memory Setup Guide", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.setupMemory].description,
    promptSnippet: TOOL_PROMPTS[TOOL_NAMES.setupMemory].promptSnippet,
    promptGuidelines: TOOL_PROMPTS[TOOL_NAMES.setupMemory].promptGuidelines,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const result = readMemorySetup();
      return { content: [{ type: "text", text: setupReadResponse(result.guide, JSON.stringify({ config_path: result.config_path, configuration: result.configuration, fields: result.fields, environment_inputs: result.environment_inputs }, null, 2)) }], details: result };
    },
  });
  registerTool({
    name: TOOL_NAMES.configureMemory, label: "Save Memory Configuration", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.configureMemory].description,
    promptGuidelines: TOOL_PROMPTS[TOOL_NAMES.configureMemory].promptGuidelines,
    parameters: Type.Object({ configuration: setupConfigurationSchema }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = await withFileMutationQueue(getMemoryConfigPath(), async () => configureMemory(params.configuration));
      return { content: [{ type: "text", text: setupSavedResponse(result.config_path, JSON.stringify(result.configuration, null, 2)) }], details: result };
    },
  });
}
