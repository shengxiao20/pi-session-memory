import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { upsertSession, insertTurn } from "./db.ts";

export function writeTurn(ctx: ExtensionContext): void {
  const sessionManager = ctx.sessionManager;
  const sessionId = `pi:${sessionManager.getSessionId()}`;
  const branch = sessionManager.getBranch();
  const userEntry = [...branch].reverse().find((entry) =>
    entry.type === "message" && entry.message.role === "user",
  );
  if (!userEntry) throw new Error("Current session branch has no user message");

  const userText = _extractText(userEntry.message);
  if (!userText) return;

  let replyText = "";
  const toolNames: string[] = [];
  const userIndex = branch.indexOf(userEntry);
  for (const entry of branch.slice(userIndex + 1)) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        replyText += (replyText ? "\n" : "") + block.text.trim();
      }
      if (block.type === "toolCall") toolNames.push(block.name);
    }
  }

  const header = sessionManager.getHeader();
  upsertSession({
    session_id: sessionId,
    source: "pi",
    cwd: sessionManager.getCwd(),
    started_at: header ? Date.parse(header.timestamp) : userEntry.message.timestamp,
    model_id: null,
    jsonl_path: sessionManager.getSessionFile() ?? "",
  });

  insertTurn({
    turn_id: `${sessionId}:${userEntry.id}`,
    session_id: sessionId,
    turn_index: _userTurnIndex(branch, userIndex),
    ts: userEntry.message.timestamp,
    user_text: userText,
    reply_text: replyText,
    tool_names: toolNames.length ? JSON.stringify([...new Set(toolNames)]) : null,
    user_message_id: userEntry.id,
  });
}

function _extractText(message: { content: string | Array<{ type: string; text?: string }> }): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function _userTurnIndex(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, userIndex: number): number {
  return branch.slice(0, userIndex + 1)
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .length - 1;
}
