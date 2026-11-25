import { Type } from "typebox";
import { TOOL_PROMPTS } from "../../prompts/tools.ts";
import { PARAMETER_HELP } from "../../prompts/parameters.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectMemoryKnowledge, readMemoryKnowledge, KNOWLEDGE_FIRST_NOTICE } from "./memory-knowledge.ts";
import { meetingConclusionSchema } from "./meeting-conclusion-schema.ts";
import { withKnowledgeMutation } from "./knowledge-publication.ts";
import { resolveKnowledgePath } from "./knowledge-storage.ts";
import type { MeetingConclusion, writeTranscriptMinutes } from "./meeting-minutes.ts";
interface SavedKnowledgeOutput {
  reuse(markdown: string): void;
  invalidateSave(): void;
  save(question: string, conclusion: MeetingConclusion, meetingId?: string, knowledgeRoot?: string): ReturnType<typeof writeTranscriptMinutes>;
  saveContext(question: string, context: string, conclusion: MeetingConclusion, meetingId?: string, knowledgeRoot?: string): ReturnType<typeof writeTranscriptMinutes>;
}

/** Expose metadata-first reading and OKF writing through the shared publication module. */
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
      return _documentResult(result);
    },
  });
  registerTool({
    name: "finish_memory_recall", label: "Save Recall OKF Conclusion", executionMode: "sequential",
    description: TOOL_PROMPTS.finish_memory_recall.description,
    promptGuidelines: TOOL_PROMPTS.finish_memory_recall.promptGuidelines,
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }), conclusion: meetingConclusionSchema,
      meeting_id: Type.Optional(Type.String({ minLength: 1, description: PARAMETER_HELP.knowledge.updateMeetingId })),
    }),
    async execute(_id, params) {
      return _saveDocument(output, params.meeting_id, root => output.save(params.question, params.conclusion, params.meeting_id, root));
    },
  });
  registerTool({
    name: "write_okf", label: "Save Current Context as OKF", executionMode: "sequential",
    description: TOOL_PROMPTS.write_okf.description,
    promptSnippet: TOOL_PROMPTS.write_okf.promptSnippet,
    promptGuidelines: TOOL_PROMPTS.write_okf.promptGuidelines,
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: PARAMETER_HELP.knowledge.writeQuestion }),
      context: Type.String({ minLength: 1, description: PARAMETER_HELP.knowledge.writeContext }),
      conclusion: meetingConclusionSchema,
      meeting_id: Type.Optional(Type.String({ minLength: 1, description: PARAMETER_HELP.knowledge.updateMeetingId })),
    }),
    async execute(_id, params) {
      return _saveDocument(output, params.meeting_id, root => output.saveContext(params.question, params.context, params.conclusion, params.meeting_id, root));
    },
  });
}

function _saveDocument<T extends { markdown: string }>(output: SavedKnowledgeOutput, meetingId: string | undefined, operation: (root: string) => T) {
  output.invalidateSave();
  const root = resolveKnowledgePath();
  return withKnowledgeMutation(root, meetingId, () => _documentResult(operation(root)));
}

function _documentResult<T extends { markdown: string }>(result: T) {
  return { content: [{ type: "text" as const, text: result.markdown }], details: result };
}
