import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { mock } from "node:test";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkspaceUsage, type WorkspaceUsageSnapshot } from "../src/history/workspace-usage.ts";
import { showWorkspaceUsage } from "../src/presentation/workspace-usage.ts";
import extension from "../extensions/index.ts";

const home = mkdtempSync(join(tmpdir(), "pi-workspace-usage-"));
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
process.env.HOME = home; process.env.USERPROFILE = home;
const root = join(home, ".pi", "agent", "sessions");
const time = "2026-01-01T00:00:00.000Z";
type Record = { [key: string]: unknown };
function _usage(input = 10, cost = 0.1, provider?: boolean) {
  return { input, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, cacheWrite1h: 1,
    // Native getSessionStats derives total tokens from the four buckets, rather than this field.
    totalTokens: 999, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost,
      ...(provider === undefined ? {} : { totalFromProvider: provider }) } };
}
function _assistant(id = "a", input = 10, cost = 0.1, provider?: boolean): Record {
  return { type: "message", id, parentId: null, timestamp: time,
    message: { role: "assistant", provider: "example", model: "model", content: [{ type: "text", text: "PRIVATE MESSAGE BODY" }], usage: _usage(input, cost, provider) } };
}
function _pricedAssistant(id: string, model: string, changes: Partial<ReturnType<typeof _usage>> = {}): Record {
  const entry = _assistant(id, 10, 0, false);
  const message = entry.message as Record;
  message.model = model;
  message.usage = { ..._usage(10, 0, false), cacheWrite1h: 0, ...changes };
  return entry;
}
function _write(path: string, id: string, cwd: string, entries: Record[] = [], parentSession?: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: time, ...(parentSession ? { parentSession } : {}) }), ...entries.map(e => JSON.stringify(e)), ""].join("\n"));
}
function _tree(path: string): { path: string; bytes: string; mtime: number }[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? _tree(file) : [{ path: relative(home, file), bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function _ui(rows = 24) {
  let component: (Component & { dispose?(): void }) | undefined;
  const state = { closed: 0, builds: 0, renders: 0, color: 36, selection: "Workspace usage" as string | undefined };
  const tui = { terminal: { rows }, requestRender() { state.renders++; } };
  const context = { mode: "tui", ui: {
    async select(_title: string, options: string[]) { assert.ok(options.includes("Workspace usage")); return state.selection; },
    custom(build: any) {
      state.builds++;
      return new Promise<unknown>(resolve => {
        component = build(tui, { fg: (_role: string, text: string) => `\x1b[${state.color}m${text}\x1b[0m` }, getKeybindings(), (result: unknown) => {
          state.closed++; resolve(result); component?.dispose?.();
        });
      });
    },
    notify() { throw new Error("Usage viewing must not notify or request import"); },
    confirm() { throw new Error("Usage viewing must not ask for confirmation"); },
    input() { throw new Error("Usage viewing must not edit settings"); },
  } } as unknown as ExtensionContext;
  return { state, tui, context, view: () => { assert.ok(component); return component; } };
}
async function _tick() { await new Promise(resolve => setImmediate(resolve)); }
function _plain(view: Component, width = 120) { return view.render(width).map(line => stripVTControlCharacters(line).trimEnd()).join("\n"); }
function _selected(view: Component) { return _plain(view).split("\n").find(line => line.startsWith("→ ")); }

try {
  await assert.rejects(getWorkspaceUsage(root), /ENOENT/);
  assert.ok(!existsSync(root), "a missing history root stays missing");
  mkdirSync(root, { recursive: true });
  const empty = await getWorkspaceUsage(root);
  assert.deepEqual(empty.workspaces, []);
  const auxiliaryRoot = join(root, "--Users-example--");
  const ledger = join(auxiliaryRoot, "sol-pi", "session-id", "observation-pack", "ledger.jsonl");
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, '{"observation_id":"example"}\n');
  const auxiliaryBefore = _tree(home);
  assert.deepEqual(await getWorkspaceUsage(root), empty, "nested auxiliary ledgers are outside native session discovery");
  assert.deepEqual(_tree(home), auxiliaryBefore, "auxiliary ledgers remain unchanged");
  const artifacts = join(auxiliaryRoot, "arbitrary-artifacts");
  _write(join(artifacts, "session-copy.jsonl"), "auxiliary-copy", "/projects/auxiliary", [_assistant("auxiliary", 99999, 999)]);
  writeFileSync(join(artifacts, "partial.jsonl"), '{"partial":');
  writeFileSync(join(artifacts, "empty.jsonl"), "");
  const artifactsBefore = _tree(home);
  assert.deepEqual(await getWorkspaceUsage(root), empty, "all nested directories stay outside discovery, including valid session copies");
  assert.deepEqual(_tree(home), artifactsBefore, "auxiliary files remain unchanged regardless of content");
  const corruptSession = join(auxiliaryRoot, "corrupt-session.jsonl");
  writeFileSync(corruptSession, '{"observation_id":"example"}\n');
  const corruptBefore = _tree(home);
  await assert.rejects(getWorkspaceUsage(root), /Invalid Pi string:.*corrupt-session\.jsonl:1\.type/, "malformed workspace-level sessions still throw");
  assert.deepEqual(_tree(home), corruptBefore, "a session parse failure leaves all files unchanged");
  rmSync(corruptSession);
  const parent = join(root, "project", "z-parent.jsonl");
  const fork = join(root, "project", "a-fork.jsonl");
  const copy = { ..._assistant(), parentId: "rewired-parent" };
  _write(parent, "parent", "/projects/team", [
    _assistant(),
    _assistant("abandoned-branch", 1000, 0.2, true),
    { type: "compaction", id: "compaction", timestamp: time, summary: "PRIVATE SUMMARY", usage: _usage(1, 0.3, false) },
    { type: "branch_summary", id: "summary", timestamp: time, usage: _usage(2, 0.4) },
    { type: "message", id: "tool", timestamp: time, message: { role: "toolResult", toolCallId: "call", usage: _usage(3, 0.5) } },
    { type: "usage", id: "aux", timestamp: time, provider: "example", model: "model", kind: "nested", usage: _usage(4, 0.6) },
    { type: "message", message: { role: "assistant", content: [] } },
    { type: "message", message: { role: "toolResult" } },
    { type: "compaction", id: "old-summary", timestamp: time },
    // Custom usage-like data belongs to its extension and is outside native usage accounting.
    { type: "custom", data: { usage: _usage(99999, 999) } },
  ]);
  _write(fork, "fork", "/projects/team", [copy, _assistant("new", 20, 0.7)], parent);
  _write(join(root, "another", "independent.jsonl"), "independent", "/other/team/", [_assistant()]);
  _write(join(root, "zero.jsonl"), "zero", "C:\\workspaces\\zero\\");
  writeFileSync(join(home, "memory.db"), "SENTINEL DATABASE");
  writeFileSync(join(home, "config.json"), "SENTINEL CONFIG");
  writeFileSync(join(home, "minutes.md"), "SENTINEL OKF");
  const before = _tree(home);
  const snapshot = await getWorkspaceUsage(root);
  assert.deepEqual(_tree(home), before, "all file bytes, modification times and directory contents remain unchanged");
  assert.equal(snapshot.workspaces.length, 2);
  const team = snapshot.workspaces[0];
  assert.equal(team.name, "team"); assert.equal(team.session_count, 3);
  assert.deepEqual(team.cwd_paths, ["/other/team/", "/projects/team"]);
  assert.equal(team.usage_entries, 8);
  assert.equal(team.missing_assistant_usage, 1);
  assert.equal(snapshot.workspaces[1].missing_assistant_usage, 0);
  assert.equal(team.input, 10 + 1000 + 1 + 2 + 3 + 4 + 20 + 10);
  assert.equal(team.output, 16); assert.equal(team.cache_read, 24); assert.equal(team.cache_write, 32);
  assert.equal(team.total_tokens, team.input + 16 + 24 + 32);
  assert.ok(Math.abs(team.recorded_cost - 2.9) < 1e-12);
  assert.equal(snapshot.copied_usage_entries, 1);
  assert.equal(snapshot.missing_assistant_usage, 1);
  assert.equal(snapshot.provider_cost_entries, 1);
  assert.equal(snapshot.non_provider_cost_entries, 1);
  assert.equal(snapshot.unknown_cost_entries, 6);
  assert.equal(snapshot.external_parent_files, 0);
  assert.equal(snapshot.workspaces[1].name, "zero");
  assert.equal(snapshot.workspaces[1].total_tokens, 0);
  assert.equal(snapshot.workspaces[1].recorded_cost, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|summary|toolCallId|message|usage\.cost/);
  assert.deepEqual((await getWorkspaceUsage()).workspaces, snapshot.workspaces, "default root uses all Pi workspace directories");

  const cross = join(root, "cross-workspace.jsonl");
  _write(cross, "cross", "/projects/cross", [copy, _assistant("cross-new", 5, 0)], fork);
  const crossSnapshot = await getWorkspaceUsage(root);
  const crossRow = crossSnapshot.workspaces.find(row => row.name === "cross")!;
  assert.equal(crossRow.usage_entries, 1); assert.equal(crossRow.input, 5);
  assert.equal(crossSnapshot.copied_usage_entries, 2);
  assert.equal(crossSnapshot.workspaces.find(row => row.name === "team")!.input, team.input, "inherited work stays attributed to its source workspace");

  const missing = join(root, "missing-original.jsonl");
  _write(missing, "missing-parent", "/projects/orphan", [_assistant("orphan", 2, 0)], join(root, "absent.jsonl"));
  assert.equal((await getWorkspaceUsage(root)).external_parent_files, 1, "missing ancestry is explicit metadata; no external file is opened");
  rmSync(missing);
  const conflict = _assistant();
  (conflict.message as any).usage = _usage(11);
  _write(fork, "fork", "/projects/team", [conflict], parent);
  const conflictBytes = readFileSync(fork);
  await assert.rejects(getWorkspaceUsage(root), /Conflicting copied Pi usage/);
  assert.deepEqual(readFileSync(fork), conflictBytes);
  _write(fork, "fork", "/projects/team", [copy, _assistant("new", 20, 0.7)], parent);
  _write(missing, "cycle", "/projects/cycle", [], missing);
  await assert.rejects(getWorkspaceUsage(root), /Cyclic Pi session parent chain/);
  rmSync(missing);
  _write(missing, "parent", "/projects/duplicate");
  await assert.rejects(getWorkspaceUsage(root), /Duplicate Pi session ID/); rmSync(missing);

  const invalid = join(root, "project", "invalid.jsonl");
  for (const value of [-1, 0.5, "10", null, Number.MAX_SAFE_INTEGER + 1]) {
    const entry = _assistant(); (entry.message as any).usage.input = value;
    _write(invalid, "invalid", "/projects/invalid", [entry]);
    await assert.rejects(getWorkspaceUsage(root), /Invalid Pi token count.*invalid.jsonl:2/);
  }
  for (const value of [-1, "0", null]) {
    const entry = _assistant(); (entry.message as any).usage.cost.total = value;
    _write(invalid, "invalid", "/projects/invalid", [entry]);
    await assert.rejects(getWorkspaceUsage(root), /Invalid Pi recorded cost/);
  }
  const overflow = _assistant(); (overflow.message as any).usage.input = Number.MAX_SAFE_INTEGER;
  _write(invalid, "invalid", "/projects/invalid", [overflow]);
  await assert.rejects(getWorkspaceUsage(root), /Invalid Pi token count.*usage.total/);
  _write(invalid, "invalid", "/projects/invalid", [{ type: "usage", id: "missing", timestamp: time }]);
  await assert.rejects(getWorkspaceUsage(root), /Missing Pi usage/);
  _write(invalid, "invalid", "/projects/invalid", [_assistant(), _assistant()]);
  await assert.rejects(getWorkspaceUsage(root), /Repeated Pi usage entry/);
  writeFileSync(invalid, '{"type":"session","id":"bad","cwd":"/bad"}\n{"partial":');
  await assert.rejects(getWorkspaceUsage(root), /Invalid Pi JSONL:.*invalid.jsonl:2/);
  writeFileSync(invalid, '[]\n'); await assert.rejects(getWorkspaceUsage(root), /Invalid Pi object/);
  writeFileSync(invalid, '{"type":"message"}\n'); await assert.rejects(getWorkspaceUsage(root), /Expected Pi session header/);
  writeFileSync(invalid, ''); await assert.rejects(getWorkspaceUsage(root), /Missing Pi session header/);
  rmSync(invalid);

  const zeroCostFile = join(root, "project", "zero-cost.jsonl");
  _write(zeroCostFile, "zero-cost", "/projects/zero-recorded-cost", [_pricedAssistant("zero-cost-usage", "gpt-6.1-sol", { input: 1000 })]);
  const zeroCostBefore = _tree(home);
  const zeroRecordedCost = (await getWorkspaceUsage(root)).workspaces.find(row => row.name === "zero-recorded-cost")!;
  assert.ok(zeroRecordedCost.total_tokens > 0);
  assert.equal(zeroRecordedCost.recorded_cost, 0, "nonzero tokens retain an explicitly recorded zero cost");
  assert.equal(zeroRecordedCost.estimated_cost_usd, 0.0020303);
  assert.equal(zeroRecordedCost.priced_entries_usd, 1); assert.equal(zeroRecordedCost.priced_entries_cny, 0);
  assert.equal(zeroRecordedCost.unpriced_usage_entries, 0);
  assert.deepEqual(_tree(home), zeroCostBefore);
  rmSync(zeroCostFile);

  const pricedRoot = join(home, "priced-history");
  const source = join(pricedRoot, "source.jsonl");
  const pricedFork = join(pricedRoot, "fork.jsonl");
  const gpt = _pricedAssistant("priced-gpt", "gpt-6.1-sol", { input: 3, output: 68, cacheRead: 0, cacheWrite: 7833 });
  const glm = _pricedAssistant("priced-glm", "glm-5.3", { input: 100, output: 10, cacheRead: 200, cacheWrite: 0 });
  const qwen = _pricedAssistant("unpriced-qwen", "qwen-flash");
  const noModel = { type: "compaction", id: "no-model", timestamp: time, parentId: null, summary: "PRIVATE SUMMARY", usage: _usage(10, 0) };
  _write(source, "priced-source", "/projects/priced", [gpt, glm, qwen, noModel]);
  _write(pricedFork, "priced-fork", "/other/fork", [{ ...gpt, parentId: "rewritten" }, { ...glm, parentId: "rewritten" }, { ...qwen, parentId: "rewritten" }, _pricedAssistant("fork-new", "gpt-6.1-sol", { input: 1 })], source);
  const pricedBefore = _tree(home);
  const priced = await getWorkspaceUsage(pricedRoot);
  const pricedGroup = priced.workspaces.find(row => row.name === "priced")!;
  assert.equal(pricedGroup.recorded_cost, 0);
  assert.equal(pricedGroup.estimated_cost_usd, 0.0202685); assert.equal(pricedGroup.estimated_cost_cny, 0.00148);
  assert.equal(pricedGroup.priced_entries_usd, 1); assert.equal(pricedGroup.priced_entries_cny, 1);
  assert.equal(pricedGroup.unpriced_usage_entries, 2); assert.equal(pricedGroup.unpriced_tokens, 38);
  assert.equal(priced.unpriced_usage_entries, 2); assert.equal(priced.unpriced_tokens, 38);
  assert.equal(priced.copied_usage_entries, 3, "USD, CNY and unpriced copies all stay in their source workspace");
  assert.ok(pricedGroup.unpriced_usage.some(gap => gap.model === "qwen-flash" && /region/.test(gap.reason)));
  assert.ok(pricedGroup.unpriced_usage.some(gap => gap.model === undefined));
  assert.equal(priced.workspaces.find(row => row.name === "fork")!.priced_entries_usd, 1);
  assert.equal(priced.workspaces.find(row => row.name === "fork")!.priced_entries_cny, 0);
  assert.equal(priced.workspaces.find(row => row.name === "fork")!.unpriced_usage_entries, 0);
  for (const row of priced.workspaces) assert.equal(row.priced_entries_usd + row.priced_entries_cny + row.unpriced_usage_entries, row.usage_entries);
  assert.deepEqual(_tree(home), pricedBefore); assert.doesNotMatch(JSON.stringify(priced), /PRIVATE/);
  const paid = _pricedAssistant("recorded-nonzero", "gpt-6.1-sol");
  ((paid.message as Record).usage as ReturnType<typeof _usage>).cost.total = 123.456;
  _write(join(pricedRoot, "recorded.jsonl"), "recorded", "/projects/recorded", [paid]);
  const paidRow = (await getWorkspaceUsage(pricedRoot)).workspaces.find(row => row.name === "recorded")!;
  assert.equal(paidRow.recorded_cost, 123.456); assert.ok(Math.abs(paidRow.estimated_cost_usd - 0.0000503) < 1e-15);
  _write(join(pricedRoot, "tiers.jsonl"), "tiers", "/projects/tiers", [
    _pricedAssistant("short-1", "gpt-6.1-sol", { input: 272000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    _pricedAssistant("short-2", "gpt-6.1-sol", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
    _pricedAssistant("long", "gpt-6.1-sol", { input: 1, output: 0, cacheRead: 272000, cacheWrite: 0 }),
  ]);
  const tierRow = (await getWorkspaceUsage(pricedRoot)).workspaces.find(row => row.name === "tiers")!;
  assert.ok(Math.abs(tierRow.estimated_cost_usd - 0.598406) < 1e-12, "tiers use each request input, rather than the workspace sum");
  const virtual = _pricedAssistant("virtual", "virtual-wrapper");
  (virtual.message as Record).responseModel = "gpt-6.1-sol";
  _write(join(pricedRoot, "virtual.jsonl"), "virtual", "/projects/virtual", [virtual]);
  assert.equal((await getWorkspaceUsage(pricedRoot)).workspaces.find(row => row.name === "virtual")!.priced_entries_usd, 1);
  const badModel = _pricedAssistant("bad-model", "gpt-6.1-sol");
  (badModel.message as Record).model = 123;
  _write(join(pricedRoot, "invalid.jsonl"), "invalid", "/projects/invalid", [badModel]);
  await assert.rejects(getWorkspaceUsage(pricedRoot), /Invalid Pi string/);
  rmSync(join(pricedRoot, "invalid.jsonl"));
  const badLifetime = _pricedAssistant("bad-lifetime", "gpt-6.1-sol", { cacheWrite: 0, cacheWrite1h: 1 });
  _write(join(pricedRoot, "invalid.jsonl"), "invalid", "/projects/invalid", [badLifetime]);
  await assert.rejects(getWorkspaceUsage(pricedRoot), /lifetime subsets/);
  rmSync(pricedRoot, { recursive: true });

  const frozen = JSON.parse(JSON.stringify(snapshot)) as WorkspaceUsageSnapshot;
  for (const row of frozen.workspaces) { Object.freeze(row.cwd_paths); Object.freeze(row); }
  Object.freeze(frozen.workspaces); Object.freeze(frozen);
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let finishLoading!: (snapshot: WorkspaceUsageSnapshot) => void;
    const delayedSnapshot = new Promise<WorkspaceUsageSnapshot>(resolve => { finishLoading = resolve; });
    let delayedReads = 0;
    const loading = _ui();
    const loadingView = showWorkspaceUsage(loading.context, () => { delayedReads++; return delayedSnapshot; });
    await _tick();
    assert.equal(loading.state.builds, 1, "the view mounts while the snapshot is still pending");
    assert.match(_plain(loading.view()), /Reading session JSONL/);
    assert.match(_plain(loading.view()), /⠋/);
    assert.doesNotMatch(_plain(loading.view()), /Sessions:|Recorded cost|█|Esc/);
    const renders = loading.state.renders;
    mock.timers.tick(80);
    assert.match(_plain(loading.view()), /⠙/);
    assert.ok(loading.state.renders > renders, "native spinner ticks request a render");
    for (const width of [20, 40, 80, 120]) {
      for (const height of [1, 8, 24]) {
        loading.tui.terminal.rows = height;
        const lines = loading.view().render(width);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        assert.ok(lines.length <= height);
      }
    }
    loading.tui.terminal.rows = 24;
    loading.state.color = 31; loading.view().invalidate();
    assert.match(loading.view().render(120).join("\n"), /\x1b\[31m/);
    for (const key of ["\x1b", "\r", "\t", "\x1b[B", "\x1b[6~", "\x1b[F"]) loading.view().handleInput!(key);
    assert.equal(loading.state.closed, 0, "table input stays inactive until reading finishes");
    finishLoading(frozen);
    await _tick();
    assert.match(_plain(loading.view()), /Sessions: 4 \| Workspaces: 2/);
    assert.doesNotMatch(_plain(loading.view()), /Reading session JSONL|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    assert.equal(delayedReads, 1); assert.equal(loading.state.builds, 1, "success reuses the loading screen");
    const readyRenders = loading.state.renders;
    mock.timers.tick(800);
    assert.equal(loading.state.renders, readyRenders, "the animation stops after success");
    loading.view().handleInput!("\x1b"); await loadingView;
    const closedRenders = loading.state.renders;
    mock.timers.tick(800);
    assert.equal(loading.state.renders, closedRenders, "closing leaves no animation timer");

    for (const cause of [new Error("injected-delayed-read-failure"), undefined, null]) {
      let failLoading!: (error: unknown) => void;
      const rejectedSnapshot = new Promise<WorkspaceUsageSnapshot>((_resolve, reject) => { failLoading = reject; });
      let failedReads = 0;
      const progress = _ui();
      const failedView = showWorkspaceUsage(progress.context, () => { failedReads++; return rejectedSnapshot; });
      const rejection = failedView.then(() => assert.fail("read failures must reject"), error => assert.equal(error, cause));
      await _tick();
      assert.match(_plain(progress.view()), /Reading session JSONL/);
      failLoading(cause); await rejection; await _tick();
      assert.equal(failedReads, 1); assert.equal(progress.state.builds, 1); assert.equal(progress.state.closed, 1);
      assert.doesNotMatch(_plain(progress.view()), /Sessions:|Recorded cost|█/);
      const failedRenders = progress.state.renders;
      mock.timers.tick(800);
      assert.equal(progress.state.renders, failedRenders, "the animation stops after failure without retry");
    }
  } finally { mock.timers.reset(); }
  let reads = 0;
  const ui = _ui();
  const viewing = showWorkspaceUsage(ui.context, async () => { reads++; return frozen; });
  await _tick();
  const text = _plain(ui.view());
  assert.match(text, /Workspace usage/); assert.match(text, /Sessions: 4 \| Workspaces: 2/);
  assert.match(text, /Total tokens/); assert.match(text, /Cache read/); assert.match(text, /Cache write/);
  assert.match(text, /Estimated USD/); assert.match(text, /Estimated CNY/);
  assert.match(text, /Unpriced entries: 8 \| Unpriced tokens: 1122/);
  assert.match(text, /█/); assert.match(text, /Copied: 1 \| Missing usage: 1 \| External parents: 0/);
  assert.ok(_selected(ui.view())!.includes("team"));
  const dataRows = text.split("\n").filter(line => /^(?:→ |  )(?:team|zero)\s/.test(line));
  assert.equal(dataRows.length, 2);
  assert.ok(dataRows[0].includes(String(team.total_tokens)));
  assert.ok(dataRows[0].includes("—"), "unpriced currencies show a dash rather than a fabricated zero");
  assert.ok(!dataRows[1].includes("█"), "zero use has an empty bar");
  assert.doesNotMatch(text, /PRIVATE|SENTINEL|sessionId|pi:/);
  for (const width of [20, 40, 60, 80, 100, 120]) {
    const lines = ui.view().render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= ui.tui.terminal.rows, `height at width ${width}: ${lines.length}`);
    ui.view().render(width);
  }
  ui.state.color = 31; ui.view().invalidate();
  assert.match(ui.view().render(120).join("\n"), /\x1b\[31m/);
  ui.view().handleInput!("\t");
  assert.match(_plain(ui.view()), /Bars: estimated USD/);
  ui.view().handleInput!("\t"); assert.match(_plain(ui.view()), /Bars: estimated CNY/);
  ui.view().handleInput!("\t"); assert.match(_plain(ui.view()), /Bars: total tokens/);
  assert.ok(_selected(ui.view())!.includes("team"), "sorting preserves the selected workspace");
  ui.view().handleInput!("\r");
  assert.match(_plain(ui.view()), /Input tokens: 1050/);
  assert.match(_plain(ui.view()), /Assistant entries without usage: 1/);
  assert.match(_plain(ui.view()), new RegExp(`Recorded cost \\(\\$\\): ${String(team.recorded_cost).replaceAll(".", "\\.")}`));
  assert.match(_plain(ui.view()), /Estimated cost \(USD\): —/);
  let detailText = _plain(ui.view());
  for (let i = 0; i < 3; i++) { ui.view().handleInput!("\x1b[6~"); detailText += `\n${_plain(ui.view())}`; }
  assert.match(detailText, /All-workspace source assistant entries without usage: 1/);
  assert.match(detailText, /Edit prices: src\/history\/model-pricing.ts/);
  assert.match(detailText, /example\/model: 5 entries; 1089 tokens/);
  assert.match(detailText, /\(model absent\): 3 entries; 33 tokens/);
  assert.match(detailText, /https:\/\/developers.openai.com\/api\/docs\/pricing/);
  assert.doesNotMatch(detailText, /PRIVATE/);
  ui.view().handleInput!("\x1b[F");
  assert.match(_plain(ui.view()), /\/projects\/team/);
  ui.view().handleInput!("\x1b");
  assert.equal(ui.state.closed, 0, "Esc returns from details");
  ui.view().handleInput!("\x1b[B"); assert.ok(_selected(ui.view())!.includes("zero"));
  assert.equal(reads, 1, "navigation, sorting, resizing and theme changes reuse the same snapshot");
  ui.view().handleInput!("\x1b"); await viewing; assert.equal(ui.state.closed, 1);

  let forbiddenReads = 0;
  await assert.rejects(showWorkspaceUsage({ mode: "json" } as ExtensionContext, async () => { forbiddenReads++; return snapshot; }), /requires Pi TUI/);
  assert.equal(forbiddenReads, 0);
  const failed = _ui();
  await assert.rejects(showWorkspaceUsage(failed.context, async () => { forbiddenReads++; throw new Error("injected-read-failure"); }), /injected-read-failure/);
  assert.equal(forbiddenReads, 1); assert.equal(failed.state.builds, 1); assert.equal(failed.state.closed, 1);
  const emptyUi = _ui(); const emptyView = showWorkspaceUsage(emptyUi.context, async () => empty); await _tick();
  assert.match(_plain(emptyUi.view()), /No native session JSONL files/);
  emptyUi.view().handleInput!("\r"); assert.equal(emptyUi.state.closed, 0);
  emptyUi.view().handleInput!("\x1b"); await emptyView;

  const zeroCostUi = _ui();
  const zeroCostView = showWorkspaceUsage(zeroCostUi.context, async () => ({ ...snapshot, workspaces: [zeroRecordedCost] }));
  await _tick();
  zeroCostUi.view().handleInput!("\t");
  assert.match(_plain(zeroCostUi.view()), /Bars: estimated USD/);
  assert.match(_plain(zeroCostUi.view()), /█/);
  assert.match(_plain(zeroCostUi.view()), /0.0020303/);
  zeroCostUi.view().handleInput!("\r");
  assert.match(_plain(zeroCostUi.view()), /Total tokens: 1009/);
  assert.match(_plain(zeroCostUi.view()), /Recorded cost \(\$\): 0/);
  zeroCostUi.view().handleInput!("\x1b"); zeroCostUi.view().handleInput!("\x1b"); await zeroCostView;

  const many = { ...snapshot, workspaces: Array.from({ length: 100 }, (_, i) => ({ ...team, name: `workspace-${String(i).padStart(3, "0")}`, total_tokens: 100 - i, estimated_cost_usd: i, estimated_cost_cny: 100 - i, priced_entries_usd: 1, priced_entries_cny: 1 })) };
  const pages = _ui(18); const paged = showWorkspaceUsage(pages.context, async () => many); await _tick();
  pages.view().render(120);
  pages.view().handleInput!("\x1b[6~"); assert.ok(!_selected(pages.view())!.includes("workspace-000"));
  pages.view().handleInput!("\x1b[F"); assert.ok(_selected(pages.view())!.includes("workspace-099"));
  pages.view().handleInput!("\t"); assert.ok(_selected(pages.view())!.includes("workspace-099"));
  pages.view().handleInput!("\x1b[H"); assert.ok(_selected(pages.view())!.includes("workspace-099"));
  pages.view().handleInput!("\x1b[F"); assert.ok(_selected(pages.view())!.includes("workspace-000"));
  pages.view().handleInput!("\t"); assert.match(_plain(pages.view()), /Bars: estimated CNY/);
  pages.view().handleInput!("\x1b[H"); assert.ok(_selected(pages.view())!.includes("workspace-000"));
  pages.view().handleInput!("\x1b"); await paged;

  const commands: any[] = []; let tools = 0;
  extension({ on() {}, registerTool() { tools++; }, registerCommand(name: string, options: unknown) { commands.push({ name, options }); },
    sendUserMessage() { throw new Error("Workspace usage must not start an Agent request"); },
  } as unknown as ExtensionAPI);
  assert.equal(commands.length, 1); assert.equal(tools, 15);
  const menu = _ui();
  const menuBefore = _tree(home);
  const action = commands[0].options.handler("", menu.context); await _tick();
  // File reads are asynchronous. Wait for the table after the loading phase, using temporary history.
  for (let i = 0; i < 100 && !/Workspaces: 3/.test(_plain(menu.view())); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(menu.state.builds, 1);
  assert.match(_plain(menu.view()), /Workspaces: 3/);
  menu.view().handleInput!("\x1b"); await action;
  assert.deepEqual(_tree(home), menuBefore, "the real menu handler leaves JSONL, database, config and OKF unchanged");
  menu.state.selection = undefined;
  await commands[0].options.handler("", menu.context);
  assert.equal(menu.state.builds, 1);
  assert.deepEqual(_tree(home), menuBefore);
  console.log("workspace-usage.test.ts: separate estimated USD/CNY, unpriced coverage, response model attribution, priced fork deduplication, preserved raw cost, native loading and timer cleanup, single snapshot, bounded discovery, strict validation, read-only menu and native TUI passed");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
  rmSync(home, { recursive: true, force: true });
}
