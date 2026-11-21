import { Type } from "typebox";
import { TOOL_PROMPTS } from "../../prompts/tools.ts";
import { PARAMETER_HELP } from "../../prompts/parameters.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectMemoryKnowledge, readMemoryKnowledge, KNOWLEDGE_FIRST_NOTICE } from "./memory-knowledge.ts";
interface SavedKnowledgeOutput { reuse(markdown: string): void; }

/** Expose the OKF-first route without changing transcript tools or starting a consultation. */
export function registerMemoryKnowledgeTools(registerTool: ExtensionAPI["registerTool"], output: SavedKnowledgeOutput): void {
  registerTool({
    name: "inspect_memory_knowledge", label: "Inspect Saved OKF Directory", executionMode: "sequential",
    description: TOOL_PROMPTS.inspect_memory_knowledge.description,
    promptSnippet: TOOL_PROMPTS.inspect_memory_knowledge.promptSnippet,
    promptGuidelines: TOOL_PROMPTS.inspect_memory_knowledge.promptGuidelines,
    parameters: Type.Object({ directory: Type.Optional(Type.String({ description: PARAMETER_HELP.knowledge.directory })) }),
    async execute(_id, params) {
      const result = inspectMemoryKnowledge(params.directory);
      return { content: [{ type: "text", text: `${JSON.stringify(result, null, 2)}\n\n${KNOWLEDGE_FIRST_NOTICE}` }], details: result };
    },
  });
  registerTool({
    name: "read_memory_knowledge", label: "Read Saved OKF Meeting", executionMode: "sequential",
    description: TOOL_PROMPTS.read_memory_knowledge.description,
    parameters: Type.Object({ meeting_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const result = readMemoryKnowledge(params.meeting_id);
      output.reuse(result.markdown);
      return { content: [{ type: "text", text: result.markdown }], details: result };
    },
  });
}
