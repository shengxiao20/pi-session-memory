import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TurnRow } from "./db.ts";

/** Build stable Pi turns from the full entry tree, never from JSONL adjacency or the active branch. */
export function buildPiTurns(sessionId: string, entries: readonly SessionEntry[]): TurnRow[] {
  const owners = new Map<string, TurnRow | undefined>();
  const turns: TurnRow[] = [];
  const tools = new Map<TurnRow, Set<string>>();
  let userIndex = 0;

  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || owners.has(entry.id)) {
      throw new Error("Invalid Pi entry.id: expected a unique non-empty string");
    }
    if (entry.parentId !== null && !owners.has(entry.parentId)) {
      throw new Error(`Invalid Pi parentId for ${entry.id}: ${entry.parentId}`);
    }
    let owner = entry.parentId === null ? undefined : owners.get(entry.parentId);
    if (entry.type === "message" && entry.message.role === "user") {
      const turnIndex = userIndex++;
      const userText = _extractText(entry.message);
      // An image-only user still ends its ancestor's turn and occupies an index.
      owner = undefined;
      if (userText) {
        owner = {
          turn_id: `${sessionId}:${entry.id}`,
          session_id: sessionId,
          turn_index: turnIndex,
          ts: entry.message.timestamp,
          user_text: userText,
          reply_text: "",
          tool_names: null,
          user_message_id: entry.id,
        };
        turns.push(owner);
        tools.set(owner, new Set());
      }
    } else if (entry.type === "message" && entry.message.role === "assistant" && owner) {
      const text = _extractText(entry.message);
      if (text) owner.reply_text += (owner.reply_text ? "\n" : "") + text;
      for (const block of entry.message.content) {
        if (block.type === "toolCall") tools.get(owner)!.add(block.name);
      }
    }
    owners.set(entry.id, owner);
  }

  for (const turn of turns) {
    const names = [...tools.get(turn)!];
    turn.tool_names = names.length ? JSON.stringify(names) : null;
  }
  return turns;
}

/** Join only visible text blocks; image, thinking, and tool result payloads are not reply text. */
function _extractText(message: { content: string | Array<{ type: string; text?: string }> }): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content.filter((block) => block.type === "text").map((block) => block.text!.trim()).filter(Boolean).join("\n");
}
