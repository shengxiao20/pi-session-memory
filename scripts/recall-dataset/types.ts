export const CATEGORIES = ["single_session", "cross_session", "decision_change", "insufficient_evidence"] as const;
export type Category = typeof CATEGORIES[number];
export type Split = "train" | "dev" | "test";

export interface CorpusTurn {
  turn_id: string;
  session_id: string;
  project_id: string;
  turn_index: number;
  timestamp: number;
  user_text: string;
  reply_text: string;
  redactions: number;
}

export interface Evidence {
  turn_id: string;
  session_id: string;
  timestamp: number;
  field: "user_text" | "reply_text";
  quote: string;
}

export interface Candidate {
  sample_id: string;
  category: Category;
  split: Split;
  project_id: string;
  question: string;
  cutoff_timestamp: number;
  scope: { project_id: string; through_timestamp: number };
  source_turn_ids: string[];
  evidence: Evidence[];
  review_status: "pending";
  answerable: null;
  gold_answer: null;
  candidate_answer: string;
}

export interface ExportResult {
  corpus: CorpusTurn[];
  cutoff_timestamp: number;
  exclusions: Record<string, number>;
}

export const DEFAULT_QUOTAS: Record<Category, number> = {
  single_session: 40, cross_session: 25, decision_change: 20, insufficient_evidence: 15,
};
