import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FinalAssistantMessage } from "../src/presentation/memory-output.ts";
import { knowledgeFields } from "./helpers/knowledge-fixture.ts";
import { readConceptMetadata, renderConcept } from "../src/knowledge/okf-frontmatter.ts";
import { publishKnowledge } from "../src/knowledge/knowledge-publication.ts";

const home = mkdtempSync(join(tmpdir(), "pi-okf-catalogue-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const configRoot = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configRoot, { recursive: true });
const configure = (extra = {}) => writeFileSync(join(configRoot, "config.json"), JSON.stringify({ recallLimit: 20, ...extra }));
configure();
const { inspectMemoryKnowledge, readMemoryKnowledge } = await import("../src/knowledge/memory-knowledge.ts");
const { registerMemoryKnowledgeTools } = await import("../src/knowledge/memory-knowledge-tools.ts");
const { MemoryOutput } = await import("../src/presentation/memory-output.ts");
const { writeTranscriptMinutes } = await import("../src/knowledge/meeting-minutes.ts");
const knowledgeRoot = join(configRoot, "knowledge");
const conclusion = { ...knowledgeFields, description: "Joule research scope and unresolved deployment questions", findings: "BODY_NOT_METADATA", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };
const record = { id: "joule", question: "Review Joule Engagement Layer research", knowledgePath: knowledgeRoot, evidence: [] };
const final = { role: "assistant", content: [{ type: "text", text: "Different response" }], stopReason: "stop", timestamp: 1 } as FinalAssistantMessage;
const topic = `meetings/${conclusion.topic_path}`;
try {
  assert.deepEqual(inspectMemoryKnowledge(), { knowledge_root: knowledgeRoot, directory: "", directories: [], meetings: [], documents: [] });
  assert.ok(!existsSync(knowledgeRoot), "inspection must not create storage");
  assert.throws(() => writeTranscriptMinutes(record, { ...conclusion, description: record.question }), /must summarize the content/);
  for (const topic_path of ["", "../escape", "/absolute", "Uppercase", "a//b", "a\\b", "a/../b"]) assert.throws(() => writeTranscriptMinutes(record, { ...conclusion, topic_path }), /topic_path/);
  assert.throws(() => writeTranscriptMinutes(record, { ...conclusion, topic_summaries: [] }), /topic_summaries/);
  assert.throws(() => writeTranscriptMinutes(record, { ...conclusion, title: "two\nlines" }), /single-line/);
  assert.throws(() => writeTranscriptMinutes(record, { ...conclusion, findings: "Fact.[^transcript-99]" }), /Unknown OKF source citation/);
  assert.ok(!existsSync(knowledgeRoot), "invalid input must not write files");
  const saved = writeTranscriptMinutes(record, conclusion);
  assert.equal(saved.concept_id, `${topic}/joule/minutes`);
  assert.equal(inspectMemoryKnowledge().meetings.length, 0, "root inspection does not flatten all meeting metadata");
  assert.deepEqual(inspectMemoryKnowledge().directories.map(entry => entry.directory), ["meetings"]);
  assert.deepEqual(inspectMemoryKnowledge("meetings").directories.map(entry => entry.directory), ["meetings/agent-memory"]);
  assert.equal(inspectMemoryKnowledge("meetings/agent-memory").directories[0].description, conclusion.topic_summaries[1].description);
  const catalogue = inspectMemoryKnowledge(topic);
  assert.equal(catalogue.meetings.length, 1);
  assert.equal(catalogue.meetings[0].frontmatter.type, "Meeting Minutes");
  assert.equal(catalogue.meetings[0].frontmatter.description, conclusion.description);
  assert.equal(catalogue.meetings[0].index_matches_metadata, true);
  assert.doesNotMatch(JSON.stringify(catalogue), /BODY_NOT_METADATA/);
  assert.match(readFileSync(join(knowledgeRoot, "index.md"), "utf8"), /^---\nokf_version: "0.2"\n---/);
  for (const directory of ["meetings", "meetings/agent-memory", topic, `${topic}/joule`]) assert.doesNotMatch(readFileSync(join(knowledgeRoot, directory, "index.md"), "utf8"), /^---/);
  const before = readFileSync(join(knowledgeRoot, "index.md"), "utf8");
  assert.equal(readMemoryKnowledge("joule").markdown, saved.markdown);
  assert.equal(readFileSync(join(knowledgeRoot, "index.md"), "utf8"), before);
  for (const id of ["", " ", "..", "../joule", "joule/minutes.md", "joule\\minutes.md", ".pending"]) assert.throws(() => readMemoryKnowledge(id), /meeting_id must be/);
  assert.throws(() => readMemoryKnowledge("missing"), /not found/);
  for (const directory of ["../", "/meetings", "meetings/../escape", "meetings\\joule"]) assert.throws(() => inspectMemoryKnowledge(directory), /directory must/);
  assert.throws(() => inspectMemoryKnowledge("meetings/missing"), /ENOENT/);
  assert.throws(() => writeTranscriptMinutes(record, conclusion), /Duplicate meeting_id/);
  assert.throws(() => writeTranscriptMinutes({ ...record, id: "other" }, { ...conclusion, topic_summaries: [{ ...conclusion.topic_summaries[0], description: "Conflicting summary" }, conclusion.topic_summaries[1]] }), /summary conflicts/);
  assert.equal(readFileSync(join(knowledgeRoot, "index.md"), "utf8"), before);

  const output = new MemoryOutput();
  const tools = new Map<string, any>();
  registerMemoryKnowledgeTools((tool: any) => tools.set(tool.name, tool), output);
  const inspected = await tools.get("inspect_memory_knowledge").execute("inspect", { directory: topic });
  assert.doesNotMatch(inspected.content[0].text, /BODY_NOT_METADATA/);
  assert.equal(output.finalize(final), final);
  const read = await tools.get("read_memory_knowledge").execute("read", { meeting_id: "joule" });
  assert.equal(read.content[0].text, saved.markdown);
  assert.equal((output.finalize(final).content[0] as any).text, saved.markdown);
  output.reset(); output.startDiscussion();
  await assert.rejects(tools.get("read_memory_knowledge").execute("wrong-order", { meeting_id: "joule" }), /before starting transcript recall or Discussion/);
  output.reset(); output.addTranscript([]);
  assert.throws(() => output.reuse(saved.markdown), /before starting/);
  for (const tool of tools.values()) assert.match(tool.description, /explicit/);

  // OKF permits optional fields, unknown types, extensions, and a single verified mapping.
  const edited = renderConcept({ type: "Custom Concept", description: "Edited summary", custom: { preserved: true }, verified: { by: "human:test", at: "2026-07-01T10:00:00Z" } }, "BODY_NOT_METADATA");
  writeFileSync(saved.path, edited);
  assert.deepEqual(inspectMemoryKnowledge(topic).meetings[0].frontmatter.custom, { preserved: true });
  assert.equal(inspectMemoryKnowledge(topic).meetings[0].index_matches_metadata, false, "index mismatch must be visible");
  assert.equal(readMemoryKnowledge("joule").markdown, edited);
  writeFileSync(saved.path, renderConcept({ type: "Reference" }, "BODY_NOT_METADATA"));
  assert.equal(inspectMemoryKnowledge(topic).meetings[0].frontmatter.description, undefined, "optional descriptions are not invented");
  const multiline = renderConcept({ type: "Reference", description: "Line one\nLine two" }, "Body");
  writeFileSync(saved.path, multiline);
  assert.equal(readMemoryKnowledge("joule").frontmatter.description, "Line one\nLine two");
  for (const invalid of ["No frontmatter\n", "---\ndescription: Legacy\n---\n", "---\ntype: ''\n---\n", "---\ntype: [broken\n---\n", "---\ntype: Reference\nsources: [{}]\n---\n", "---\ntype: Reference\ngenerated: {at: now}\n---\n"]) {
    writeFileSync(saved.path, invalid);
    assert.throws(() => inspectMemoryKnowledge(topic), /OKF/);
    assert.throws(() => readMemoryKnowledge("joule"), /OKF/);
  }
  writeFileSync(saved.path, saved.markdown);
  assert.throws(() => readConceptMetadata("---\ntype: Reference\ngenerated: {by: test/1, at: '2026-07-01T10:00:00'}\n---\n", "bad-time"), /UTC offset/);
  const indexPath = join(knowledgeRoot, topic, "index.md");
  const originalIndex = readFileSync(indexPath, "utf8");
  rmSync(indexPath);
  assert.throws(() => inspectMemoryKnowledge(topic), /ENOENT/);
  assert.throws(() => writeTranscriptMinutes({ ...record, id: "missing-index-save" }, conclusion), /Unlisted/);
  assert.ok(!existsSync(indexPath), "writing must not silently repair a missing published index");
  assert.equal(readFileSync(join(knowledgeRoot, "index.md"), "utf8"), before);
  writeFileSync(indexPath, originalIndex);
  const wrongType = join(knowledgeRoot, topic, "wrong.md");
  writeFileSync(wrongType, renderConcept({ type: "Reference" }, "Body"));
  writeFileSync(indexPath, `${originalIndex}* [Wrong](wrong.md/) - Wrong file type.\n`);
  assert.throws(() => inspectMemoryKnowledge(topic), /wrong file type/);
  writeFileSync(indexPath, originalIndex); rmSync(wrongType);
  writeFileSync(indexPath, `---\nokf_version: "0.2"\n---\n${originalIndex}`);
  assert.throws(() => inspectMemoryKnowledge(topic), /Only the bundle-root/);
  writeFileSync(indexPath, originalIndex);
  const unlisted = join(knowledgeRoot, topic, "unlisted.md");
  writeFileSync(unlisted, renderConcept({ type: "Reference" }, "Body"));
  assert.throws(() => inspectMemoryKnowledge(topic), /Unlisted/);
  rmSync(unlisted);
  const duplicate = join(knowledgeRoot, "meetings", "duplicate", "joule");
  mkdirSync(duplicate, { recursive: true }); writeFileSync(join(duplicate, "minutes.md"), saved.markdown);
  assert.throws(() => readMemoryKnowledge("joule"), /Duplicate meeting_id/);
  rmSync(dirname(duplicate), { recursive: true });
  symlinkSync(join(home, "missing-target"), join(knowledgeRoot, "meetings", "unsafe"));
  assert.throws(() => readMemoryKnowledge("joule"), /symlinks/);
  assert.throws(() => writeTranscriptMinutes({ ...record, id: "unsafe-save" }, { ...conclusion, topic_path: "unsafe", topic_summaries: [conclusion.topic_summaries[0]] }), /symlinks/);
  rmSync(join(knowledgeRoot, "meetings", "unsafe"));

  // Fail the second index rename and verify that the first index and new directories roll back.
  const rollback = join(home, "rollback"); mkdirSync(rollback);
  const oldIndex = join(rollback, "index.md"); writeFileSync(oldIndex, "before");
  const broken = join(rollback, "broken.md"); mkdirSync(broken);
  assert.throws(() => publishKnowledge(rollback, join(rollback, "meetings", "topic", "id"), new Map([["minutes.md", saved.markdown]]), [
    { path: oldIndex, previous: "before", content: "after" }, { path: broken, content: "cannot replace a directory" },
  ]));
  assert.equal(readFileSync(oldIndex, "utf8"), "before");
  assert.ok(!existsSync(join(rollback, "meetings")));
  assert.ok(!readdirSync(home).some(name => name.startsWith(".pi-session-memory-pending-")));

  // Native file tools and append saves share the complete read/modify/write queue.
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  output.reset();
  output.addTranscript([{ turn_id: "pi:new:turn", session_id: "pi:new", turn_index: 0, ts: 1,
    user_text: "How?", reply_text: "Why?", source: "pi", cwd: home, score: 1 }]);
  let entered!: () => void;
  let release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const nativeEdit = withFileMutationQueue(saved.path, async () => {
    entered(); await waiting;
    writeFileSync(saved.path, `${saved.markdown}\nMANUAL_EDIT_WHILE_QUEUED\n`);
  });
  await held;
  const finish = tools.get("finish_memory_recall");
  const firstAppend = finish.execute("append-one", { question: "Append how", meeting_id: "joule",
    conclusion: { ...conclusion, findings: "FIRST_APPEND[transcript-1]" } });
  const secondAppend = finish.execute("append-two", { question: "Append why", meeting_id: "joule",
    conclusion: { ...conclusion, findings: "SECOND_APPEND[^transcript-1]" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(saved.path, "utf8"), saved.markdown, "the append waits for native edits");
  assert.equal(output.finalize(final).stopReason, "error", "a pending save clears the previous final document");
  const changedConfigurationRoot = join(home, "different-configured-root");
  configure({ knowledgePath: changedConfigurationRoot });
  release(); await nativeEdit;
  const [firstAppended, secondAppended] = await Promise.all([firstAppend, secondAppend]);
  configure();
  assert.equal(firstAppended.details.path, saved.path);
  assert.equal(secondAppended.details.path, saved.path);
  assert.ok(!existsSync(changedConfigurationRoot), "the save pins the root captured before entering the queue");
  const combined = readFileSync(saved.path, "utf8");
  assert.ok(combined.includes("MANUAL_EDIT_WHILE_QUEUED"));
  assert.ok(combined.includes("FIRST_APPEND[transcript-1]"));
  assert.ok(combined.includes("SECOND_APPEND[^transcript-2]"));
  assert.equal(secondAppended.content[0].text, combined);
  assert.equal((output.finalize(final).content[0] as any).text, combined);
  assert.deepEqual((readConceptMetadata(combined, saved.path).sources as any[]).map(source => source.id), ["transcript-1", "transcript-2"]);
  assert.equal(inspectMemoryKnowledge(topic).meetings.length, 1);
  assert.equal(inspectMemoryKnowledge(topic).meetings[0].index_matches_metadata, true);
  const beforeContextEvidence = readFileSync(join(dirname(saved.path), "evidence-1.md"));
  output.reset();
  const appendedContext = await tools.get("write_okf").execute("context-append", {
    question: "Append the visible context", context: "CURRENT_APPEND_SNAPSHOT", meeting_id: "joule",
    conclusion: { ...conclusion, findings: "CONTEXT_APPEND[context-1]" },
  });
  assert.equal(appendedContext.details.path, saved.path);
  assert.equal(appendedContext.content[0].text, readFileSync(saved.path, "utf8"));
  assert.ok(appendedContext.content[0].text.includes(combined.replace(/^---\n[\s\S]*?\n---\n/, "")));
  assert.deepEqual(readFileSync(join(dirname(saved.path), "evidence-1.md")), beforeContextEvidence);
  assert.deepEqual((readConceptMetadata(appendedContext.details.markdown, saved.path).sources as any[]).map(source => source.id), ["transcript-1", "transcript-2", "context-1"]);
  assert.equal((output.finalize(final).content[0] as any).text, appendedContext.details.markdown);
  await assert.rejects(tools.get("write_okf").execute("invalid-append", {
    question: "Append again", context: "Snapshot", meeting_id: "missing", conclusion,
  }), /meeting is missing/);
  assert.equal(output.finalize(final).stopReason, "error", "failed target lookup supplies no stale saved output");
  assert.equal(readFileSync(saved.path, "utf8"), appendedContext.details.markdown);
  output.reset(); output.addTranscript([]);
  await assert.rejects(tools.get("write_okf").execute("wrong-route-append", {
    question: "Append context", context: "Snapshot", meeting_id: "joule", conclusion,
  }), /Use finish_session_consultation or finish_memory_recall/);
  assert.equal(readFileSync(saved.path, "utf8"), appendedContext.details.markdown);

  const vault = join(home, "vault"); mkdirSync(vault);
  writeFileSync(join(vault, "index.md"), "User index");
  const vaultRoot = join(vault, "pi-session-memory");
  configure({ knowledgePath: vaultRoot });
  assert.equal(inspectMemoryKnowledge().knowledge_root, vaultRoot);
  assert.equal(inspectMemoryKnowledge().directories.length, 0);
  const vaultSaved = writeTranscriptMinutes({ ...record, knowledgePath: vaultRoot }, conclusion);
  assert.equal(inspectMemoryKnowledge(topic).meetings[0].path, vaultSaved.path);
  assert.equal(readFileSync(join(vault, "index.md"), "utf8"), "User index");
  configure({ knowledgePath: join(vault, "index.md") });
  assert.throws(() => inspectMemoryKnowledge(), /not an existing file/);
  assert.throws(() => readMemoryKnowledge("joule"), /not an existing file/);
  console.log("memory-knowledge tests passed: OKF conformance, progressive inspection, safe topics, exact reuse, visible metadata signals and rollback");
} finally { rmSync(home, { recursive: true, force: true }); }
