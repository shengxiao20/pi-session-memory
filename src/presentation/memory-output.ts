import { randomUUID } from "node:crypto";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { RecallTurnResult } from "../contracts/recall.ts";
import type { ConsultationRecord } from "../contracts/consultation.ts";
import { resolveKnowledgePath } from "../knowledge/knowledge-storage.ts";
import { writeMeetingMinutes, type MeetingConclusion } from "../knowledge/meeting-minutes.ts";

export type FinalAssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

export const OKF_OUTPUT_NOTICE = "Only after retrieving transcripts or starting Discussion in this run, save your conclusion before the final answer: use finish_session_consultation for an active Discussion, or finish_memory_recall for transcript evidence. These finish tools are not needed for ordinary questions or when reusing saved OKF knowledge. Provide a short description that summarizes the OKF content without copying the user's question. Provide all conclusion sections; use None for absent sections. Cite consultation-N or transcript-N sources. Never treat agreement as verification. The extension replaces your final assistant message with the exact saved OKF document, including frontmatter. Do not add a separate summary. Missing saved output is an explicit error, not a storage fallback.";

/** Track main-agent evidence and the canonical final document within one agent run. */
export class MemoryOutput {
  private turns = new Map<string, RecallTurnResult>();
  private transcriptRequested = false;
  private discussion = false;
  private markdown?: string;

  addTranscript(turns: RecallTurnResult[]): void {
    this.transcriptRequested = true;
    for (const turn of turns) this.turns.set(turn.turn_id, turn);
    this.markdown = undefined;
  }
  startDiscussion(): void { this.discussion = true; this.markdown = undefined; }
  cancelDiscussion(): void { this.discussion = false; }
  reuse(markdown: string): void {
    if (this.discussion || this.transcriptRequested) throw new Error("Read saved OKF knowledge before starting transcript recall or Discussion");
    this.complete(markdown);
  }
  complete(markdown: string): void { this.markdown = markdown; this.discussion = false; }
  reset(): void { this.turns.clear(); this.transcriptRequested = false; this.discussion = false; this.markdown = undefined; }

  save(question: string, conclusion: MeetingConclusion, owner: string) {
    if (this.discussion) throw new Error("Finish or cancel the active Discussion before saving transcript conclusions");
    if (!this.transcriptRequested) throw new Error("No recalled or fetched transcript request in this agent run");
    if (typeof question !== "string" || !question.trim()) throw new Error("question must be non-empty");
    const evidence = [...this.turns.values()];
    const sessions = [...new Set(evidence.map(turn => turn.session_id))];
    const record: ConsultationRecord = {
      id: randomUUID(), owner, question, knowledgePath: resolveKnowledgePath(), timeoutMs: 0, kind: "transcript", evidence,
      answers: sessions.map(sessionId => ({
        sessionId, question,
        answer: evidence.filter(turn => turn.session_id === sessionId).map(turn => `Turn ${turn.turn_id}\nUser: ${turn.user_text}\nAssistant: ${turn.reply_text}`).join("\n\n"),
        messageIds: [],
      })),
    };
    const result = writeMeetingMinutes(record, conclusion);
    this.complete(result.markdown);
    return result;
  }

  sourceIds(): Array<{ id: string; session_id: string }> {
    return [...new Set([...this.turns.values()].map(turn => turn.session_id))].map((session_id, index) => ({ id: `transcript-${index + 1}`, session_id }));
  }

  finalize(message: FinalAssistantMessage): FinalAssistantMessage {
    if (message.content.some(part => part.type === "toolCall") || ["error", "aborted"].includes(message.stopReason)) return message;
    if (this.markdown !== undefined) return { ...message, content: [{ type: "text", text: this.markdown }] };
    if (this.discussion || this.transcriptRequested) {
      return { ...message, content: [], stopReason: "error", errorMessage: "OKF conclusion was not saved. Call finish_session_consultation or finish_memory_recall before the final answer." };
    }
    return message;
  }
}
