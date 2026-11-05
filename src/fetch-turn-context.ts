import { getSession, getTurn } from "./db.ts";

/** Resolve an exact recalled turn ID and read its inclusive turn-index context window. */
export function fetchTurnContext(turnId: string, before: number, after: number) {
  if (typeof turnId !== "string" || turnId.length === 0) throw new Error("turn_id must be a non-empty string");
  _validateWindow("before", before);
  _validateWindow("after", after);
  const target = getTurn(turnId);
  const fromTurnIndex = Math.max(0, target.turn_index - before);
  const toTurnIndex = target.turn_index + after;
  if (!Number.isSafeInteger(toTurnIndex)) throw new Error("Context window exceeds the safe integer range");
  const stored = getSession(target.session_id, fromTurnIndex, toTurnIndex);
  return { stored, target, fromTurnIndex, toTurnIndex };
}

function _validateWindow(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}
