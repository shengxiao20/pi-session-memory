import { getSession, type StoredSession } from "./db.ts";

export interface FetchedSessionResult { stored: StoredSession; }

/** Fetch original persisted transcript evidence without changing the local transcript index. */
export function fetchSession(sessionId: string, fromTurnIndex?: number, toTurnIndex?: number): FetchedSessionResult {
  _requireSourcePrefix(sessionId);
  return { stored: getSession(sessionId, fromTurnIndex, toTurnIndex) };
}

/** Require the exact source-qualified ID exposed by recall_memory rather than guessing a source. */
function _requireSourcePrefix(sessionId: string): void {
  if (!/^(pi|claude|codex):.+$/.test(sessionId)) {
    throw new Error("session_id must include its source prefix (for example, pi:<id>); copy the exact Fetch session ID returned by recall_memory.");
  }
}
