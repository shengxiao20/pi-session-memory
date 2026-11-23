import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

export const SESSION_DELETION_LABEL = "Delete sessions by turn count";

/** Request an inclusive turn limit; Enter runs deletion and Esc leaves the index unchanged. */
export async function deleteSessionsByTurnCount(
  ctx: ExtensionContext,
  deleteSessions: (maximumTurns: number) => { removed_sessions: number; removed_turns: number; backup_path: string },
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Session deletion requires Pi TUI mode");
  const input = await ctx.ui.input(SESSION_DELETION_LABEL, "Maximum turns per session (inclusive). Enter to delete.");
  if (input === undefined) return;
  const text = input.trim();
  const maximumTurns = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(maximumTurns)) throw new Error(`Enter digits for a maximum turn count from 0 to ${Number.MAX_SAFE_INTEGER}`);
  const result = deleteSessions(maximumTurns);
  ctx.ui.notify([
    `[session-memory] Deleted sessions: ${result.removed_sessions} | Deleted turns: ${result.removed_turns}`,
    `Maximum turns per session (inclusive): ${maximumTurns}`,
    `Backup: ${result.backup_path}`,
    "Original history files stay unchanged. " +
    "Full import or continued use of a deleted session can restore it.",
  ].join("\n"), "info");
}

/** Show one read-only turn-count distribution. Entries arrive sorted by descending turn count. */
export async function showDatabaseSessionManagement(
  ctx: ExtensionContext,
  readEntries: () => readonly { turn_count: number; session_count: number }[],
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Database session management requires Pi TUI mode");
  const entries = readEntries().map(entry => ({ ...entry, shade: Math.floor(Math.random() * 256) }));
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
        selectedPrefix: text => text,
        selectedText: text => text,
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: () => theme.fg("dim", "No sessions are indexed."),
      }, {
        truncatePrimary: ({ item, maxWidth }) => {
          const entry = entries[positions.get(item.value)!];
          return _chartRow(entry.turn_count, entry.session_count, maxWidth, maxTurns, maxSessions, entry.shade, text => theme.fg("accent", text));
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
          `  ${theme.fg("muted", "Turns per session".padEnd(_turnColumnWidth(width - 4, maxTurns)))} ${theme.fg("accent", "Session count")}`,
        ].join("\n"), 0, 0).render(width);
        const controls = new Text(theme.fg("dim", "↑/↓ move · PgUp/PgDn page · Home/End · Enter/Esc close"), 0, 0).render(width);
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

function _chartRow(turns: number, sessions: number, width: number, maxTurns: number, maxSessions: number, shade: number, colorSession: (text: string) => string): string {
  const turnWidth = _turnColumnWidth(width, maxTurns);
  const barWidth = Math.max(0, width - turnWidth - String(maxSessions).length - 2);
  const filled = Math.min(barWidth, Math.max(1, Math.round(sessions / maxSessions * barWidth)));
  return `${String(turns).padEnd(turnWidth)} ${_barStyle("█".repeat(filled), shade)} ${colorSession(String(sessions))}`;
}

/** Use the group's sampled grayscale foreground without changing the terminal background. */
function _barStyle(text: string, shade: number): string {
  return `\x1b[38;2;${shade};${shade};${shade}m${text}\x1b[39m`;
}

/** Align wide views with the heading while reserving space for narrow-view count annotations. */
function _turnColumnWidth(width: number, maxTurns: number): number {
  return Math.max(String(maxTurns).length, Math.min("Turns per session".length, Math.floor(width / 3)));
}
