import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDirectoryIndex } from "../src/knowledge/knowledge-index.ts";
import { readConceptMetadata } from "../src/knowledge/okf-frontmatter.ts";
import type { ConsultationRecord } from "../src/contracts/consultation.ts";
import type { MeetingConclusion } from "../src/knowledge/meeting-minutes.ts";

const home = mkdtempSync(join(tmpdir(), "okf-diagram-semantics-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const configRoot = join(home, ".pi", "agent", "pi-session-memory");
mkdirSync(configRoot, { recursive: true });
writeFileSync(join(configRoot, "config.json"), JSON.stringify({ recallLimit: 5 }));
const root = join(configRoot, "knowledge");
const { writeContextMinutes, writeMeetingMinutes, writeTranscriptMinutes } = await import("../src/knowledge/meeting-minutes.ts");
const { inspectMemoryKnowledge, readMemoryKnowledge } = await import("../src/knowledge/memory-knowledge.ts");
const { resolveKnowledgePath } = await import("../src/knowledge/knowledge-storage.ts");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

try {
  assert.equal(resolveKnowledgePath(), root);
  const conclusion: MeetingConclusion = {
    title: "OKF publication semantics", description: "Publication, evidence references and progressive reading",
    topic_path: "diagrams/okf", tags: ["diagram"], topic_summaries: [
      { title: "Diagrams", description: "Source-grounded diagram verification" },
      { title: "OKF", description: "OKF publication and reuse verification" },
    ],
    findings: "None", decisions: "None", unverified_inferences: "None", disagreements: "None", open_questions: "None", actions: "None",
  };
  for (const kind of ["transcript", "discussion"] as const) {
    const route = kind === "transcript" ? "transcript" : "consultation";
    const turnId = "pi:historical:user-1";
    const record: ConsultationRecord = {
      id: `diagram-${route}`, owner: "main", question: "Review the generated OKF diagram",
      knowledgePath: root, timeoutMs: 1000,
      answers: [
        { sessionId: "pi:historical", question: "Review question", answer: "FIRST_ANSWER_BODY", messageIds: ["answer-1"] },
        { sessionId: "pi:historical", question: "Private follow-up", answer: "FOLLOW_UP_BODY", messageIds: ["answer-2"] },
      ],
      evidence: [{ turn_id: turnId, session_id: "pi:historical", turn_index: 0, ts: 0, user_text: "HISTORICAL_USER_BODY",
        reply_text: "HISTORICAL_REPLY_BODY", source: "pi", cwd: home, score: 10 }],
    };
    if (kind === "transcript") record.evidence.push({ ...record.evidence[0], turn_id: "pi:second:user-1", session_id: "pi:second",
      user_text: "SECOND_HISTORICAL_USER_BODY", reply_text: "SECOND_HISTORICAL_REPLY_BODY" });
    const routeConclusion = { ...conclusion,
      findings: `${kind === "transcript" ? "Each session has one transcript evidence file." : "The initial answer and follow-up are separate evidence files."}[^${route}-1][^${route}-2]`,
    };
    const result = kind === "transcript" ? writeTranscriptMinutes(record, routeConclusion) : writeMeetingMinutes(record, routeConclusion);
    assert.equal(result.okf_version, "0.2");
    assert.equal(result.status, "draft");
    const directory = dirname(result.path);
    const files = readdirSync(directory).sort();
    assert.deepEqual(files, ["evidence-1.md", "evidence-2.md", "index.md", "minutes.md"]);
    const metadata = readConceptMetadata(result.markdown, result.path);
    assert.deepEqual(Object.keys(metadata).sort(), ["description", "generated", "sources", "status", "tags", "title", "type"]);
    assert.equal(metadata.type, "Meeting Minutes");
    assert.equal(metadata.status, "draft");
    assert.deepEqual(metadata.tags, ["diagram"]);
    const generated = metadata.generated as { by: string; at: string };
    assert.equal(generated.by, `pi-session-memory/${version}`);
    assert.ok(Number.isFinite(Date.parse(generated.at)));
    const sources = metadata.sources as Array<{ id: string; resource: string; title: string }>;
    assert.equal(sources.length, kind === "transcript" ? new Set(record.evidence.map(turn => turn.session_id)).size : record.answers.length);
    assert.equal(new Set(record.answers.map(answer => answer.sessionId)).size, 1);
    for (const [index, source] of sources.entries()) {
      assert.equal(source.id, `${route}-${index + 1}`);
      assert.equal(source.resource, `./evidence-${index + 1}.md`);
      assert.ok(result.markdown.includes(`[^${source.id}]:`));
      const evidencePath = join(directory, source.resource);
      const evidenceMarkdown = readFileSync(evidencePath, "utf8");
      const evidenceMetadata = readConceptMetadata(evidenceMarkdown, evidencePath);
      assert.equal(evidenceMetadata.type, kind === "transcript" ? "Transcript Evidence" : "Consultation Evidence");
      assert.deepEqual(evidenceMetadata.generated, generated);
      assert.equal(evidenceMetadata.status, "draft");
      const originalSources = evidenceMetadata.sources as Array<{ id: string; resource: string }>;
      const turn = record.evidence[kind === "transcript" ? index : 0];
      assert.equal(originalSources[0].id, turn.turn_id);
      assert.equal(originalSources[0].resource, turn.turn_id);
      for (const text of [turn.user_text, turn.reply_text]) assert.equal(evidenceMarkdown.split(text).length - 1, 1);
      if (kind === "transcript") {
        assert.ok(evidenceMarkdown.includes(record.question));
        assert.doesNotMatch(evidenceMarkdown, /# Answer\n|FIRST_ANSWER_BODY|FOLLOW_UP_BODY/);
      } else {
        for (const text of [record.answers[index].question, record.answers[index].answer]) assert.ok(evidenceMarkdown.includes(text));
        assert.match(evidenceMarkdown, /# Answer\n/);
      }
    }
    const relative = `meetings/diagrams/okf/${record.id}`;
    assert.deepEqual(readDirectoryIndex(root, relative).entries.map(entry => entry.target), ["minutes.md"]);
    const snapshot = new Map(files.map(file => [file, readFileSync(join(directory, file), "utf8")]));
    let catalogue = inspectMemoryKnowledge();
    assert.deepEqual(catalogue.directories.map(entry => entry.directory), ["meetings"]);
    for (const scope of ["meetings", "meetings/diagrams", "meetings/diagrams/okf", relative]) {
      catalogue = inspectMemoryKnowledge(scope);
      for (const marker of ["FIRST_ANSWER_BODY", "FOLLOW_UP_BODY", "HISTORICAL_USER_BODY", "HISTORICAL_REPLY_BODY"]) {
        assert.ok(!JSON.stringify(catalogue).includes(marker));
      }
      assert.deepEqual(catalogue.documents, []);
    }
    assert.equal(readMemoryKnowledge(record.id).markdown, result.markdown);
    for (const file of files) assert.equal(readFileSync(join(directory, file), "utf8"), snapshot.get(file));
    for (const heading of ["Question", "Findings", "Decisions", "Unverified inferences", "Disagreements", "Open questions", "Actions", "Sources"]) {
      assert.ok(result.markdown.includes(`# ${heading}\n`));
    }
  }
  const context = "CURRENT_CONTEXT_BODY\nUse the shared writer and preserve source boundaries.";
  const contextRecord = { id: "diagram-context", question: "Save the current context as OKF", knowledgePath: root, context };
  const contextSaved = writeContextMinutes(contextRecord, { ...conclusion, findings: "One writer supports every route.[^context-1]" });
  const contextDirectory = dirname(contextSaved.path);
  assert.deepEqual(readdirSync(contextDirectory).sort(), ["evidence-1.md", "index.md", "minutes.md"]);
  const contextMetadata = readConceptMetadata(contextSaved.markdown, contextSaved.path);
  const contextEvidencePath = join(contextDirectory, "evidence-1.md");
  const contextEvidence = readFileSync(contextEvidencePath, "utf8");
  const contextEvidenceMetadata = readConceptMetadata(contextEvidence, contextEvidencePath);
  assert.equal(contextEvidenceMetadata.type, "Current Context Evidence");
  assert.equal(contextEvidenceMetadata.status, "draft");
  assert.deepEqual(contextEvidenceMetadata.generated, contextMetadata.generated);
  assert.deepEqual(contextEvidenceMetadata.sources, []);
  assert.match(contextEvidence, /not a retrieved historical transcript/);
  assert.ok(contextEvidence.includes(context));
  assert.deepEqual(readDirectoryIndex(root, "meetings/diagrams/okf/diagram-context").entries.map(entry => entry.target), ["minutes.md"]);
  for (const scope of [undefined, "meetings", "meetings/diagrams", "meetings/diagrams/okf", "meetings/diagrams/okf/diagram-context"]) {
    assert.doesNotMatch(JSON.stringify(inspectMemoryKnowledge(scope)), /CURRENT_CONTEXT_BODY/);
  }
  assert.equal(readMemoryKnowledge(contextRecord.id).markdown, contextSaved.markdown);

  function snapshot(directory: string): Array<[string, string]> {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path, "utf8")] as [string, string]];
    });
  }
  const originalFiles = snapshot(root);
  const writers = [
    (id: string, next: MeetingConclusion) => writeContextMinutes({ ...contextRecord, id }, next),
    (id: string, next: MeetingConclusion) => writeTranscriptMinutes({ ...contextRecord, id, evidence: [] }, next),
    (id: string, next: MeetingConclusion) => writeMeetingMinutes({ ...contextRecord, id, evidence: [], answers: [], owner: "main", timeoutMs: 1000 }, next),
  ];
  const invalidConclusions: Array<[MeetingConclusion, RegExp]> = [
    [{ ...conclusion, actions: " " }, /actions must be non-empty/],
    [{ ...conclusion, tags: [""] }, /tags must be a list/],
    [{ ...conclusion, topic_path: "../escape" }, /topic_path/],
    [{ ...conclusion, description: contextRecord.question }, /instead of copying/],
    [{ ...conclusion, findings: "Invalid.[^context-99]" }, /Unknown OKF source citation/],
    [{ ...conclusion, topic_summaries: [{ title: "Changed title", description: "Changed summary" }, conclusion.topic_summaries[1]] }, /conflicts with its existing index/],
  ];
  for (const [index, write] of writers.entries()) {
    for (const [next, pattern] of invalidConclusions) {
      assert.throws(() => write(`invalid-${index}`, next), pattern);
      assert.deepEqual(snapshot(root), originalFiles, "every route validates without partial output or index repair");
    }
    const rename = fs.renameSync;
    const failure = Object.assign(new Error("Injected second index publication failure"), { code: "EACCES" });
    let failures = 0;
    try {
      Object.assign(fs, { renameSync(from: fs.PathLike, to: fs.PathLike) {
        if (String(from).endsWith("update-1")) { failures++; throw failure; }
        return rename(from, to);
      } });
      syncBuiltinESMExports();
      assert.throws(() => write(`rollback-${index}`, conclusion), error => error === failure);
    } finally { Object.assign(fs, { renameSync: rename }); syncBuiltinESMExports(); }
    assert.equal(failures, 1, "a storage failure is not retried");
    assert.deepEqual(snapshot(root), originalFiles, "all three routes roll back published minutes and index updates");
    assert.ok(!existsSync(join(root, "meetings/diagrams/okf", `rollback-${index}`)));
    assert.ok(!readdirSync(configRoot).some(name => name.startsWith(".pi-session-memory-pending-")));
  }
  assert.throws(() => writeContextMinutes(contextRecord, conclusion), /Duplicate meeting_id/);
  assert.deepEqual(snapshot(root), originalFiles);
  assert.match(readFileSync(join(root, "index.md"), "utf8"), /^---\nokf_version: "0\.2"\n---/);
  const log = readFileSync(join(root, "log.md"), "utf8");
  assert.ok(log.includes("diagram-transcript/minutes.md"));
  assert.ok(log.includes("diagram-consultation/minutes.md"));
  assert.ok(log.includes("diagram-context/minutes.md"));
  assert.equal(readDirectoryIndex(root, "meetings/diagrams/okf").entries.length, 3);
  console.log("OKF publication semantics passed: all three evidence routes, shared validation and rollback, source references, nested indexes, logs and unchanged raw reads.");
} finally {
  rmSync(home, { recursive: true, force: true });
}
