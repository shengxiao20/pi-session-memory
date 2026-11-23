import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Show one read-only turn-count distribution. Entries arrive sorted by descending turn count. */
export async function showDatabaseSessionManagement(
  ctx: ExtensionContext,
  readEntries: () => readonly { turn_count: number; session_count: number }[],
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Database session management requires Pi TUI mode");
  const entries = readEntries();
  const sessions = entries.reduce((sum, entry) => sum + entry.session_count, 0);
  const total = entries.reduce((sum, entry) => sum + entry.turn_count * entry.session_count, 0);
  const maxTurns = entries.reduce((max, entry) => Math.max(max, entry.turn_count), 0);
  const maxSessions = entries.reduce((max, entry) => Math.max(max, entry.session_count), 1);
  const positions = new Map(entries.map((entry, index) => [String(entry.turn_count), index]));
  const items = entries.map(entry => ({ value: String(entry.turn_count), label: String(entry.turn_count) }));
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
          return _chartRow(entry.turn_count, entry.session_count, maxWidth, maxTurns, maxSessions);
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
          `Sessions: ${sessions} | Turns: ${total} | Groups: ${entries.length} | Read-only snapshot`,
          theme.fg("dim", "Turns per session | Sessions (bar and number) | Descending turn count"),
        ].join("\n"), 0, 0).render(width);
        const controls = new Text(theme.fg("dim", "Up/Down: select | PgUp/PgDn: page | Home/End: first/last | Enter/Esc: close"), 0, 0).render(width);
        // Reserve one blank line and the native list's optional scroll indicator.
        visibleRows = Math.max(1, tui.terminal.rows - header.length - controls.length - 2);
        list = createList();
        return [...header, ...list.render(width), "", ...controls].map(line => truncateToWidth(line, width, ""));
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

function _chartRow(turns: number, sessions: number, width: number, maxTurns: number, maxSessions: number): string {
  const turnWidth = Math.max(5, String(maxTurns).length);
  const barWidth = Math.max(0, width - turnWidth - String(maxSessions).length - 2);
  const filled = Math.min(barWidth, Math.max(1, Math.round(sessions / maxSessions * barWidth)));
  return truncateToWidth(`${String(turns).padStart(turnWidth)} ${"█".repeat(filled)} ${sessions}`, width, "");
}
