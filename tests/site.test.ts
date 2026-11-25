import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const siteRoot = resolve("github-page");
const html = readFileSync(resolve(siteRoot, "index.html"), "utf8");
const css = readFileSync(resolve(siteRoot, "styles.css"), "utf8");
const script = readFileSync(resolve(siteRoot, "main.js"), "utf8");
const memoryMap = readFileSync(resolve(siteRoot, "assets/memory-map.svg"), "utf8");
const sourceMap = readFileSync(resolve(siteRoot, "assets/codegraph-map.svg"), "utf8");
const sourceSnapshot = JSON.parse(readFileSync(resolve(siteRoot, "assets/codegraph-map.json"), "utf8"));
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const workflow = parse(readFileSync(".github/workflows/pages.yml", "utf8"));
const readme = readFileSync("README.md", "utf8");

assert.match(html, /<html lang="en">/);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1, "page has one primary heading");
assert.ok(html.includes(`Version ${manifest.version} · Install from npm`));
assert.ok(readme.includes(`**Current version: ${manifest.version}**`));
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
assert.match(html, /id="architecture" aria-labelledby="source-architecture-title"/);
assert.match(html, /id="review-routing" aria-labelledby="architecture-title"/);
assert.match(html, /One entry point\. Nine source module groups\./);
assert.ok(html.includes(`${sourceSnapshot.source.sourceFiles} TypeScript files across nine module groups`));
assert.match(html, /<code>recallMode<\/code> selects/);
assert.match(html, /Choice asks after each completed global\/project search/);
assert.match(html, /selection applies only to that call; Esc cancels/);
assert.match(html, /Non-interactive use needs a fixed mode/);
assert.match(html, /A missing timeout raises an error/);
assert.match(html, /With no eligible participants, the main agent receives the retrieved transcripts for that call only/);
assert.match(html, /Cancellation and errors stop the request/);
assert.doesNotMatch(html, /No eligible participants means no consultation answers/);
assert.match(html, /one default or custom <code>knowledgePath<\/code>, independent of consultation settings/);
assert.doesNotMatch(html, /Obsidian|obsidianExportEnabled|obsidianVaultPath/);
assert.match(memoryMap, /choice \(default\)/);
assert.doesNotMatch(`${html}\n${memoryMap}`, /Discussion off/);
assert.match(html, /class="source-map-scroll" tabindex="0" role="region"/);
assert.match(css, /\.source-map-scroll \{ overflow-x: auto;/);
assert.match(css, /\.source-map-scroll:focus-visible/);
assert.match(html, /On small screens, scroll the map horizontally or open the full-size SVG/);
assert.match(css, /\.source-map \{[^}]*min-width: 960px/);
assert.match(html, /src="\.\/assets\/codegraph-map\.svg"/);
assert.match(readme, /\]\(github-page\/assets\/codegraph-map\.svg\)/);
assert.match(html, /href="\.\/assets\/codegraph-map\.json"/);
assert.match(html, /Static relationships are not runtime traces/);
assert.match(html, /Shared <code>prompts\/<\/code> resources are omitted/);
assert.match(html, /blob\/main\/prompts\/setup\.md/);
assert.match(html, /Unresolved Map guesses are excluded/);
assert.match(sourceMap, /CodeGraph Map: pi-session-memory source architecture/);
assert.match(sourceMap, /aria-labelledby="title description"/);
assert.match(sourceMap, /Cards list every cross-domain import/);
assert.ok(html.includes(manifest.homepage));
assert.ok(html.includes(`<meta name="description" content="${manifest.description}">`), "website search description matches npm");
assert.ok(html.includes(`<meta property="og:description" content="${manifest.description}">`), "social description matches npm");
assert.match(html, /Find scattered history\./);
assert.match(html, /SQLite search\. Multi-agent analysis\./);
assert.match(html, /Pi-native by design\.[\s\S]*One history format/);
assert.match(html, /Discussion activates historical Pi sessions as private participants/);
assert.match(html, /Pi-only history avoids external formats that Discussion cannot activate directly/);
assert.match(html, /shared format supports both transcript retrieval and Discussion activation/);
assert.doesNotMatch(html, /Claude Code|Codex/);
assert.match(html, /Multi-agent Discussion/);
assert.match(html, /One main agent/);
assert.match(html, /More than 5 hits/);
assert.match(html, /PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD/);
assert.match(html, /without a session-count cap/);
assert.doesNotMatch(html, /up to three|Up to 3/i);
assert.match(html, /fetch_session<\/code> stays with the main agent/);
assert.match(html, /Fetching never starts automatically and never silently replaces consultation/);
assert.match(memoryMap, /Multi-agent historical review routing/);
assert.match(memoryMap, /Agent 1/);
assert.match(memoryMap, /Agent 2/);
assert.match(memoryMap, /Agent N/);
assert.match(memoryMap, /default 5/);
assert.doesNotMatch(memoryMap, /up to three/i);
assert.match(memoryMap, /independent source check stays available/);
assert.match(html, /Read evidence-routing boundaries/);
assert.match(html, /Edit your configuration/);
assert.match(html, /required\/optional and <code>now: value<\/code> labels/);
assert.match(html, /Saved fields show current values; unset fields show defaults/);
assert.match(html, /Enter saves immediately; Esc goes back/);
assert.doesNotMatch(html, /Confirm before saving/);
assert.match(html, /consultation.turnThreshold/);
assert.doesNotMatch(html, /\/docs\//);
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
assert.deepEqual(workflow.on.push.paths, ["github-page/**", ".github/workflows/pages.yml"]);
assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"), "manual deployment is available");
assert.equal(workflow.permissions.contents, "read");
assert.equal(workflow.jobs.deploy.permissions.pages, "write");
assert.equal(workflow.jobs.deploy.permissions["id-token"], "write");
assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
const upload = workflow.jobs.deploy.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-pages-artifact@"));
assert.equal(upload.with.path, "github-page", "deployment exposes only static site files");
assert.match(readme, /Settings → Pages/);
assert.match(readme, /Architecture decision: independent evidence routing/);
assert.match(readme, /fetch_session` remains available to the main agent during either route/);
assert.match(readme, /never falls back to transcript retrieval automatically/);
assert.ok(!manifest.files.some((path: string) => path.startsWith("docs/")), "retired resources are not declared for publication");
assert.doesNotMatch(readme, /\]\(docs\//);
assert.match(readme, /python3 -m http\.server 8000 --directory github-page/);

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
