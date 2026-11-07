import type { RecallTurnResult } from "./recall.ts";

/** Shared evidence shapes. Knowledge storage does not depend on the consultation runtime. */
export interface ConsultationAnswer { sessionId: string; question: string; answer: string; messageIds: string[]; }
export interface ConsultationRecord {
  id: string; owner: string; question: string; answers: ConsultationAnswer[]; evidence: RecallTurnResult[];
  knowledgePath: string; timeoutMs: number; kind?: "transcript" | "discussion";
}
