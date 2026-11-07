import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinalAssistantMessage } from "../src/presentation/memory-output.ts";

const home = mkdtempSync(join(tmpdir(), "pi-okf-catalogue-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const configRoot = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configRoot, { recursive: true });
const configure = (extra = {}) => writeFileSync(join(configRoot, "config.json"), JSON.stringify({ recallLimit: 20, ...extra }));
configure();
const { inspectMemoryKnowledge, readMemoryKnowledge } = await import("../src/knowledge/memory-knowledge.ts");
const { registerMemoryKnowledgeTools, openMemoryKnowledgeMenu } = await import("../src/knowledge/memory-knowledge-tools.ts");
const { MemoryOutput } = await import("../src/presentation/memory-output.ts");
const { writeMeetingMinutes } = await import("../src/knowledge/meeting-minutes.ts");
const knowledgeRoot = join(configRoot, "knowledge");
const conclusion = { description: "Joule research scope and unresolved deployment questions", findings: "BODY_NOT_METADATA", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };
const record = { id: "joule", owner: "main", question: "Review Joule Engagement Layer research", knowledgePath: knowledgeRoot, timeoutMs: 0, kind: "transcript" as const, answers: [], evidence: [] };
const final = { role: "assistant", content: [{ type: "text", text: "Different response" }], stopReason: "stop", timestamp: 1 } as FinalAssistantMessage;
try {
  assert.deepEqual(inspectMemoryKnowledge(), { knowledge_root: knowledgeRoot, meetings: [] });
  assert.ok(!existsSync(knowledgeRoot), "inspection must not create storage");
  assert.throws(() => writeMeetingMinutes(record, { ...conclusion, description: record.question }), /must summarize the content/);
  const saved = writeMeetingMinutes(record, conclusion);
  mkdirSync(join(knowledgeRoot, "meetings", ".pending"));
  const catalogue = inspectMemoryKnowledge();
  assert.equal(catalogue.meetings.length, 1, "unpublished pending directories are not saved knowledge");
  assert.equal(catalogue.meetings[0].frontmatter.description, conclusion.description);
  assert.deepEqual(Object.keys(catalogue.meetings[0].frontmatter), ["description"]);
  assert.doesNotMatch(JSON.stringify(catalogue), /BODY_NOT_METADATA/);
  const before = readFileSync(join(knowledgeRoot, "index.md"), "utf8");
  const restored = readMemoryKnowledge("joule");
  assert.equal(restored.markdown, saved.markdown);
  assert.equal(readFileSync(join(knowledgeRoot, "index.md"), "utf8"), before);
  assert.equal(readdirSync(join(knowledgeRoot, "meetings")).length, 2);
  for (const id of ["", " ", "..", "../joule", "joule/minutes.md", "joule\\minutes.md", ".pending"]) {
    assert.throws(() => readMemoryKnowledge(id), /meeting_id must be/);
  }
  assert.throws(() => readMemoryKnowledge("missing"), /ENOENT/);
  const output = new MemoryOutput();
  const tools = new Map<string, any>();
  registerMemoryKnowledgeTools((tool: any) => tools.set(tool.name, tool), output);
  const inspected = await tools.get("inspect_memory_knowledge").execute();
  assert.doesNotMatch(inspected.content[0].text, /BODY_NOT_METADATA/);
  assert.equal(output.finalize(final), final, "metadata inspection alone does not require a new OKF conclusion");
  const read = await tools.get("read_memory_knowledge").execute("read", { meeting_id: "joule" });
  assert.equal(read.content[0].text, saved.markdown);
  assert.equal((output.finalize(final).content[0] as any).text, saved.markdown);
  assert.equal(readdirSync(join(knowledgeRoot, "meetings")).length, 2, "direct reuse must not create a meeting");
  output.reset(); output.startDiscussion();
  await assert.rejects(tools.get("read_memory_knowledge").execute("wrong-order", { meeting_id: "joule" }), /before starting transcript recall or Discussion/);
  output.reset(); output.addTranscript([]);
  assert.throws(() => output.reuse(saved.markdown), /before starting/);
  const notices: string[] = [];
  await openMemoryKnowledgeMenu({ ui: { notify(text: string) { notices.push(text); }, async select(_title: string, choices: string[]) { assert.match(choices[0], /joule — Joule research scope/); return choices[0]; } } } as any);
  assert.equal(notices[1], saved.markdown);
  assert.doesNotMatch(notices[0], /BODY_NOT_METADATA/);
  for (const description of [...tools.values()].map(tool => tool.description)) {
    assert.match(description, /explicit/);
  }

  // Read native YAML edits while enforcing the description-only contract.
  const multiline = saved.markdown.replace('description: "Joule research scope and unresolved deployment questions"', "description: |\n  Joule research scope\n  and unresolved deployment questions");
  writeFileSync(saved.path, multiline);
  assert.match(String(inspectMemoryKnowledge().meetings[0].frontmatter.description), /and unresolved deployment questions/);
  assert.equal(readMemoryKnowledge("joule").markdown, multiline);
  for (const invalid of [
    saved.markdown.replace('description: "Joule research scope and unresolved deployment questions"\n', ""),
    saved.markdown.replace('description: "Joule research scope and unresolved deployment questions"', 'description: " "'),
    saved.markdown.replace('description: "Joule research scope and unresolved deployment questions"', 'description: "Summary"\ntitle: "Extra"'),
    saved.markdown.replace('description: "Joule research scope and unresolved deployment questions"', "description: [broken"),
    "No frontmatter\n",
  ]) {
    writeFileSync(saved.path, invalid);
    assert.throws(() => inspectMemoryKnowledge(), /OKF/);
    assert.throws(() => readMemoryKnowledge("joule"), /OKF/);
  }
  writeFileSync(saved.path, saved.markdown);
  const vault = join(home, "vault");
  mkdirSync(vault);
  configure({ obsidianExportEnabled: true, obsidianVaultPath: vault });
  assert.deepEqual(inspectMemoryKnowledge(), { knowledge_root: vault, meetings: [] }, "enabled vault must not inspect the default root as a fallback");
  writeMeetingMinutes({ ...record, knowledgePath: vault }, conclusion);
  assert.equal(inspectMemoryKnowledge().meetings[0].path, join(vault, "meetings", "joule", "minutes.md"));
  assert.equal(readMemoryKnowledge("joule").path, join(vault, "meetings", "joule", "minutes.md"));
  configure({ obsidianExportEnabled: true, obsidianVaultPath: join(home, "invalid-vault") });
  assert.throws(() => inspectMemoryKnowledge(), /existing absolute vault/);
  assert.throws(() => readMemoryKnowledge("joule"), /existing absolute vault/);
  console.log("memory-knowledge tests passed: metadata-first inspection, required description, exact read-only reuse, strict errors and storage selection");
} finally { rmSync(home, { recursive: true, force: true }); }
