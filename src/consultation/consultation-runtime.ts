import { randomUUID } from "node:crypto";
import { consultationEvidenceTurn, consultationPrompt, consultationFollowUpPrompt } from "../../prompts/models.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RecallTurnResult } from "../contracts/recall.ts";
import type { ConsultationRecord } from "../contracts/consultation.ts";
import { getDiscussionTurnThreshold, getDiscussionConfiguration } from "../settings/config.ts";
import { createHistoricalAgent, type HistoricalAgent, type HistoricalAgentFactory } from "./consultation-agent.ts";
import { selectConsultationParticipants } from "./consultation-selection.ts";
import { resolveKnowledgePath } from "../knowledge/knowledge-storage.ts";
import { writeMeetingMinutes, type MeetingConclusion } from "../knowledge/meeting-minutes.ts";
import { withKnowledgeMutation } from "../knowledge/knowledge-publication.ts";

/** Keep every historical Pi session above the exclusive unique returned-turn threshold. */
export function selectConsultationSessions(turns: RecallTurnResult[], mainSessionId: string): RecallTurnResult[][] {
  const threshold = getDiscussionTurnThreshold();
  const groups = new Map<string, RecallTurnResult[]>();
  const seen = new Set<string>();
  for (const turn of turns) {
    if (turn.source !== "pi" || turn.session_id === mainSessionId || seen.has(turn.turn_id)) continue;
    seen.add(turn.turn_id);
    const group = groups.get(turn.session_id) ?? [];
    group.push(turn); groups.set(turn.session_id, group);
  }
  return [...groups.values()].filter(group => group.length > threshold)
    .sort((a, b) => Math.max(...b.map(t => t.score)) - Math.max(...a.map(t => t.score))
      || Math.max(...b.map(t => t.ts)) - Math.max(...a.map(t => t.ts)) || a[0].session_id.localeCompare(b[0].session_id));
}

interface Participant { turns: RecallTurnResult[]; agent: HistoricalAgent; }
/** Own one consultation and its in-memory participants. Never broadcast between consultants. */
export class ConsultationRuntime {
  private record?: ConsultationRecord;
  private participants: Participant[] = [];
  private busy = false;
  private controller?: AbortController;
  private closing?: Promise<void>;
  private operation?: Promise<unknown>;
  constructor(private factory: HistoricalAgentFactory = createHistoricalAgent, private selectParticipants = selectConsultationParticipants) {}

  async start(turns: RecallTurnResult[], question: string, context: ExtensionContext, signal?: AbortSignal) {
    if (typeof question !== "string" || !question.trim()) throw new Error("question must be non-empty");
    const config = getDiscussionConfiguration();
    if (!config) throw new Error("Session consultation is disabled or consultation.timeoutMs is not configured");
    if (this.record || this.busy) throw new Error("Finish or cancel the active consultation first");
    const groups = selectConsultationSessions(turns, `pi:${context.sessionManager.getSessionId()}`);
    if (!groups.length) return { status: "no_eligible_sessions" as const, consultation_id: null, answers: [], reason: "No historical native Pi sessions exceed the configured unique returned-turn threshold" };
    this.record = { id: randomUUID(), owner: context.sessionManager.getSessionId(), question, answers: [], evidence: groups.flat(), knowledgePath: resolveKnowledgePath(), timeoutMs: config.timeoutMs };
    return this.run(context, signal, async (requestSignal, startTimeout) => {
      const record = this.record!;
      const selected = await this.selectParticipants(groups, context, requestSignal);
      requestSignal.throwIfAborted();
      if (!selected.length) {
        this.record = undefined;
        return { status: "cancelled" as const, consultation_id: null, answers: [], reason: "User selected no historical sessions; consultation cancelled without fetch fallback" };
      }
      record.evidence = selected.flat();
      startTimeout();
      for (const group of selected) {
        requestSignal.throwIfAborted();
        const agent = await this.factory(group, context);
        if (requestSignal.aborted) { await agent.abort(); agent.dispose(); requestSignal.throwIfAborted(); }
        this.participants.push({ turns: group, agent });
        const evidence = group.map(t => consultationEvidenceTurn(t.turn_index, t.turn_id, t.user_text, t.reply_text)).join("\n\n");
        const prompt = consultationPrompt(record.id, question, evidence);
        record.answers.push(await agent.ask(prompt, requestSignal));
        requestSignal.throwIfAborted();
      }
      if (!this.record || !this.participants.length) throw new Error("Consultation was cancelled during startup");
      return { status: "active" as const, consultation_id: this.record.id, answers: this.record.answers.map(answer => ({ ...answer, question })) };
    }, true);
  }

  async followUp(id: string, sessionId: string, question: string, context: ExtensionContext, signal?: AbortSignal) {
    this.require(id, context);
    if (typeof question !== "string" || !question.trim()) throw new Error("question must be non-empty");
    if (!getDiscussionConfiguration()) throw new Error("Session consultation is disabled");
    const participant = this.participants.find(p => p.turns[0].session_id === sessionId);
    if (!participant) throw new Error("Target session is not a participant in this consultation");
    return this.run(context, signal, async (requestSignal) => {
      const record = this.record!;
      const answer = await participant.agent.ask(consultationFollowUpPrompt(id, question), requestSignal);
      requestSignal.throwIfAborted();
      record.answers.push(answer); return answer;
    });
  }

  async finish(id: string, conclusion: MeetingConclusion, context: ExtensionContext, meetingId?: string) {
    this.require(id, context);
    if (this.busy) throw new Error("Consultation is still running");
    const record = this.record!;
    this.busy = true;
    try {
      const result = await withKnowledgeMutation(record.knowledgePath, meetingId, () => {
        this.require(id, context);
        return writeMeetingMinutes(record, conclusion, meetingId);
      });
      await this.close(); return result;
    } finally { this.busy = false; }
  }
  async cancel(id: string, context: ExtensionContext) { this.require(id, context); await this.close(); }
  async close() {
    if (this.closing) return this.closing;
    this.controller?.abort(new Error("Consultation cancelled"));
    this.closing = (async () => {
      const errors: unknown[] = [];
      const aborted = await Promise.allSettled(this.participants.map(participant => participant.agent.abort()));
      for (const result of aborted) if (result.status === "rejected") errors.push(result.reason);
      if (this.operation) await Promise.allSettled([this.operation]);
      for (const participant of this.participants) {
        try { participant.agent.dispose(); } catch (error) { errors.push(error); }
      }
      this.participants = []; this.record = undefined;
      if (errors.length) throw new AggregateError(errors, "Consultation cleanup failed");
    })();
    try { await this.closing; } finally { this.closing = undefined; }
  }
  private require(id: string, context: ExtensionContext) {
    if (!this.record || this.record.id !== id) throw new Error("Unknown consultation ID");
    if (this.record.owner !== context.sessionManager.getSessionId()) throw new Error("Consultation belongs to another main session");
  }
  private async run<T>(_context: ExtensionContext, signal: AbortSignal | undefined, operation: (signal: AbortSignal, startTimeout: () => void) => Promise<T>, deferTimeout = false): Promise<T> {
    if (this.busy) throw new Error("Concurrent consultation calls are not allowed");
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startTimeout = () => { timer = setTimeout(() => controller.abort(new Error("Consultation request timed out")), this.record!.timeoutMs); };
    if (!deferTimeout) startTimeout();
    try {
      controller.signal.throwIfAborted();
      const pending = Promise.resolve().then(() => operation(controller.signal, startTimeout));
      this.operation = pending;
      const result = await pending;
      controller.signal.throwIfAborted(); return result;
    } catch (error) { await this.close(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.operation = undefined; this.busy = false; this.controller = undefined; }
  }
}
