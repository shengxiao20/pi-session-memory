import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, Key } from "@earendil-works/pi-tui";
import { cleanDisplayText } from "../presentation/consultation-presentation.ts";
import type { RecallTurnResult } from "../contracts/recall.ts";

/** Confirm historical participants in a TUI before loading their sessions into memory. */
export async function selectConsultationParticipants(groups: RecallTurnResult[][], context: ExtensionContext, signal?: AbortSignal): Promise<RecallTurnResult[][]> {
  if (!groups.length) return [];
  if (context.mode !== "tui") throw new Error("Consultation participant selection requires Pi TUI mode");
  signal?.throwIfAborted();
  const selected = await context.ui.custom<string[] | undefined>((tui, theme, keys, done) => {
    const checked = new Set(groups.map(group => group[0].session_id));
    let cursor = 0;
    let page = 0;
    const cancel = () => done(undefined);
    signal?.addEventListener("abort", cancel, { once: true });
    const clean = cleanDisplayText;
    return {
      capturesViewportInput: true,
      render(width: number) {
        const group = groups[cursor];
        const header = new Text([
          theme.fg("accent", "Select historical sessions to consult"),
          "No sessions open until you confirm. All candidates start selected.",
          ...groups.map((turns, index) => `${index === cursor ? ">" : " "} [${checked.has(turns[0].session_id) ? "x" : " "}] Agent ${index + 1} | ${clean(turns[0].cwd)}`),
          "Up/Down: candidate | Space: toggle | PageUp/PageDown: evidence | Enter: confirm | Esc: cancel",
          `Selected: ${checked.size}/${groups.length} | Evidence for Agent ${cursor + 1}`,
        ].join("\n"), 0, 0).render(width);
        const preview = group.flatMap(turn => [
          ...new Text(theme.fg("searchMatchText", `Matched turn ${turn.turn_index} | ${new Date(turn.ts).toISOString()} | score ${turn.score}`), 1, 0,
            line => theme.bg("searchMatchBg", line)).render(width),
          ...new Text(theme.fg("userMessageText", `User question:\n${clean(turn.user_text)}`), 1, 0,
            line => theme.bg("userMessageBg", line)).render(width),
          ...new Text(theme.fg("customMessageText", `Historical reply:\n${clean(turn.reply_text)}`), 1, 0,
            line => theme.bg("customMessageBg", line)).render(width),
          "",
        ]);
        const size = Math.max(3, Math.min(16, tui.terminal.rows - header.length - 5));
        page = Math.min(page, Math.max(0, Math.ceil(preview.length / size) - 1));
        return [...header, "", ...preview.slice(page * size, (page + 1) * size), theme.fg("dim", `Evidence page ${page + 1}/${Math.max(1, Math.ceil(preview.length / size))}`)];
      },
      invalidate() {},
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) { done(undefined); return; }
        if (keys.matches(data, "tui.select.confirm")) { done([...checked]); return; }
        if (keys.matches(data, "tui.select.up")) { cursor = (cursor + groups.length - 1) % groups.length; page = 0; }
        else if (keys.matches(data, "tui.select.down")) { cursor = (cursor + 1) % groups.length; page = 0; }
        else if (matchesKey(data, Key.space)) {
          const id = groups[cursor][0].session_id;
          if (checked.has(id)) checked.delete(id); else checked.add(id);
        } else if (keys.matches(data, "tui.select.pageUp")) page = Math.max(0, page - 1);
        else if (keys.matches(data, "tui.select.pageDown")) page++;
        tui.requestRender();
      },
      dispose() { signal?.removeEventListener("abort", cancel); },
    };
  });
  signal?.throwIfAborted();
  if (!selected?.length) return [];
  if (selected.some(id => !groups.some(group => group[0].session_id === id))) throw new Error("Unknown consultation participant selection");
  return groups.filter(group => selected.includes(group[0].session_id));
}
