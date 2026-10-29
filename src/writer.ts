import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { upsertSession, upsertTurn } from "./db.ts";
import { buildPiTurns } from "./pi-turns.ts";

/** Refresh the latest active user turn from the full Pi tree, including appended and alternate replies. */
export function writeTurn(ctx: ExtensionContext): void {
  const sessionManager = ctx.sessionManager;
  const sessionId = `pi:${sessionManager.getSessionId()}`;
  const userEntry = [...sessionManager.getBranch()].reverse().find((entry) =>
    entry.type === "message" && entry.message.role === "user",
  );
  if (!userEntry) throw new Error("Current session branch has no user message");

  const turn = buildPiTurns(sessionId, sessionManager.getEntries()).find((turn) => turn.user_message_id === userEntry.id);
  if (!turn) return; // Image-only users have no searchable text.

  const header = sessionManager.getHeader();
  upsertSession({
    session_id: sessionId,
    source: "pi",
    cwd: sessionManager.getCwd(),
    started_at: header ? Date.parse(header.timestamp) : userEntry.message.timestamp,
    model_id: null,
    jsonl_path: sessionManager.getSessionFile() ?? "",
  });
  upsertTurn(turn);
}
