import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export const WORKSPACE_USAGE_LABEL = "Workspace usage";

/** Presentation-owned projection; the caller supplies the read-only source snapshot. */
interface UsageRow {
  name: string;
  cwd_paths: readonly string[];
  session_count: number;
  usage_entries: number;
  missing_assistant_usage: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  recorded_cost: number;
}
interface UsageView {
  workspaces: readonly UsageRow[];
  copied_usage_entries: number;
  missing_assistant_usage: number;
  external_parent_files: number;
  provider_cost_entries: number;
  non_provider_cost_entries: number;
  unknown_cost_entries: number;
}
type Metric = "total_tokens" | "recorded_cost";

/** Show exact grouped values and compact ranking bars from one on-demand JSONL snapshot. */
export async function showWorkspaceUsage(ctx: ExtensionContext, readUsage: () => Promise<UsageView>): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Workspace usage requires Pi TUI mode");
  const result = await ctx.ui.custom<{ error: unknown } | undefined>((tui, theme, keys, done) => {
    const loader = new BorderedLoader(tui, theme, "Reading session JSONL...", { cancellable: false });
    let snapshot: UsageView | undefined;
    let entries: UsageRow[] = [];
    let sessions = 0;
    let metric: Metric = "total_tokens";
    let cursor = 0;
    let visibleRows = 1;
    let detail: ScrollView | undefined;
    let columns: number[] = [];
    let maximum = 0;
    const createList = () => {
      const list = new SelectList(entries.map((entry, index) => ({ value: String(index), label: _safeText(entry.name) })), visibleRows, {
        selectedPrefix: text => text, selectedText: text => text,
        description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
        noMatch: () => theme.fg("dim", "No native session JSONL files."),
      }, {
        truncatePrimary: ({ item, maxWidth }) => {
          const entry = entries[Number(item.value)];
          const cells = _cells(entry);
          const table = _table(cells, columns);
          const remaining = Math.max(0, maxWidth - visibleWidth(table) - 1);
          const filled = maximum === 0 ? 0 : Math.min(remaining, Math.max(1, Math.round(entry[metric] / maximum * remaining)));
          const bar = entry[metric] === 0 ? "" : "█".repeat(filled);
          return `${table} ${theme.fg("accent", bar)}`;
        },
      });
      list.setSelectedIndex(cursor);
      list.onSelectionChange = item => { cursor = Number(item.value); };
      return list;
    };
    let list = createList();
    void Promise.resolve().then(readUsage).then(value => {
      snapshot = value;
      entries = [...value.workspaces];
      sessions = entries.reduce((sum, entry) => sum + entry.session_count, 0);
      list = createList();
      tui.requestRender();
    }).catch(error => done({ error })).finally(() => loader.dispose());
    return {
      capturesViewportInput: true,
      render(width: number) {
        const title = theme.fg("accent", WORKSPACE_USAGE_LABEL);
        if (snapshot === undefined) {
          return [...new Text(title, 0, 0).render(width), ...loader.render(width)]
            .slice(0, Math.max(1, tui.terminal.rows)).map(line => truncateToWidth(line, width, ""));
        }
        const controls = new Text(theme.fg("dim", detail
          ? "↑/↓ scroll · PgUp/PgDn · Home/End · Enter/Esc back"
          : "↑/↓ move · PgUp/PgDn · Home/End · Tab tokens/cost · Enter details · Esc close"), 0, 0).render(width);
        if (detail) {
          const header = new Text(title, 0, 0).render(width);
          const lines = detail.render(width);
          visibleRows = Math.max(1, tui.terminal.rows - header.length - controls.length - 1);
          detail.updateLayout(lines.length, visibleRows, () => tui.requestRender());
          return [...header, ...lines.slice(detail.scrollTop, detail.scrollTop + visibleRows), "", ...controls].map(line => truncateToWidth(line, width, ""));
        }
        columns = _columnWidths(entries, width - 4);
        maximum = entries.reduce((max, entry) => Math.max(max, entry[metric]), 0);
        const heading = _table(["Workspace", "Sessions", "Total tokens", "Cache read", "Cache write", "Recorded cost ($)"], columns);
        const header = new Text([
          title,
          `Sessions: ${sessions} | Workspaces: ${entries.length} | Bars: ${metric === "total_tokens" ? "total tokens" : "recorded cost"} | JSONL read-only`,
          `Copied: ${snapshot.copied_usage_entries} | Missing usage: ${snapshot.missing_assistant_usage} | External parents: ${snapshot.external_parent_files}`,
          `  ${theme.fg("muted", truncateToWidth(heading, Math.max(0, width - 2), ""))}`,
        ].join("\n"), 0, 0).render(width);
        visibleRows = Math.max(1, tui.terminal.rows - header.length - controls.length - 2);
        list = createList();
        return [...header, ...list.render(width), "", ...controls].map(line => truncateToWidth(line, width, ""));
      },
      invalidate() { if (snapshot === undefined) loader.invalidate(); list.invalidate(); detail?.invalidate(); },
      dispose() { loader.dispose(); },
      handleInput(data: string) {
        if (snapshot === undefined) return;
        if (keys.matches(data, "tui.select.cancel")) {
          if (detail) detail = undefined;
          else { done(undefined); return; }
        } else if (keys.matches(data, "tui.select.confirm")) {
          if (detail) detail = undefined;
          else if (entries.length) detail = new ScrollView(new Text(_details(entries[cursor], snapshot), 0, 0), { scrollbar: "hidden" });
        } else if (detail) {
          if (keys.matches(data, "tui.select.up")) detail.scrollBy(-1);
          else if (keys.matches(data, "tui.select.down")) detail.scrollBy(1);
          else if (keys.matches(data, "tui.select.pageUp")) detail.scrollBy(-visibleRows);
          else if (keys.matches(data, "tui.select.pageDown")) detail.scrollBy(visibleRows);
          else if (matchesKey(data, Key.home)) detail.scrollToStart();
          else if (matchesKey(data, Key.end)) detail.scrollToEnd();
        } else if (matchesKey(data, Key.tab)) {
          const selected = entries[cursor];
          metric = metric === "total_tokens" ? "recorded_cost" : "total_tokens";
          entries = [...entries].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
          cursor = Math.max(0, entries.indexOf(selected));
          list = createList();
        } else if (keys.matches(data, "tui.select.pageUp")) cursor = Math.max(0, cursor - visibleRows);
        else if (keys.matches(data, "tui.select.pageDown")) cursor = Math.min(Math.max(0, entries.length - 1), cursor + visibleRows);
        else if (matchesKey(data, Key.home)) cursor = 0;
        else if (matchesKey(data, Key.end)) cursor = Math.max(0, entries.length - 1);
        else list.handleInput(data);
        list.setSelectedIndex(cursor);
        tui.requestRender();
      },
    };
  });
  if (result !== undefined) throw result.error;
}

function _cells(entry: UsageRow): string[] {
  return [_safeText(entry.name), String(entry.session_count), String(entry.total_tokens), String(entry.cache_read), String(entry.cache_write), String(entry.recorded_cost)];
}

function _columnWidths(entries: readonly UsageRow[], width: number): number[] {
  const rows = [["Workspace", "Sessions", "Total tokens", "Cache read", "Cache write", "Recorded cost ($)"], ...entries.map(_cells)];
  return rows[0].map((_, index) => index === 0
    ? Math.max(1, Math.min(Math.floor(width / 5), Math.max(...rows.map(row => visibleWidth(row[index])))))
    : Math.max(...rows.map(row => visibleWidth(row[index]))));
}

function _table(cells: readonly string[], columns: readonly number[]): string {
  return cells.map((cell, index) => {
    const text = truncateToWidth(cell, columns[index], "");
    return text + " ".repeat(Math.max(0, columns[index] - visibleWidth(text)));
  }).join(" ");
}

function _details(entry: UsageRow, snapshot: UsageView): string {
  return [
    `Workspace: ${_safeText(entry.name)}`, `Sessions: ${entry.session_count}`, `Unique usage entries: ${entry.usage_entries}`,
    `Assistant entries without usage: ${entry.missing_assistant_usage}`,
    `Input tokens: ${entry.input}`, `Output tokens: ${entry.output}`, `Cache read tokens: ${entry.cache_read}`,
    `Cache write tokens: ${entry.cache_write}`, `Total tokens: ${entry.total_tokens}`,
    `Recorded cost ($): ${entry.recorded_cost}`,
    "", "Recorded cost uses JSONL values. Provider invoices show billed cost.",
    "Copied fork usage stays in its earliest available source workspace.",
    `All-workspace copied usage entries: ${snapshot.copied_usage_entries}`,
    `All-workspace source assistant entries without usage: ${snapshot.missing_assistant_usage}`,
    `All-workspace parent files outside snapshot: ${snapshot.external_parent_files}`,
    `All-workspace cost source entries: provider ${snapshot.provider_cost_entries}; non-provider ${snapshot.non_provider_cost_entries}; unspecified ${snapshot.unknown_cost_entries}.`,
    "", "Workspace paths:", ...entry.cwd_paths.map(_safeText),
  ].join("\n");
}

function _safeText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ");
}
