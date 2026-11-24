import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import extension from "../extensions/index.ts";
import * as guidance from "../prompts/guidance.ts";
import * as models from "../prompts/models.ts";
import { setupReadResponse, setupSavedResponse } from "../prompts/responses.ts";
import { SETUP_NOTICE, SETUP_REQUEST, readMemorySetup } from "../src/setup/setup.ts";
import { KNOWLEDGE_FIRST_NOTICE } from "../src/knowledge/memory-knowledge.ts";
import { OKF_OUTPUT_NOTICE } from "../src/presentation/memory-output.ts";
import { MAIN_AGENT_NOTICE, CONSULTATION_CLOSED_NOTICE, consultationGuidance } from "../src/presentation/consultation-guidance.ts";
import { CONFIG_FIELDS, ENVIRONMENT_INPUTS } from "../src/setup/config-fields.ts";
import { Linter } from "eslint";
import eslintConfig from "../eslint.config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/prompt-contract.json"), "utf8"));
const linter = new Linter();
const probeOptions = { filename: "prompts/width-probe.ts" };
const longLines = {
  comment: `// ${"x".repeat(78)}`,
  string: `export const text = "${"x".repeat(81)}";`,
  template: `export const text = \`${"x".repeat(81)}\`;`,
  url: `export const url = "https://example.test/${"x".repeat(81)}";`,
};
for (const [kind, code] of Object.entries(longLines)) {
  const messages = linter.verify(`${code}\n`, eslintConfig, probeOptions);
  assert.deepEqual(messages.map(message => message.ruleId), ["max-len"], `${kind}: long lines are errors, not ignored`);
}
assert.deepEqual(linter.verify(`// ${"x".repeat(77)}\n`, eslintConfig, probeOptions), [], "80 characters are accepted");
assert.deepEqual(linter.verify('export const text =\n  "First part ends with a space. " +\n  "Second part continues the same text.";\n', eslintConfig, probeOptions), []);
const formatOptions = JSON.parse(readFileSync(join(root, ".prettierrc.json"), "utf8"));
assert.equal(formatOptions.printWidth, 80);
assert.equal(formatOptions.proseWrap, "always");
for (const name of readdirSync(join(root, "prompts"))) {
  const lines = readFileSync(join(root, "prompts", name), "utf8").split("\n");
  lines.forEach((line, index) => assert.ok(line.length <= 80, `${name}:${index + 1}: resource line exceeds 80 characters`));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]));
  }
  return value;
}
function fingerprint(value: unknown): string {
  const serialized = JSON.parse(JSON.stringify(value));
  return createHash("sha256").update(JSON.stringify(canonical(serialized))).digest("hex");
}
function metadata(tool: ToolDefinition) {
  return { name: tool.name, label: tool.label, description: tool.description, promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines, parameters: tool.parameters, executionMode: tool.executionMode };
}
const tools: ReturnType<typeof metadata>[] = [];
const commands: { name: string; description: string }[] = [];
extension({
  on() {}, // Do not execute startup, history writes, or tool handlers.
  registerTool(tool: ToolDefinition) { tools.push(metadata(tool)); },
  registerCommand(name: string, options: { description: string }) { commands.push({ name, description: options.description }); },
} as unknown as ExtensionAPI);
assert.equal(tools.length, 15);
const conclusionSchemas = ["write_okf", "finish_memory_recall", "finish_session_consultation"].map(name => (tools.find(tool => tool.name === name)!.parameters as TObject).properties.conclusion);
for (const schema of conclusionSchemas) assert.deepEqual(schema, conclusionSchemas[0], "all OKF tools share the complete conclusion schema");
const writeOkf = tools.find(tool => tool.name === "write_okf")!;
assert.match(writeOkf.description, /No historical review or prior tool call is required/);
assert.match(writeOkf.description, /context-1/);
assert.match(writeOkf.description, /does not retrieve history, run Jev or open historical agents/);
assert.match(writeOkf.description, /explicit save request -> write_okf -> final answer/);
const recall = tools.find(tool => tool.name === "recall_memory")!;
for (const notice of [guidance.TRANSCRIPT_WORKFLOW_NOTICE, guidance.DISCUSSION_WORKFLOW_NOTICE, guidance.EVIDENCE_REFRESH_NOTICE]) {
  assert.ok(recall.description.includes(notice), "recall describes both completion routes and evidence invalidation");
  assert.ok(OKF_OUTPUT_NOTICE.includes(notice), "shared guidance uses the same workflow rules");
}
for (const name of ["recall_memory", "review_jev_filtered", "fetch_session"]) {
  const tool = tools.find(tool => tool.name === name)!;
  assert.ok(tool.description.includes(guidance.EVIDENCE_REFRESH_NOTICE), `${name}: additional evidence requires another save`);
  assert.match(tool.promptSnippet!, /before the final answer/, `${name}: compact guidance includes completion`);
}
for (const name of ["follow_up_session", "finish_session_consultation"]) {
  assert.ok(tools.find(tool => tool.name === name)!.description.includes(guidance.DISCUSSION_WORKFLOW_NOTICE), `${name}: private follow-ups lead to a saved conclusion`);
}
assert.ok(tools.find(tool => tool.name === "finish_memory_recall")!.description.includes(guidance.TRANSCRIPT_WORKFLOW_NOTICE));
for (const name of ["read_memory_knowledge", "write_okf", "finish_memory_recall", "finish_session_consultation"]) {
  assert.ok(tools.find(tool => tool.name === name)!.description.includes(guidance.SAVED_OKF_FINAL_NOTICE), `${name}: successful output precedes the exact final document`);
}
const inspect = tools.find(tool => tool.name === "inspect_memory_knowledge")!;
assert.match(inspect.description, /read_memory_knowledge and return its exact saved document as the final answer, with no new finish call/);
assert.match(inspect.description, /recall_memory, compare the returned evidence, then save with finish_memory_recall or finish_session_consultation before the final answer/);
assert.match(tools.find(tool => tool.name === "read_memory_knowledge")!.description, /reuse route requires no finish tool/);
assert.match(guidance.TRANSCRIPT_WORKFLOW_NOTICE, /recall_memory -> compare evidence -> finish_memory_recall -> final answer/);
assert.match(guidance.TRANSCRIPT_WORKFLOW_NOTICE, /including when recall returns zero matches/);
assert.match(guidance.DISCUSSION_WORKFLOW_NOTICE, /compare private answers -> optional follow_up_session -> finish_session_consultation -> final answer/);
assert.match(guidance.EVIDENCE_REFRESH_NOTICE, /empty or duplicate-only transcript results/);
assert.match(guidance.EVIDENCE_REFRESH_NOTICE, /Existing files remain saved/);
assert.match(guidance.EVIDENCE_REFRESH_NOTICE, /After the last evidence read, compare all available evidence and save again in this run/);
assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(fixture.tools).sort());
for (const tool of tools) assert.equal(fingerprint(tool), fixture.tools[tool.name], `${tool.name}: full public metadata and schema`);
assert.equal(fingerprint(commands), fixture.commands);
const notices = { SETUP_NOTICE, SETUP_REQUEST, KNOWLEDGE_FIRST_NOTICE, OKF_OUTPUT_NOTICE, MAIN_AGENT_NOTICE,
  CONSULTATION_CLOSED_NOTICE, closed: consultationGuidance(null), active: consultationGuidance("sample"),
  TRANSIENT_NOTICE: guidance.TRANSIENT_NOTICE, POST_SETUP_IMPORT_NOTICE: guidance.POST_SETUP_IMPORT_NOTICE,
  TRANSCRIPT_WORKFLOW_NOTICE: guidance.TRANSCRIPT_WORKFLOW_NOTICE, DISCUSSION_WORKFLOW_NOTICE: guidance.DISCUSSION_WORKFLOW_NOTICE,
  EVIDENCE_REFRESH_NOTICE: guidance.EVIDENCE_REFRESH_NOTICE, SAVED_OKF_FINAL_NOTICE: guidance.SAVED_OKF_FINAL_NOTICE };
for (const [key, value] of Object.entries(notices)) assert.equal(fingerprint(value), fixture.notices[key], `notice: ${key}`);
assert.equal(SETUP_NOTICE, guidance.SETUP_NOTICE);
assert.equal(KNOWLEDGE_FIRST_NOTICE, guidance.KNOWLEDGE_FIRST_NOTICE);
assert.equal(OKF_OUTPUT_NOTICE, guidance.OKF_OUTPUT_NOTICE);
assert.equal(consultationGuidance("another-id"), consultationGuidance("sample"), "active guidance does not insert or interpret IDs");
const fields = structuredClone(CONFIG_FIELDS);
const knowledgePath = fields.find(field => field.key === "knowledgePath")!;
assert.equal(knowledgePath.defaultLabel, join(homedir(), ".pi", "agent", "pi-session-memory", "knowledge"));
knowledgePath.defaultLabel = "$DEFAULT_KNOWLEDGE_ROOT";
assert.equal(fingerprint(fields), fixture.fields);
assert.equal(fingerprint(ENVIRONMENT_INPUTS), fixture.environment);
const setup = readMemorySetup();
assert.equal(setup.guide_path, join(root, "prompts/setup.md"));
assert.equal(fingerprint(setup.guide), fixture.guide, "Markdown guide matches reviewed soft wrapping");
assert.equal(fingerprint(setup.guide.replace(/\s+/g, " ")), fixture.guideWording, "guide wording matches reviewed storage and separately approved post-setup import");
assert.ok(!existsSync(join(root, "setup.md")), "the guide has one canonical location");

const question = "First line\n第二行🙂 `code` ${literal}";
const reply = "Answer\n回答🙂";
const evidence = models.consultationEvidenceTurn(7, "pi:fixture:user", question, reply);
const modelValues = {
  consultantSystem: models.HISTORICAL_CONSULTANT_SYSTEM_PROMPT, evidence,
  consultation: models.consultationPrompt("cons-示例", question, evidence),
  followUp: models.consultationFollowUpPrompt("cons-示例", question),
  criteria: models.RELEVANCE_CRITERIA, segment: models.jevSegmentQuestion(1, 3, question),
  transcript: models.jevTranscriptText(question, reply),
};
for (const [key, value] of Object.entries(modelValues)) assert.equal(fingerprint(value), fixture.models[key], `model text: ${key}`);
const responseValues = {
  read: setupReadResponse("Guide\n说明", JSON.stringify({ config_path: "/fixture/config.json", configuration: { recallLimit: 20 }, fields: ["field"], environment_inputs: ["env"] }, null, 2)),
  saved: setupSavedResponse("/fixture/config.json", JSON.stringify({ recallLimit: 20 }, null, 2)),
};
for (const [key, value] of Object.entries(responseValues)) assert.equal(fingerprint(value), fixture.responses[key], `setup response: ${key}`);
assert.equal(models.jevTranscriptText("", ""), "User: \n\nAssistant: ");
assert.equal(models.consultationEvidenceTurn(0, "id", "", ""), "Turn 0, turn ID id\nUser: \nAssistant: ");

const temporary = mkdtempSync(join(tmpdir(), "pi-prompt-package-"));
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root, encoding: "utf8" }));
  const archive = join(temporary, pack.filename);
  const archivePaths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
    .filter(path => !path.endsWith("/")).map(path => path.replace(/^package\//, "")).sort();
  assert.deepEqual(archivePaths, pack.files.map((file: { path: string }) => file.path).sort(), "actual archive matches the declared packed files");
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const installed = join(temporary, "package");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
  assert.deepEqual(manifest.pi.prompts, [], "internal Markdown is excluded from Pi slash-command discovery");
  assert.equal(fingerprint(readFileSync(join(installed, "prompts/setup.md"), "utf8")), fixture.guide);
  assert.ok(!archivePaths.some(path => /^(?:docs|tests|scripts|experiments)\//.test(path) || /\.(?:db|sqlite|jsonl)$/.test(path)));
  symlinkSync(resolve(root, "node_modules"), join(installed, "node_modules"), "dir");
  const importExtension = `const { default: extension } = await import(${JSON.stringify(pathToFileURL(join(installed, "extensions/index.ts")).href)});`;
  const importSetup = `const { readMemorySetup } = await import(${JSON.stringify(pathToFileURL(join(installed, "src/setup/setup.ts")).href)});`;
  function runInstalled(script: string) {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
      cwd: installed, encoding: "utf8", env: { ...process.env, HOME: join(temporary, "home"), USERPROFILE: join(temporary, "home"), MEMORY_DB_PATH: join(temporary, "unused.db") },
    });
    assert.equal(result.error, undefined);
    return result;
  }
  const imported = runInstalled(`${importExtension}${importSetup}
    const tools = []; const commands = [];
    extension({on() {}, registerTool(t) { tools.push({name:t.name,label:t.label,description:t.description,promptSnippet:t.promptSnippet,promptGuidelines:t.promptGuidelines,parameters:t.parameters,executionMode:t.executionMode}); }, registerCommand(name,c) { commands.push({name,description:c.description}); }});
    const setup = readMemorySetup(); console.log(JSON.stringify({tools, commands, guide:setup.guide, configuration:setup.configuration}));`);
  assert.equal(imported.status, 0, imported.stderr);
  const installedContract = JSON.parse(imported.stdout);
  assert.deepEqual(installedContract.tools, JSON.parse(JSON.stringify(tools)), "archive imports register exactly the same metadata and complete schemas");
  assert.deepEqual(installedContract.commands, commands);
  assert.equal(fingerprint(installedContract.guide), fixture.guide);
  assert.equal(installedContract.configuration, null);
  assert.ok(!existsSync(join(temporary, "unused.db")) && !existsSync(join(temporary, "home")), "import and read-only setup create no history or configuration");
  rmSync(join(installed, "prompts/setup.md"));
  const missingGuide = runInstalled(`${importSetup}readMemorySetup();`);
  assert.notEqual(missingGuide.status, 0, "missing Markdown must fail");
  assert.match(missingGuide.stderr, /ENOENT/);
  assert.match(missingGuide.stderr, /prompts\/setup\.md/);
  rmSync(join(installed, "prompts/tools.ts"));
  const missingModule = runInstalled(importExtension);
  assert.notEqual(missingModule.status, 0, "missing static prompt module must fail");
  assert.match(missingModule.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(missingModule.stderr, /prompts\/tools\.ts/);
  console.log(`prompt contract tests passed: 15 complete tool schemas, all shared help, reviewed setup responses, unchanged model formats, actual ${pack.version} archive (${archivePaths.length} files), installed imports, no extra prompts, explicit missing-resource errors`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
