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
    let outlines: { top: string; bottom: string }[] = [];
    const createList = () => {
      const view = new SelectList(items, visibleRows, {
        selectedPrefix: text => text,
        selectedText: text => text,
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: () => theme.fg("dim", "No sessions are indexed."),
      }, {
        truncatePrimary: ({ item, maxWidth, isSelected }) => {
          const entry = entries[positions.get(item.value)!];
          const row = _chartRow(entry.turn_count, entry.session_count, maxWidth, maxTurns, maxSessions, isSelected, text => theme.fg("accent", text));
          outlines.push(row);
          return row.middle;
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
          `Total sessions: ${sessions} | Total turns: ${total} | Groups: ${entries.length} | Read-only snapshot`,
          `  ${theme.fg("muted", "Turns per session".padStart(_turnColumnWidth(width - 4, maxTurns)))} ${theme.fg("accent", "Session count")}`,
        ].join("\n"), 0, 0).render(width);
        const controls = new Text(theme.fg("dim", "↑/↓ move · PgUp/PgDn page · Home/End · Enter/Esc close"), 0, 0).render(width);
        // Reserve one blank line and the native scroll indicator; each outlined bar occupies three lines.
        visibleRows = Math.max(1, Math.floor((tui.terminal.rows - header.length - controls.length - 2) / 3));
        list = createList();
        outlines = [];
        const body = list.render(width).flatMap((line, index) => {
          const outline = outlines[index];
          return outline ? [`  ${outline.top}`, line, `  ${outline.bottom}`] : [line];
        });
        return [...header, ...body, "", ...controls].map(line => truncateToWidth(line, width, ""));
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

function _chartRow(turns: number, sessions: number, width: number, maxTurns: number, maxSessions: number, selected: boolean, colorSession: (text: string) => string): { top: string; middle: string; bottom: string } {
  const turnWidth = _turnColumnWidth(width, maxTurns);
  const barWidth = Math.max(0, width - turnWidth - String(maxSessions).length - 4);
  const filled = Math.min(barWidth, Math.max(1, Math.round(sessions / maxSessions * barWidth)));
  const indent = " ".repeat(turnWidth + 1);
  return {
    top: `${indent}${_barStyle(`┌${"─".repeat(filled)}┐`, selected)}`,
    middle: `${String(turns).padStart(turnWidth)} ${_barStyle(`│${" ".repeat(filled)}│`, selected)} ${colorSession(String(sessions))}`,
    bottom: `${indent}${_barStyle(`└${"─".repeat(filled)}┘`, selected)}`,
  };
}

/** Apply the requested fixed border and fill colors independently of the surrounding theme. */
function _barStyle(text: string, selected: boolean): string {
  const fill = selected ? "128;128;128" : "255;255;255";
  return `\x1b[38;2;0;0;0m\x1b[48;2;${fill}m${text}\x1b[39;49m`;
}

/** Align wide views with the heading while reserving space for narrow-view count annotations. */
function _turnColumnWidth(width: number, maxTurns: number): number {
  return Math.max(String(maxTurns).length, Math.min("Turns per session".length, Math.floor(width / 3)));
}
