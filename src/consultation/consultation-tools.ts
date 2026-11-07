import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { ConsultationPresentation } from "../presentation/consultation-presentation.ts";
import { ConsultationRuntime } from "./consultation-runtime.ts";
import { meetingConclusionSchema } from "../knowledge/meeting-conclusion-schema.ts";
import { MemoryOutput, OKF_OUTPUT_NOTICE } from "../presentation/memory-output.ts";
import { MAIN_AGENT_NOTICE, CONSULTATION_CLOSED_NOTICE } from "../presentation/consultation-guidance.ts";

/** Register manual and agent access to private follow-ups and draft minutes. */
export function registerConsultationTools(registerTool: ExtensionAPI["registerTool"], runtime: ConsultationRuntime, presentation: ConsultationPresentation, output: MemoryOutput) {
  const text = (details: unknown, guidance: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }, { type: "text" as const, text: guidance }], details });
  const register = <TParams extends TSchema>(tool: ToolDefinition<TParams>) => registerTool({
    ...tool,
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", tool.label), 0, 0); },
    renderResult(result, options, theme, context) {
      return presentation.render(tool.name, result, options, theme, context.args, context.isError);
    },
  });
  register({
    name: "follow_up_session", label: "Follow Up Historical Session", executionMode: "sequential",
    description: "Privately question one historical Pi participant after enabled recall_memory consultation. Use when the main agent finds contradictions, missing evidence or unclear decisions. Copy consultation_id and participant session_id. No answers are broadcast to other participants. Use within the current main-agent run; remaining participants are released when the main agent settles. Historical questions and answers remain in memory and never append to original session JSONL files. Historical answers do not change the main agent's tool permissions.",
    parameters: Type.Object({ consultation_id: Type.String({ minLength: 1 }), session_id: Type.String({ minLength: 1 }), question: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) { return text(await runtime.followUp(params.consultation_id, params.session_id, params.question, ctx, signal), MAIN_AGENT_NOTICE); },
  });
  const conclusion = meetingConclusionSchema;
  register({
    name: "finish_session_consultation", label: "Save OKF Meeting Minutes", executionMode: "sequential",
    description: "Finish an active historical-session consultation after the main agent compares the private answers. Save draft OKF v0.2 minutes and portable evidence, then release participants. Use the shared default knowledge root, or the configured Obsidian vault when enabled. Provide a short content description that does not copy the user's question. Provide explicit findings, decisions, uncertainty, disagreements, open questions and actions; write None for absent sections. Cite consultation-N source IDs for supported claims. Never mark consensus as verified. The final assistant message is the exact saved OKF document. Use before the main agent settles.",
    promptGuidelines: [OKF_OUTPUT_NOTICE],
    parameters: Type.Object({ consultation_id: Type.String({ minLength: 1 }), conclusion }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await runtime.finish(params.consultation_id, params.conclusion, ctx);
      output.complete(result.markdown);
      return text(result, `${CONSULTATION_CLOSED_NOTICE} ${OKF_OUTPUT_NOTICE}`);
    },
  });
  register({
    name: "cancel_session_consultation", label: "Cancel Session Consultation", executionMode: "sequential",
    description: "Cancel an active historical-session consultation and dispose its in-memory participants without producing completed minutes. Use when the user cancels or the consultation is no longer needed. Consultation never appends to original session JSONL files. Main-agent tool permissions remain unchanged.",
    parameters: Type.Object({ consultation_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) { await runtime.cancel(params.consultation_id, ctx); output.cancelDiscussion(); return text({ cancelled: params.consultation_id }, CONSULTATION_CLOSED_NOTICE); },
  });
  const commandParameters = Type.Union([
    Type.Object({ action: Type.Literal("follow-up"), consultation_id: Type.String({ minLength: 1 }), session_id: Type.String({ minLength: 1 }), question: Type.String({ minLength: 1 }) }),
    Type.Object({ action: Type.Literal("finish"), consultation_id: Type.String({ minLength: 1 }), conclusion }),
    Type.Object({ action: Type.Literal("cancel"), consultation_id: Type.String({ minLength: 1 }) }),
  ]);
  return async (args: string, ctx: ExtensionCommandContext) => {
      const params = JSON.parse(args);
      if (!Value.Check(commandParameters, params)) throw new Error("Invalid consultation command arguments: require action follow-up, finish or cancel, consultation_id and the action's required fields");
      if (params.action === "follow-up") {
        const result = text(await runtime.followUp(params.consultation_id, params.session_id, params.question, ctx), MAIN_AGENT_NOTICE);
        await ctx.ui.custom<void>((_tui, theme, keys, done) => {
          const view = presentation.render("follow_up_session", result, { expanded: false, isPartial: false }, theme, params, false);
          view.addChild(new Text("Enter / Esc: close", 0, 0));
          return Object.assign(view, {
            handleInput(data: string) {
              if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")) done();
            },
          });
        });
      } else if (params.action === "finish") {
        const result = await runtime.finish(params.consultation_id, params.conclusion, ctx);
        output.complete(result.markdown);
        ctx.ui.notify(`Draft OKF minutes saved: ${result.path}`, "info");
      }
      else if (params.action === "cancel") { await runtime.cancel(params.consultation_id, ctx); output.cancelDiscussion(); ctx.ui.notify("Consultation cancelled", "info"); }
      else throw new Error("action must be follow-up, finish or cancel");
  };
}
