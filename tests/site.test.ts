import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../github-page/main.js", import.meta.url), "utf8");
async function testClipboard(writeText: (text: string) => Promise<void>) {
  let listener: () => Promise<void>;
  const status = { textContent: "" };
  const command = "independent clipboard input";
  const elements = {
    "copy-install": { addEventListener: (_event: string, callback: () => Promise<void>) => { listener = callback; } },
    "install-command": { textContent: command },
    "copy-status": status,
  };
  runInNewContext(script, {
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    navigator: { clipboard: { writeText } },
  });
  return { click: listener!, command };
}
let copied = "";
const success = await testClipboard(async (text) => { copied = text; });
await success.click();
assert.equal(copied, success.command);
const failure = new Error("Clipboard denied");
const rejected = await testClipboard(async () => { throw failure; });
await assert.rejects(rejected.click(), (error) => error === failure);
console.log("site.test.ts: clipboard behavior passed");
