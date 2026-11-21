import type { RecallTurnResult } from "./recall.ts";

/** Shared publication input. Transcript evidence does not require synthetic consultation answers. */
export interface EvidenceRecord {
  id: string;
  question: string;
  knowledgePath: string;
  evidence: RecallTurnResult[];
}
