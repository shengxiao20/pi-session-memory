import type { EvidenceRecord } from "./knowledge.ts";

/** Shared evidence shapes. Knowledge storage does not depend on the consultation runtime. */
export interface ConsultationAnswer { sessionId: string; question: string; answer: string; messageIds: string[]; }
export interface ConsultationRecord extends EvidenceRecord {
  owner: string;
  answers: ConsultationAnswer[];
  timeoutMs: number;
}
