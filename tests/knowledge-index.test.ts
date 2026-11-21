import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDirectoryIndex, validateDirectoryEntries } from "../src/knowledge/knowledge-index.ts";
import { readConceptMetadata, renderConcept, type OkfSource } from "../src/knowledge/okf-frontmatter.ts";
import { knowledgeFields, knowledgeTurn } from "./helpers/knowledge-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "pi-evidence-navigation-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const configRoot = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configRoot, { recursive: true });
writeFileSync(join(configRoot, "config.json"), JSON.stringify({ recallLimit: 5 }));
const { writeMeetingMinutes, writeTranscriptMinutes } = await import("../src/knowledge/meeting-minutes.ts");
const { inspectMemoryKnowledge, readMemoryKnowledge } = await import("../src/knowledge/memory-knowledge.ts");
const root = join(configRoot, "knowledge");
const topic = `meetings/${knowledgeFields.topic_path}`;
const conclusion = { ...knowledgeFields, description: "Evidence navigation and source validation", findings: "None", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None" };

try {
  for (const kind of ["transcript", "consultation"] as const) {
    for (const count of [0, 1, 2]) {
      const id = `${kind}-${count}`;
      const record = { id, question: "Review evidence navigation", knowledgePath: root, evidence: Array.from({ length: count }, (_, index) => knowledgeTurn(index)) };
      const saved = kind === "transcript" ? writeTranscriptMinutes(record, conclusion) : writeMeetingMinutes({ ...record, owner: "main", timeoutMs: 1000,
        answers: record.evidence.map(turn => ({ sessionId: turn.session_id, question: "Question", answer: "EVIDENCE_BODY_NOT_METADATA", messageIds: [] })),
      }, conclusion);
      const directory = `${topic}/${id}`;
      const index = readDirectoryIndex(root, directory);
      assert.deepEqual(index.entries.map(entry => entry.target), ["minutes.md"]);
      assert.doesNotMatch(readFileSync(join(dirname(saved.path), "index.md"), "utf8"), /evidence-\d|Consultation answer|Transcript evidence/);
      validateDirectoryEntries(root, directory, index);
      assert.deepEqual(inspectMemoryKnowledge(directory).documents, []);
      assert.doesNotMatch(JSON.stringify(inspectMemoryKnowledge(directory)), /EVIDENCE_BODY_NOT_METADATA/);
      assert.equal(readMemoryKnowledge(id).markdown, saved.markdown);
      const metadata = readConceptMetadata(saved.markdown, saved.path);
      assert.equal((metadata.sources as OkfSource[]).length, count);
      for (let number = 1; number <= count; number++) {
        const target = `evidence-${number}.md`;
        const evidencePath = join(dirname(saved.path), target);
        assert.equal(readConceptMetadata(readFileSync(evidencePath, "utf8"), evidencePath).type, kind === "transcript" ? "Transcript Evidence" : "Consultation Evidence");
        assert.match(saved.markdown, new RegExp(`\\[\\^${kind}-${number}\\]: .*\\(${target}\\)`));
      }
    }
  }

  const id = "consultation-2";
  const directory = `${topic}/${id}`;
  const minutesPath = join(root, directory, "minutes.md");
  const evidencePath = join(root, directory, "evidence-1.md");
  const originalMinutes = readFileSync(minutesPath, "utf8");
  const originalEvidence = readFileSync(evidencePath, "utf8");
  const metadata = readConceptMetadata(originalMinutes, minutesPath);
  const sources = metadata.sources as OkfSource[];
  const validate = () => validateDirectoryEntries(root, directory, readDirectoryIndex(root, directory));
  function expectInvalid(pattern: RegExp, mutate: () => void, restore: () => void) {
    try {
      mutate();
      assert.throws(validate, pattern);
      assert.throws(() => inspectMemoryKnowledge(directory), pattern);
      assert.throws(() => inspectMemoryKnowledge(topic), pattern);
      assert.throws(() => readMemoryKnowledge(id), pattern);
    } finally { restore(); }
    validate();
  }
  function invalidSources(next: OkfSource[], pattern: RegExp) {
    expectInvalid(pattern, () => writeFileSync(minutesPath, renderConcept({ ...metadata, sources: next }, "Minutes body")), () => writeFileSync(minutesPath, originalMinutes));
  }

  expectInvalid(/source is missing/, () => rmSync(evidencePath), () => writeFileSync(evidencePath, originalEvidence));
  expectInvalid(/wrong file type/, () => { rmSync(evidencePath); mkdirSync(evidencePath); }, () => { rmSync(evidencePath, { recursive: true }); writeFileSync(evidencePath, originalEvidence); });
  expectInvalid(/symlinks/, () => { rmSync(evidencePath); symlinkSync(minutesPath, evidencePath); }, () => { rmSync(evidencePath); writeFileSync(evidencePath, originalEvidence); });
  expectInvalid(/OKF frontmatter/, () => writeFileSync(evidencePath, "No frontmatter"), () => writeFileSync(evidencePath, originalEvidence));
  expectInvalid(/OKF type/, () => writeFileSync(evidencePath, "---\ntype: ''\n---\n"), () => writeFileSync(evidencePath, originalEvidence));
  expectInvalid(/Invalid OKF frontmatter/, () => writeFileSync(evidencePath, "---\ntype: [broken\n---\n"), () => writeFileSync(evidencePath, originalEvidence));
  expectInvalid(/wrong concept type/, () => writeFileSync(evidencePath, renderConcept({ type: "Reference" }, "Not meeting evidence")), () => writeFileSync(evidencePath, originalEvidence));

  for (const resource of ["../evidence-1.md", "./../evidence-1.md", "/evidence-1.md", "./nested/evidence-1.md", "./nested\\evidence-1.md", "./.hidden.md", "https://example.com/evidence.md"]) {
    invalidSources([{ ...sources[0], resource }, sources[1]], /immediate Markdown children/);
  }
  invalidSources([sources[0], { ...sources[1], resource: sources[0].resource }], /Duplicate meeting evidence target/);
  invalidSources([sources[0], { ...sources[1], id: sources[0].id }], /Duplicate meeting evidence source ID/);
  invalidSources([sources[0]], /Unlisted.*evidence-2\.md/);
  invalidSources([], /Unlisted.*evidence-/);

  const orphanPath = join(root, directory, "evidence-orphan.md");
  expectInvalid(/Unlisted/, () => writeFileSync(orphanPath, originalEvidence), () => rmSync(orphanPath));
  const unknownPath = join(root, directory, "unlisted.md");
  expectInvalid(/Unlisted/, () => writeFileSync(unknownPath, renderConcept({ type: "Reference" }, "Body")), () => rmSync(unknownPath));
  const unknownDirectory = join(root, directory, "unlisted-directory");
  expectInvalid(/Unlisted/, () => mkdirSync(unknownDirectory), () => rmSync(unknownDirectory, { recursive: true }));

  // References, not the evidence filename prefix, define managed evidence.
  const renamedPath = join(root, directory, "supporting-source.md");
  try {
    renameSync(evidencePath, renamedPath);
    writeFileSync(minutesPath, renderConcept({ ...metadata, sources: [{ resource: "./supporting-source.md" }, sources[1]] }, "Minutes body"));
    validate();
    assert.deepEqual(inspectMemoryKnowledge(directory).documents, []);
  } finally {
    renameSync(renamedPath, evidencePath);
    writeFileSync(minutesPath, originalMinutes);
  }
  assert.equal(readMemoryKnowledge(id).markdown, originalMinutes);
  assert.equal(readFileSync(evidencePath, "utf8"), originalEvidence);
  console.log("knowledge-index tests passed: minutes-only navigation, both evidence routes, source integrity, safe paths, explicit errors and unchanged evidence");
} finally { rmSync(home, { recursive: true, force: true }); }
