import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { ConsultationAnswer } from "../contracts/consultation.ts";
import { CONFIG_SUMMARY_PREFIX } from "./tool-config-summary.ts";

interface InitialConsultation {
  consultation_id: string | null;
  answers: ConsultationAnswer[];
  reason?: string;
}

/** Remove terminal controls from display text without changing stored evidence. */
export function cleanDisplayText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Keep participant numbers in the display layer, independent of tool payloads. */
export class ConsultationPresentation {
  private participants = new Map<string, string[]>();

  remember(consultation: InitialConsultation) {
    if (consultation.consultation_id === null) return;
    this.participants.set(consultation.consultation_id, consultation.answers.map(answer => answer.sessionId));
  }

  restore(entries: readonly { type: string; message?: { role: string; details?: unknown } }[]) {
    this.participants.clear();
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
      const details = entry.message.details as { mode?: string; consultation: InitialConsultation } | undefined;
      if (details?.mode === "consultation") this.remember(details.consultation);
    }
  }

  number(consultationId: string, sessionId: string): number {
    const index = this.participants.get(consultationId)?.indexOf(sessionId);
    if (index === undefined || index < 0) throw new Error("Unknown consultation participant in display state");
    return index + 1;
  }

  render(tool: string, result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme,
    args: { consultation_id?: string }, isError: boolean) {
    const view = new Container();
    const text = (value: string) => view.addChild(new Text(theme.fg("toolOutput", cleanDisplayText(value)), 0, 0));
    const answer = (value: ConsultationAnswer, number: number) => {
      view.addChild(new Text(theme.fg("accent", `Agent ${number} answer:`), 0, 0));
      view.addChild(new Markdown(cleanDisplayText(value.answer), 0, 0, getMarkdownTheme(), {
        color: value => theme.fg("toolOutput", value),
      }));
      if (options.expanded) {
        text(`User question: ${value.question}`);
        text(`Session: ${value.sessionId}\nMessage IDs: ${value.messageIds.join(", ")}`);
      }
    };
    if (isError) {
      const message = result.content.filter(block => block.type === "text" && !block.text.startsWith(CONFIG_SUMMARY_PREFIX))
        .map(block => block.type === "text" ? block.text : "").join("\n");
      text(`Consultation failed: ${message.split("\n")[0]}`);
    } else if (options.isPartial) {
      text("Waiting for historical agent answers…");
    } else if (tool === "recall_memory") {
      const { consultation } = result.details as { consultation: InitialConsultation };
      this.remember(consultation);
      if (!consultation.answers.length) text(`Consultation not started: ${consultation.reason}`);
      consultation.answers.forEach((value, index) => answer(value, index + 1));
      if (options.expanded && consultation.consultation_id !== null) text(`Consultation: ${consultation.consultation_id}`);
    } else if (tool === "follow_up_session") {
      const value = result.details as ConsultationAnswer;
      answer(value, this.number(args.consultation_id!, value.sessionId));
      if (options.expanded) text(`Consultation: ${args.consultation_id}`);
    } else if (tool === "finish_session_consultation") {
      const value = result.details as { path: string };
      text(`Draft OKF minutes saved: ${value.path}`);
      if (options.expanded) text(`Consultation: ${args.consultation_id}`);
    } else if (tool === "cancel_session_consultation") {
      text("Consultation cancelled. Historical participants released.");
      if (options.expanded) text(`Consultation: ${args.consultation_id}`);
    } else {
      throw new Error(`Unsupported consultation display tool: ${tool}`);
    }
    for (const block of result.content) {
      if (block.type === "text" && block.text.startsWith(CONFIG_SUMMARY_PREFIX)) text(block.text);
    }
    return view;
  }
}
