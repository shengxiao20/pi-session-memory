import { getSession, type StoredSession } from "./db.ts";

export interface FetchedSessionResult { stored: StoredSession; }

/** Fetch original persisted transcript evidence without changing the local transcript index. */
export function fetchSession(sessionId: string, fromTurnIndex?: number, toTurnIndex?: number): FetchedSessionResult {
  return { stored: getSession(sessionId, fromTurnIndex, toTurnIndex) };
}
