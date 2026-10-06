import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-memory-e2e-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-memory-e2e-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  rmSync(historyHome, { recursive: true, force: true });
}
cleanup();
mkdirSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true });
writeFileSync(join(historyHome, ".pi", "agent", "pi-session-memory", "config.json"), JSON.stringify({ recallLimit: 2 }));

const extension = (await import("../extensions/index.ts")).default;
const events: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
const commands: Array<{ name: string; options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
const tools: Array<{ name: string; description: string; execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> = [];

extension({
  on(event: string, handler: (...args: any[]) => unknown) { events.push({ event, handler }); },
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) { commands.push({ name, options }); },
  registerTool(tool: { name: string; description: string; execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }> }) { tools.push(tool); },
} as any);

assert.deepEqual(events.map(({ event }) => event), ["session_start", "agent_settled", "session_shutdown"]);
assert.equal(commands.length, 1);
assert.deepEqual(commands.map(({ name }) => name), ["pi-session-memory"]);
assert.equal(tools.length, 7);
assert.ok(commands.every(({ options }) => options.description.length > 0), "every user command needs a description");
assert.ok(tools.every((tool) => tool.description.length > 0), "every agent tool needs a description");

const notices: Array<{ message: string; level: string }> = [];
const selections: string[] = ["Help — explain history search, indexing, and migration", `What's new — pi-session-memory v${(await import("../package.json", { with: { type: "json" } })).default.version}`];
const ctx = { ui: {
  notify(message: string, level: string) { notices.push({ message, level }); },
  async select(_title: string, _options: string[]) { return selections.shift(); },
  async input() { return undefined; },
} };
const menu = commands.find((command) => command.name === "pi-session-memory");
assert.ok(menu);
await menu.options.handler("", ctx);
assert.match(notices[0]?.message ?? "", /pi-session-memory/);
await menu.options.handler("", ctx);
assert.match(notices[1]?.message ?? "", /What's New in pi-session-memory v0\.7\.0/);

const migration = tools.find((tool) => tool.name === "migrate_project_sessions");
assert.ok(migration);
assert.match(migration.description, /Claude Code and Codex/);
assert.equal(tools.filter((tool) => /^migrate_(claude|codex)_project_sessions$/.test(tool.name)).length, 0);

const stats = tools.find((tool) => tool.name === "get_memory_stats");
assert.ok(stats);
const result = await stats.execute();
assert.match(result.content[0]?.text ?? "", /0 turns across 0 sessions/);

const recall = tools.find((tool) => tool.name === "recall_memory");
assert.ok(recall);
const recallResult = await recall.execute("call", { entities: ["jev", "filter"], question: "Was jev filtering implemented?" }, undefined, () => {});
const recallText = recallResult.content[0]?.text ?? "";
assert.ok(recallText.startsWith("# Jev result\n**Status:** disabled"), "Jev result must be the first visible section");
assert.ok(recallText.indexOf("# Jev result") < recallText.indexOf("# Recall results"), "Jev result must precede the long recall body");
assert.match(recallText, /\*\*Model:\*\* nimble/);
assert.match(recallText, /\*\*Context window:\*\* unavailable tokens/);
assert.match(recallText, /\*\*Segmented turns:\*\* 0/);
assert.match(recallText, /\*\*Reason:\*\* jevEnable is false/);

const reviewFiltered = tools.find((tool) => tool.name === "review_jev_filtered");
assert.ok(reviewFiltered);
assert.match(reviewFiltered.description, /false negatives/);

cleanup();
console.log("e2e.test.ts: passed");
