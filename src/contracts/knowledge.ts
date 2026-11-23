import type { RecallTurnResult } from "./recall.ts";

/** Shared publication identity for all OKF evidence routes. */
export interface MeetingRecord {
  id: string;
  question: string;
  knowledgePath: string;
}

/** Transcript evidence does not require synthetic consultation answers. */
export interface EvidenceRecord extends MeetingRecord {
  evidence: RecallTurnResult[];
}

/** A main-agent snapshot of the current context, not retrieved history. */
export interface ContextRecord extends MeetingRecord {
  context: string;
}
