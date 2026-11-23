import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanDisplayText } from "./consultation-presentation.ts";

/** Show one read-only snapshot. The caller supplies entries sorted by descending turn count. */
export async function showDatabaseSessionManagement(
  ctx: ExtensionContext,
  readEntries: () => readonly { session_id: string; turn_count: number }[],
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Database session management requires Pi TUI mode");
  const entries = readEntries().map(entry => ({ ...entry, displayId: cleanDisplayText(entry.session_id).replace(/[\r\n\t]/g, " ") }));
  const total = entries.reduce((sum, entry) => sum + entry.turn_count, 0);
  const maxTurns = entries.reduce((max, entry) => Math.max(max, entry.turn_count), 1);
  const maxIdWidth = entries.reduce((max, entry) => Math.max(max, visibleWidth(entry.displayId)), 0);
  const positions = new Map(entries.map((entry, index) => [entry.session_id, index]));
  const items = entries.map(entry => ({ value: entry.session_id, label: entry.displayId }));
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let cursor = 0;
    let visibleRows = 1;
    const createList = () => {
      const view = new SelectList(items, visibleRows, {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: () => theme.fg("dim", "No sessions are indexed."),
      }, {
        truncatePrimary: ({ item, maxWidth }) => {
          const entry = entries[positions.get(item.value)!];
          return _chartRow(entry.turn_count, entry.displayId, maxWidth, maxTurns, maxIdWidth);
        },
      });
      view.setSelectedIndex(cursor);
      view.onSelectionChange = item => { cursor = positions.get(item.value)!; };
      return view;
    };
    let list = createList();
    return {
      capturesViewportInput: true,
      render(width: number) {
        const header = new Text([
          theme.fg("accent", "Database session management"),
          `${entries.length} sessions | ${total} turns | Read-only snapshot | Descending turn count`,
          theme.fg("dim", "Turns | Bar relative to largest session | sessionId"),
        ].join("\n"), 0, 0).render(width);
        const selected = entries[cursor];
        const detail = selected ? new Text(`sessionId: ${selected.displayId}\nTurns: ${selected.turn_count}`, 0, 0).render(width) : [];
        const controls = new Text(theme.fg("dim", "Up/Down: select | PgUp/PgDn: page | Home/End: first/last | Enter/Esc: close"), 0, 0).render(width);
        // Reserve one blank line and the native list's optional scroll indicator.
        visibleRows = Math.max(1, tui.terminal.rows - header.length - detail.length - controls.length - 2);
        list = createList();
        return [...header, ...list.render(width), "", ...detail, ...controls].map(line => truncateToWidth(line, width, ""));
      },
      invalidate() { list.invalidate(); },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) { done(); return; }
        if (keys.matches(data, "tui.select.pageUp")) cursor = Math.max(0, cursor - visibleRows);
        else if (keys.matches(data, "tui.select.pageDown")) cursor = Math.min(Math.max(0, entries.length - 1), cursor + visibleRows);
        else if (matchesKey(data, Key.home)) cursor = 0;
        else if (matchesKey(data, Key.end)) cursor = Math.max(0, entries.length - 1);
        else { list.handleInput(data); tui.requestRender(); return; }
        list.setSelectedIndex(cursor);
        tui.requestRender();
      },
    };
  });
}

function _chartRow(turns: number, sessionId: string, width: number, maxTurns: number, maxIdWidth: number): string {
  const countWidth = Math.max(5, String(maxTurns).length);
  const available = Math.max(0, width - countWidth - 2);
  const idWidth = Math.min(maxIdWidth, Math.floor(available * 0.6));
  const barWidth = available - idWidth;
  const filled = turns === 0 ? 0 : Math.min(barWidth, Math.max(1, Math.round(turns / maxTurns * barWidth)));
  return truncateToWidth(`${String(turns).padStart(countWidth)} ${"█".repeat(filled).padEnd(barWidth)} ${truncateToWidth(sessionId, idWidth, "")}`, width, "");
}
