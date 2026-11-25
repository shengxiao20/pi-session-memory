import { Type } from "typebox";
import { TOOL_PROMPTS } from "../../prompts/tools.ts";
import { TOOL_NAMES } from "../../prompts/tool-names.ts";
import { PARAMETER_HELP } from "../../prompts/parameters.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { ConsultationPresentation } from "../presentation/consultation-presentation.ts";
import { ConsultationRuntime } from "./consultation-runtime.ts";
import { meetingConclusionSchema } from "../knowledge/meeting-conclusion-schema.ts";
import { MemoryOutput, OKF_OUTPUT_NOTICE } from "../presentation/memory-output.ts";
import { MAIN_AGENT_NOTICE, CONSULTATION_CLOSED_NOTICE } from "../presentation/consultation-guidance.ts";

/** Register agent tools for private follow-ups, draft minutes, and cancellation. */
export function registerConsultationTools(registerTool: ExtensionAPI["registerTool"], runtime: ConsultationRuntime, presentation: ConsultationPresentation, output: MemoryOutput): void {
  const text = (details: unknown, guidance: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }, { type: "text" as const, text: guidance }], details });
  const register = <TParams extends TSchema>(tool: ToolDefinition<TParams>) => registerTool({
    ...tool,
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", tool.label), 0, 0); },
    renderResult(result, options, theme, context) {
      return presentation.render(tool.name, result, options, theme, context.args, context.isError);
    },
  });
  register({
    name: TOOL_NAMES.followUpSession, label: "Follow Up Historical Session", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.followUpSession].description,
    parameters: Type.Object({ consultation_id: Type.String({ minLength: 1 }), session_id: Type.String({ minLength: 1 }), question: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) { return text(await runtime.followUp(params.consultation_id, params.session_id, params.question, ctx, signal), MAIN_AGENT_NOTICE); },
  });
  const conclusion = meetingConclusionSchema;
  register({
    name: TOOL_NAMES.finishSessionConsultation, label: "Save OKF Meeting Minutes", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.finishSessionConsultation].description,
    promptGuidelines: TOOL_PROMPTS[TOOL_NAMES.finishSessionConsultation].promptGuidelines,
    parameters: Type.Object({
      consultation_id: Type.String({ minLength: 1 }), conclusion,
      meeting_id: Type.Optional(Type.String({ minLength: 1, description: PARAMETER_HELP.knowledge.updateMeetingId })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      output.invalidateSave();
      const result = await runtime.finish(params.consultation_id, params.conclusion, ctx, params.meeting_id);
      output.complete(result.markdown);
      return text(result, `${CONSULTATION_CLOSED_NOTICE} ${OKF_OUTPUT_NOTICE}`);
    },
  });
  register({
    name: TOOL_NAMES.cancelSessionConsultation, label: "Cancel Session Consultation", executionMode: "sequential",
    description: TOOL_PROMPTS[TOOL_NAMES.cancelSessionConsultation].description,
    parameters: Type.Object({ consultation_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) { await runtime.cancel(params.consultation_id, ctx); output.cancelDiscussion(); return text({ cancelled: params.consultation_id }, CONSULTATION_CLOSED_NOTICE); },
  });
}
