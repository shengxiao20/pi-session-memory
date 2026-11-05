import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const siteRoot = resolve("site");
const html = readFileSync(resolve(siteRoot, "index.html"), "utf8");
const css = readFileSync(resolve(siteRoot, "styles.css"), "utf8");
const script = readFileSync(resolve(siteRoot, "main.js"), "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = parse(readFileSync(".github/workflows/pages.yml", "utf8"));
const readme = readFileSync("README.md", "utf8");
const adr = readFileSync("docs/adr/0001-independent-source-verification.md", "utf8");

assert.match(html, /<html lang="en">/);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1, "page has one primary heading");
assert.ok(html.includes(`Version ${manifest.version} · Install from npm`));
assert.ok(html.includes(manifest.homepage));
assert.match(html, /Pi, Claude Code, and Codex/);
assert.match(html, /Discussion changes the answer/);
assert.match(html, /fetch_session<\/code> stays available/);
assert.match(html, /Fetching never starts automatically and never silently replaces consultation/);
assert.match(html, /ADR 0001/);
assert.match(html, /Participant agreement is not verification/);
assert.match(html, /Discussion uses your configured Pi model/);
assert.match(html, /Source transcripts remain unchanged/);
assert.match(html, /role="status" aria-live="polite"/);
assert.match(html, /class="skip-link"/);
assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion: reduce/);
assert.match(css, /@media \(max-width: 760px\)/);
assert.doesNotMatch(html, /https?:\/\/[^"\s]+\.(?:js|css|woff2?)/, "page loads no external scripts, styles, or fonts");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(ids.length, new Set(ids).size, "HTML IDs are unique");
for (const [, attribute, value] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
  if (value.startsWith("https://")) {
    assert.doesNotThrow(() => new URL(value));
    continue;
  }
  if (value.startsWith("#")) {
    assert.ok(ids.includes(value.slice(1)), `anchor ${value} exists`);
    continue;
  }
  assert.ok(value.startsWith("./"), `${attribute} ${value} is project-path safe`);
  const asset = resolve(siteRoot, value === "./" ? "index.html" : value);
  assert.ok(existsSync(asset), `local asset ${value} exists`);
}
assert.equal([...html.matchAll(/<img\b/g)].length, [...html.matchAll(/<img\b[^>]*\balt=/g)].length, "all images declare alternative text");

assert.deepEqual(workflow.on.push.branches, ["main"]);
assert.deepEqual(workflow.on.push.paths, ["site/**", ".github/workflows/pages.yml"]);
assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"), "manual deployment is available");
assert.equal(workflow.permissions.contents, "read");
assert.equal(workflow.jobs.deploy.permissions.pages, "write");
assert.equal(workflow.jobs.deploy.permissions["id-token"], "write");
assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
const upload = workflow.jobs.deploy.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-pages-artifact@"));
assert.equal(upload.with.path, "site", "deployment exposes only static site files");
assert.match(readme, /Settings → Pages/);
assert.match(readme, /Architecture decision: independent evidence routing/);
assert.match(readme, /fetch_session` remains available to the main agent during either route/);
assert.match(readme, /never falls back to transcript retrieval automatically/);
assert.match(readme, /ADR 0001: Keep source verification independent from Discussion/);
assert.match(adr, /Status: Accepted/);
assert.match(adr, /Discussion selects the output of one `recall_memory` request/);
assert.match(adr, /`fetch_session` remains available to the main agent during an active Discussion/);
assert.match(adr, /does not automatically fall back to transcript retrieval/);
assert.match(adr, /Historical participants run sequentially, in memory, and without tools/);
assert.ok(manifest.files.includes("docs/adr/"), "the published package includes architecture decisions");
assert.match(readme, /python3 -m http\.server 8000 --directory site/);

async function testClipboard(writeText: (text: string) => Promise<void>) {
  let listener: () => Promise<void>;
  const status = { textContent: "" };
  const command = html.match(/<code id="install-command">([^<]+)<\/code>/)![1];
  const elements = {
    "copy-install": { addEventListener: (event: string, callback: () => Promise<void>) => {
      assert.equal(event, "click");
      listener = callback;
    } },
    "install-command": { textContent: command },
    "copy-status": status,
  };
  runInNewContext(script, {
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    navigator: { clipboard: { writeText } },
  });
  return { click: listener!, status, command };
}

let copied = "";
const success = await testClipboard(async (text) => { copied = text; });
await success.click();
assert.equal(copied, "pi install npm:pi-session-memory");
assert.equal(success.status.textContent, "Install command copied.");
const failure = new Error("Clipboard denied");
const rejected = await testClipboard(async () => { throw failure; });
await assert.rejects(rejected.click(), (error) => error === failure);
assert.equal(rejected.status.textContent, "Copy failed. Check your browser clipboard permission.");

console.log("site.test.ts: passed");
