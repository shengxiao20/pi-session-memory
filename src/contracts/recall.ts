/** Shared transcript shapes. Import these types without loading retrieval or storage implementations. */
export type HistorySource = "pi";
export interface RecallOptions { entities: string[]; primary_entity?: string; sources?: HistorySource[]; cwd?: string; sessionIds?: string[]; after?: number; before?: number; }
export interface RecallTurnResult { turn_id: string; session_id: string; turn_index: number; source: HistorySource; cwd: string; ts: number; user_text: string; reply_text: string; score: number; }
