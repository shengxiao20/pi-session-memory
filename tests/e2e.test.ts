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

assert.deepEqual(events.map(({ event }) => event), ["session_start", "agent_settled"]);
assert.equal(commands.length, 8);
assert.equal(tools.length, 7);
assert.ok(commands.every(({ options }) => options.description.length > 0), "every user command needs a description");
assert.ok(tools.every((tool) => tool.description.length > 0), "every agent tool needs a description");

const notices: Array<{ message: string; level: string }> = [];
const ctx = { ui: { notify(message: string, level: string) { notices.push({ message, level }); } } };
const helper = commands.find((command) => command.name === "pi-session-memory-helper");
assert.ok(helper);
await helper.options.handler("", ctx);
assert.match(notices[0]?.message ?? "", /pi-session-memory/);

const stats = tools.find((tool) => tool.name === "get_memory_stats");
assert.ok(stats);
const result = await stats.execute();
assert.match(result.content[0]?.text ?? "", /0 turns across 0 sessions/);

cleanup();
console.log("e2e.test.ts: passed");
