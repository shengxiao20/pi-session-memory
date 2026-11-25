import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDirectoryIndex, renderDirectoryIndex } from "../src/knowledge/knowledge-index.ts";
import { readConceptMetadata, renderConcept } from "../src/knowledge/okf-frontmatter.ts";
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
  const updateRecord: ConsultationRecord & { context: string } = {
    ...contextRecord, id: "unused-new-meeting", question: "Append how and why questions", context: "NEW_CONTEXT_SNAPSHOT",
    owner: "main", timeoutMs: 1000,
    evidence: [{ turn_id: "pi:new:user-1", session_id: "pi:new", turn_index: 0, ts: 1,
      user_text: "How does this work?", reply_text: "NEW_HISTORICAL_REPLY", source: "pi", cwd: home, score: 10 }],
    answers: [{ sessionId: "pi:new", question: "Why?", answer: "NEW_PRIVATE_ANSWER", messageIds: ["answer-new"] }],
  };
  const updateWriters = [
    { prefix: "transcript", write: (next: MeetingConclusion, id: string) => writeTranscriptMinutes(updateRecord, next, id) },
    { prefix: "consultation", write: (next: MeetingConclusion, id: string) => writeMeetingMinutes(updateRecord, next, id) },
    { prefix: "context", write: (next: MeetingConclusion, id: string) => writeContextMinutes(updateRecord, next, id) },
  ];
  for (const { prefix, write } of updateWriters) {
    const id = `diagram-${prefix}`;
    const directory = join(root, "meetings/diagrams/okf", id);
    const path = join(directory, "minutes.md");
    const initial = readFileSync(path, "utf8");
    const initialBody = initial.replace(/^---\n[\s\S]*?\n---\n/, "");
    const initialMetadata = readConceptMetadata(initial, path);
    const originalSources = (initialMetadata.sources as Array<{ id: string; resource: string }>).map(source => ({ ...source, author: "Original author" }));
    const previousMetadata = { ...initialMetadata, resource: "https://example.test/reference", custom: { keep: [1, 2] }, sources: originalSources,
      generated: { ...initialMetadata.generated as object, review_code: "keep-original" } };
    writeFileSync(path, renderConcept(previousMetadata, initialBody));
    const prior = readFileSync(path, "utf8");
    const priorBody = prior.replace(/^---\n[\s\S]*?\n---\n/, "");
    const evidenceBefore = new Map(originalSources.map(source => [source.resource, readFileSync(join(directory, source.resource))]));
    const note = "Supplementary note remains byte-identical.\n";
    writeFileSync(join(directory, "notes.md"), note);
    const meetingIndex = readDirectoryIndex(root, `meetings/diagrams/okf/${id}`);
    meetingIndex.entries.push({ target: "notes.md", title: "Notes", description: "Manual supplementary content" });
    writeFileSync(join(directory, "index.md"), renderDirectoryIndex(meetingIndex));
    const next = { ...conclusion, title: `Updated ${prefix} review`, description: `Definition and procedural question samples for ${prefix}`,
      tags: ["question-search", "diagram"], findings: `NEW_FINDING[${prefix}-1][^${prefix}-1]` };
    const result = write(next, id);
    assert.equal(result.meeting_id, id);
    assert.equal(result.path, path);
    assert.equal(result.markdown, readFileSync(path, "utf8"));
    assert.equal(result.concept_id, `meetings/diagrams/okf/${id}/minutes`);
    assert.ok(result.markdown.includes(priorBody), "the entire previous body remains contiguous and unchanged");
    const metadata = readConceptMetadata(result.markdown, path);
    const sources = metadata.sources as Array<{ id: string; resource: string }>;
    assert.deepEqual(sources.slice(0, originalSources.length), originalSources, "old source metadata survives");
    assert.deepEqual(metadata.custom, previousMetadata.custom);
    assert.equal(metadata.resource, previousMetadata.resource);
    assert.equal((metadata.generated as any).review_code, "keep-original");
    assert.deepEqual(metadata.tags, ["diagram", "question-search"]);
    const nextNumber = originalSources.length + 1;
    assert.equal(sources.at(-1)!.id, `${prefix}-${nextNumber}`);
    assert.equal(sources.at(-1)!.resource, `./evidence-${nextNumber}.md`);
    assert.ok(result.markdown.includes(`NEW_FINDING[${prefix}-${nextNumber}][^${prefix}-${nextNumber}]`));
    const newEvidence = readFileSync(join(directory, sources.at(-1)!.resource), "utf8");
    assert.equal(readConceptMetadata(newEvidence, "new evidence").type, prefix === "context" ? "Current Context Evidence" : prefix === "transcript" ? "Transcript Evidence" : "Consultation Evidence");
    assert.ok(newEvidence.includes(prefix === "context" ? updateRecord.context : prefix === "consultation" ? "NEW_PRIVATE_ANSWER" : "How does this work?"));
    for (const [resource, content] of evidenceBefore) assert.deepEqual(readFileSync(join(directory, resource)), content);
    assert.equal(readFileSync(join(directory, "notes.md"), "utf8"), note);
    assert.equal(readDirectoryIndex(root, `meetings/diagrams/okf/${id}`).entries.length, 2);
    const catalogue = inspectMemoryKnowledge("meetings/diagrams/okf");
    const meeting = catalogue.meetings.find(item => item.meeting_id === id)!;
    assert.equal(meeting.index_matches_metadata, true);
    assert.equal(meeting.frontmatter.title, next.title);
    assert.equal(catalogue.meetings.length, 3, "updating preserves one meeting identity");
    assert.ok(readFileSync(join(root, "log.md"), "utf8").includes(`Updated draft meeting [${next.title}]`));
    assert.equal(readMemoryKnowledge(id).markdown, result.markdown);
    assert.ok(!existsSync(join(root, "meetings/diagrams/okf", updateRecord.id)));
  }
  const stable = snapshot(root);
  for (const { prefix, write } of updateWriters) {
    const id = `diagram-${prefix}`;
    for (const [invalid, pattern] of [
      [{ ...conclusion, findings: `[${prefix}-99]` }, /Unknown OKF source citation/],
      [{ ...conclusion, findings: `[${prefix}-${prefix === "context" ? 3 : 4}]` }, /Unknown OKF source citation/],
      [{ ...conclusion, topic_path: "other/okf" }, /must match the existing meeting/],
      [{ ...conclusion, topic_summaries: [{ title: "Other", description: "Changed" }, conclusion.topic_summaries[1]] }, /summary conflicts|title conflicts/],
      [{ ...conclusion, actions: " " }, /actions must be non-empty/],
    ] as Array<[MeetingConclusion, RegExp]>) {
      assert.throws(() => write(invalid, id), pattern);
      assert.deepEqual(snapshot(root), stable);
    }
    for (const badId of ["", ".hidden", "../escape", "/absolute", "missing"]) {
      assert.throws(() => write(conclusion, badId), /meeting_id must|meeting is missing/);
      assert.deepEqual(snapshot(root), stable);
    }
    for (let failedRename = 0; failedRename < 8; failedRename++) {
      const rename = fs.renameSync;
      const failure = new Error(`Injected update rename ${failedRename}`);
      let failures = 0;
      try {
        Object.assign(fs, { renameSync(from: fs.PathLike, to: fs.PathLike) {
          if (String(from).endsWith(`update-${failedRename}`)) { failures++; throw failure; }
          return rename(from, to);
        } });
        syncBuiltinESMExports();
        assert.throws(() => write({ ...conclusion, findings: `Append.[^${prefix}-1]` }, id), error => error === failure);
      } finally { Object.assign(fs, { renameSync: rename }); syncBuiltinESMExports(); }
      assert.equal(failures, 1);
      assert.deepEqual(snapshot(root), stable, "each publication boundary restores minutes, evidence, notes, indexes and log");
      assert.ok(!readdirSync(configRoot).some(name => name.startsWith(".pi-session-memory-pending-")));
    }
  }
  // Source prefixes remain independent when successive reviews use different evidence routes.
  const mixed = writeContextMinutes(updateRecord, { ...conclusion, findings: "Snapshot.[context-1]" }, "diagram-transcript");
  const mixedAgain = writeTranscriptMinutes(updateRecord, { ...conclusion, findings: "Another review.[transcript-1]" }, "diagram-transcript");
  assert.ok(mixedAgain.markdown.includes(mixed.markdown.replace(/^---\n[\s\S]*?\n---\n/, "")));
  const mixedSources = readConceptMetadata(mixedAgain.markdown, mixedAgain.path).sources as Array<{ id: string; resource: string }>;
  assert.deepEqual(mixedSources.map(source => source.id), ["transcript-1", "transcript-2", "transcript-3", "context-1", "transcript-4"]);
  assert.deepEqual(mixedSources.map(source => source.resource), Array.from({ length: 5 }, (_, index) => `./evidence-${index + 1}.md`));
  // A source changed by another writer remains untouched when optimistic validation rejects the update.
  const evidencePath = join(dirname(mixedAgain.path), "evidence-1.md");
  const originalEvidence = readFileSync(evidencePath, "utf8");
  const write = fs.writeFileSync;
  const beforeConflict = snapshot(root);
  let injected = false;
  try {
    Object.assign(fs, { writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      write(...args);
      if (!injected && String(args[0]).endsWith("update-0")) { injected = true; write(evidencePath, `${originalEvidence}\nExternal edit\n`); }
    } });
    syncBuiltinESMExports();
    assert.throws(() => writeTranscriptMinutes(updateRecord, { ...conclusion, findings: "New.[transcript-1]" }, "diagram-transcript"), /changed during update/);
    assert.equal(readFileSync(evidencePath, "utf8"), `${originalEvidence}\nExternal edit\n`);
  } finally { Object.assign(fs, { writeFileSync: write }); syncBuiltinESMExports(); writeFileSync(evidencePath, originalEvidence); }
  assert.deepEqual(snapshot(root), beforeConflict);
  assert.ok(!readdirSync(configRoot).some(name => name.startsWith(".pi-session-memory-pending-")));
  const minutesBeforeInvalid = readFileSync(mixedAgain.path, "utf8");
  const bodyBeforeInvalid = minutesBeforeInvalid.replace(/^---\n[\s\S]*?\n---\n/, "");
  const metadataBeforeInvalid = readConceptMetadata(minutesBeforeInvalid, mixedAgain.path);
  const sourcesBeforeInvalid = metadataBeforeInvalid.sources as Array<{ id: string; resource: string }>;
  const invalidExisting: Array<[string, RegExp]> = [
    [renderConcept({ ...metadataBeforeInvalid, type: "Reference" }, bodyBeforeInvalid), /must be Meeting Minutes/],
    [renderConcept({ ...metadataBeforeInvalid, title: "Conflicting title" }, bodyBeforeInvalid), /metadata conflicts/],
    [renderConcept({ ...metadataBeforeInvalid, sources: sourcesBeforeInvalid.map((source, index) => index === 0 ? { resource: source.resource } : source) }, bodyBeforeInvalid), /requires an ID/],
    [renderConcept({ ...metadataBeforeInvalid, sources: sourcesBeforeInvalid.map((source, index) => index === 1 ? { ...source, id: sourcesBeforeInvalid[0].id } : source) }, bodyBeforeInvalid), /Duplicate.*source ID/],
    [renderConcept({ ...metadataBeforeInvalid, sources: sourcesBeforeInvalid.map((source, index) => index === 0 ? { ...source, resource: "./../escape.md" } : source) }, bodyBeforeInvalid), /immediate Markdown children/],
    [renderConcept({ ...metadataBeforeInvalid, sources: sourcesBeforeInvalid.map((source, index) => index === 0 ? { ...source, id: "transcript-9007199254740992" } : source) }, bodyBeforeInvalid), /Invalid existing source number/],
    [renderConcept(metadataBeforeInvalid, `${bodyBeforeInvalid}\nUnsupported.[^missing-source]`), /Unknown OKF source citation/],
    ["---\ntype: [broken\n---\n", /Invalid OKF frontmatter/],
  ];
  for (const [markdown, pattern] of invalidExisting) {
    writeFileSync(mixedAgain.path, markdown);
    const invalidSnapshot = snapshot(root);
    assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), pattern);
    assert.deepEqual(snapshot(root), invalidSnapshot, "invalid prior metadata remains unchanged and raises an error");
    writeFileSync(mixedAgain.path, minutesBeforeInvalid);
  }
  writeFileSync(evidencePath, renderConcept({ type: "Reference" }, "Wrong evidence type"));
  assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), /wrong concept type/);
  writeFileSync(evidencePath, originalEvidence);
  rmSync(evidencePath);
  assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), /source is missing/);
  writeFileSync(evidencePath, originalEvidence);
  writeFileSync(evidencePath, Buffer.from([0xc3, 0x28]));
  assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), /encoded data was not valid/);
  assert.deepEqual(readFileSync(evidencePath), Buffer.from([0xc3, 0x28]));
  writeFileSync(evidencePath, originalEvidence);
  const parentIndexPath = join(root, "meetings/diagrams/okf/index.md");
  const parentIndex = readFileSync(parentIndexPath, "utf8");
  rmSync(parentIndexPath);
  assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), /directory index is missing/);
  assert.ok(!existsSync(parentIndexPath));
  writeFileSync(parentIndexPath, parentIndex);
  const logPath = join(root, "log.md");
  const originalLog = readFileSync(logPath);
  const corruptLog = Buffer.concat([originalLog, Buffer.from("\n- Invalid UTF-8: "), Buffer.from([0xc3, 0x28]), Buffer.from("\n")]);
  writeFileSync(logPath, corruptLog);
  const corruptLogSnapshot = snapshot(root);
  assert.throws(() => writeTranscriptMinutes(updateRecord, conclusion, "diagram-transcript"), /encoded data was not valid/);
  assert.deepEqual(snapshot(root), corruptLogSnapshot);
  assert.deepEqual(readFileSync(logPath), corruptLog);
  writeFileSync(logPath, originalLog);
  assert.deepEqual(snapshot(root), beforeConflict);
  // Cleanup failure also restores committed files, without retrying the failed cleanup.
  const remove = fs.rmSync;
  const cleanupFailure = new Error("Injected staging cleanup failure");
  let cleanupAttempts = 0;
  let pending = "";
  try {
    Object.assign(fs, { rmSync(path: fs.PathLike, options?: Parameters<typeof fs.rmSync>[1]) {
      if (String(path).includes(".pi-session-memory-pending-")) { cleanupAttempts++; pending = String(path); throw cleanupFailure; }
      return remove(path, options);
    } });
    syncBuiltinESMExports();
    assert.throws(() => writeTranscriptMinutes(updateRecord, { ...conclusion, findings: "New.[transcript-1]" }, "diagram-transcript"), error => error === cleanupFailure);
    assert.equal(cleanupAttempts, 1);
    assert.deepEqual(snapshot(root), beforeConflict);
  } finally { Object.assign(fs, { rmSync: remove }); syncBuiltinESMExports(); if (pending) remove(pending, { recursive: true }); }
  // Existing supplementary filenames reserve their numbers, while retaining their indexed content.
  const meetingDirectory = dirname(mixedAgain.path);
  const sparseNote = join(meetingDirectory, "evidence-20.md");
  writeFileSync(sparseNote, "RESERVED_SUPPLEMENTARY_CONTENT\n");
  const sparseIndex = readDirectoryIndex(root, "meetings/diagrams/okf/diagram-transcript");
  sparseIndex.entries.push({ target: "evidence-20.md", title: "Reserved note", description: "User content at a sparse evidence filename" });
  writeFileSync(join(meetingDirectory, "index.md"), renderDirectoryIndex(sparseIndex));
  const sparse = writeTranscriptMinutes(updateRecord, { ...conclusion, findings: "Sparse.[transcript-1]" }, "diagram-transcript");
  const sparseSources = readConceptMetadata(sparse.markdown, sparse.path).sources as Array<{ id: string; resource: string }>;
  assert.deepEqual(sparseSources.at(-1), { id: "transcript-5", resource: "./evidence-21.md", title: "Transcript evidence from pi:new" });
  assert.ok(sparse.markdown.includes("(evidence-21.md)"));
  assert.equal(readFileSync(sparseNote, "utf8"), "RESERVED_SUPPLEMENTARY_CONTENT\n");
  const zero = writeTranscriptMinutes({ ...updateRecord, evidence: [] }, { ...conclusion, findings: "No new matching turns." }, "diagram-transcript");
  assert.deepEqual(readConceptMetadata(zero.markdown, zero.path).sources, sparseSources);
  assert.ok(zero.markdown.includes(sparse.markdown.replace(/^---\n[\s\S]*?\n---\n/, "")));
  assert.equal(inspectMemoryKnowledge("meetings/diagrams/okf").meetings.length, 3);
  console.log("OKF publication semantics passed: three creation and append routes, stable identities, retained text and evidence, independent source numbering, strict citations, indexes, logs, conflicts and complete rollback.");
} finally {
  rmSync(home, { recursive: true, force: true });
}
