import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ConsultationRecord } from "../contracts/consultation.ts";
import type { ContextRecord, EvidenceRecord, MeetingRecord } from "../contracts/knowledge.ts";
import { knowledgePath, listMeetingLocations, readKnowledgeText, requireSummary, validateMeetingId, validateTopicPath, type TopicSummary } from "./knowledge-layout.ts";
import { escapeMarkdown, planKnowledgeIndexes, readDirectoryIndex, renderDirectoryIndex, validateDirectoryEntries, type FileUpdate, type IndexEntry } from "./knowledge-index.ts";
import { publishKnowledge, updateKnowledge } from "./knowledge-publication.ts";
import { readConceptMetadata, renderConcept, type OkfSource, type MEETING_EVIDENCE_TYPES } from "./okf-frontmatter.ts";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export interface MeetingConclusion {
  title: string;
  topic_path: string;
  topic_summaries: TopicSummary[];
  tags: string[];
  description: string;
  findings: string;
  decisions: string;
  unverified_inferences: string;
  disagreements: string;
  open_questions: string;
  actions: string;
}

interface EvidenceDocument {
  id: string;
  title: string;
  type: typeof MEETING_EVIDENCE_TYPES[number];
  body: string;
  evidence: EvidenceRecord["evidence"];
}

/** Save an agent-supplied current-context snapshot without historical retrieval. */
export function writeContextMinutes(record: ContextRecord, conclusion: MeetingConclusion, meetingId?: string) {
  if (typeof record.context !== "string" || !record.context.trim()) throw new Error("context must be non-empty");
  return _writeMeetingMinutes(record, conclusion, () => [{
    id: "context-1", title: "Current context supplied by the main agent", type: "Current Context Evidence",
    body: `# Question\n\n${record.question}\n\n# Current context\n\n${record.context}\n\n# Provenance\n\nThis is an agent-supplied snapshot of the current context, not a retrieved historical transcript. It is not independently verified.`, evidence: [],
  }], meetingId);
}

/** Save transcript evidence once, without synthetic consultation answers. */
export function writeTranscriptMinutes(record: EvidenceRecord, conclusion: MeetingConclusion, meetingId?: string) {
  return _writeMeetingMinutes(record, conclusion, () => [...new Set(record.evidence.map(turn => turn.session_id))].map((sessionId, index) => {
    const evidence = record.evidence.filter(turn => turn.session_id === sessionId);
    return {
      id: `transcript-${index + 1}`, title: `Transcript evidence from ${sessionId}`, type: "Transcript Evidence",
      body: `# Question\n\n${record.question}\n\n# Indexed historical evidence\n\n${_renderEvidence(evidence)}`, evidence,
    };
  }), meetingId);
}

/** Save private consultation answers and their supporting historical evidence. */
export function writeMeetingMinutes(record: ConsultationRecord, conclusion: MeetingConclusion, meetingId?: string) {
  return _writeMeetingMinutes(record, conclusion, () => record.answers.map((answer, index) => {
    const evidence = record.evidence.filter(turn => turn.session_id === answer.sessionId);
    return {
      id: `consultation-${index + 1}`, title: `Consultation answer from ${answer.sessionId}`, type: "Consultation Evidence",
      body: `# Question\n\n${answer.question}\n\n# Answer\n\n${answer.answer}\n\n# Indexed historical evidence\n\n${_renderEvidence(evidence)}`, evidence,
    };
  }), meetingId);
}

/** Validate and publish every evidence route through the same atomic writer. */
function _writeMeetingMinutes(record: MeetingRecord, conclusion: MeetingConclusion, documents: () => EvidenceDocument[], meetingId?: string) {
  record = { ...record, id: meetingId ?? record.id };
  if (typeof record.question !== "string" || !record.question.trim()) throw new Error("question must be non-empty");
  const required: Array<keyof MeetingConclusion> = ["description", "findings", "decisions", "unverified_inferences", "disagreements", "open_questions", "actions"];
  for (const key of required) {
    const value = conclusion?.[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be non-empty; use None when absent`);
  }
  requireSummary(conclusion.title, "title");
  requireSummary(conclusion.description, "description");
  if (!Array.isArray(conclusion.tags) || conclusion.tags.some(tag => typeof tag !== "string" || !tag.trim())) throw new Error("tags must be a list of non-empty strings; use [] when absent");
  const parts = validateTopicPath(conclusion.topic_path, conclusion.topic_summaries);
  validateMeetingId(record.id);
  if (conclusion.description.trim() === record.question.trim()) throw new Error("OKF description must summarize the content instead of copying the review question");
  const root = record.knowledgePath;
  const locations = listMeetingLocations(root);
  if (meetingId === undefined && locations.some(location => location.meeting_id === record.id)) throw new Error(`Duplicate meeting_id: ${record.id}`);
  if (meetingId !== undefined) {
    const location = locations.find(item => item.meeting_id === meetingId);
    if (!location) throw new Error(`Knowledge meeting is missing: ${meetingId}`);
    if (location.relative_path !== ["meetings", ...parts, meetingId, "minutes.md"].join("/")) throw new Error("Updated topic_path must match the existing meeting directory");
  }
  const relativeDirectory = ["meetings", ...parts, record.id].join("/");
  const destination = knowledgePath(root, relativeDirectory);
  if (meetingId === undefined && existsSync(destination)) throw new Error(`Knowledge meeting destination already exists: ${destination}`);
  for (let index = 1; index <= parts.length; index++) {
    if (existsSync(knowledgePath(root, ["meetings", ...parts.slice(0, index), "minutes.md"].join("/")))) throw new Error("topic_path cannot descend into an existing meeting");
  }
  const now = new Date().toISOString();
  const evidence = documents();
  const prepared = meetingId === undefined ? { files: _meetingFiles(record, evidence, conclusion, now), expected: new Map<string, string>() } : _appendMeetingFiles(record, relativeDirectory, evidence, conclusion, now);
  const { files, expected } = prepared;
  const updates = planKnowledgeIndexes(root, parts, conclusion.topic_summaries, record.id, conclusion.title, conclusion.description, now, meetingId !== undefined);
  if (meetingId === undefined) publishKnowledge(root, destination, files, updates);
  else {
    const meetingUpdates: FileUpdate[] = [...files].map(([name, content]) => {
      const path = knowledgePath(root, `${relativeDirectory}/${name}`);
      return { path, previous: expected.get(path), content };
    });
    updateKnowledge(root, [...meetingUpdates, ...updates], expected);
  }
  const relative_path = `${relativeDirectory}/minutes.md`;
  return { meeting_id: record.id, concept_id: relative_path.slice(0, -3), path: knowledgePath(root, relative_path), status: "draft", okf_version: "0.2", markdown: files.get("minutes.md")! };
}

function _renderEvidence(evidence: EvidenceRecord["evidence"]): string {
  return evidence.map(turn => `## ${turn.turn_id}\n\n${turn.user_text}\n\n${turn.reply_text}`).join("\n\n");
}

function _meetingFiles(record: MeetingRecord, documents: EvidenceDocument[], conclusion: MeetingConclusion, now: string, firstEvidenceNumber = 1): Map<string, string> {
  const sources = documents.map((document, index) => ({ id: document.id, resource: `./evidence-${firstEvidenceNumber + index}.md`, title: document.title }));
  _requireConclusionCitations(conclusion, new Set(sources.map(source => source.id)));
  const generated = { by: `pi-session-memory/${version}`, at: now };
  const common = { status: "draft", tags: conclusion.tags.map(tag => tag.trim()), generated };
  const files = new Map<string, string>();
  const entries: IndexEntry[] = [{ target: "minutes.md", title: conclusion.title.trim(), description: conclusion.description.trim() }];
  for (const [index, document] of documents.entries()) {
    const { evidence, title, type, body } = document;
    const description = `${title} supporting ${conclusion.description.trim()}`;
    const metadata = {
      type, title, description, ...common,
      sources: evidence.map(turn => ({ id: turn.turn_id, resource: turn.turn_id, title: `Pi transcript turn ${turn.turn_id}` })),
    };
    const target = sources[index].resource.slice(2);
    files.set(target, renderConcept(metadata, body));
  }
  const metadata = { type: "Meeting Minutes", title: conclusion.title.trim(), description: conclusion.description.trim(), ...common, sources };
  const sections = [
    ["Question", record.question], ["Findings", conclusion.findings], ["Decisions", conclusion.decisions],
    ["Unverified inferences", conclusion.unverified_inferences], ["Disagreements", conclusion.disagreements],
    ["Open questions", conclusion.open_questions], ["Actions", conclusion.actions],
  ];
  const citations = sources.map(source => `[^${source.id}]: [${escapeMarkdown(source.title)}](${source.resource.slice(2)})`).join("\n");
  files.set("minutes.md", renderConcept(metadata, `# ${escapeMarkdown(conclusion.title.trim())}\n\n${sections.map(([heading, body]) => `# ${heading}\n\n${body}`).join("\n\n")}\n\n# Sources\n\n${sources.map(source => `- ${source.title}.[^${source.id}]`).join("\n")}\n\n${citations}`));
  files.set("index.md", renderDirectoryIndex({ title: conclusion.title.trim(), entries }));
  return files;
}

const CITATION = /\[\^([^\]\n]+)\]|\[((?:transcript|consultation|context)-\d+)\]/g;
const CONCLUSION_SECTIONS = ["findings", "decisions", "unverified_inferences", "disagreements", "open_questions", "actions"] as const;

function _requireCitations(text: string, ids: Set<string>): void {
  for (const match of text.matchAll(CITATION)) {
    const id = match[1] ?? match[2];
    if (!ids.has(id)) throw new Error(`Unknown OKF source citation: ${id}`);
  }
}
function _requireConclusionCitations(conclusion: MeetingConclusion, ids: Set<string>): void {
  for (const key of CONCLUSION_SECTIONS) _requireCitations(conclusion[key], ids);
}
function _conceptBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("Missing OKF frontmatter in meeting update");
  return markdown.slice(match[0].length);
}

/** Append one review while preserving prior text, evidence and producer-defined metadata. */
function _appendMeetingFiles(record: MeetingRecord, directory: string, documents: EvidenceDocument[], conclusion: MeetingConclusion, now: string) {
  const root = record.knowledgePath;
  const expected = new Map<string, string>();
  const children = readdirSync(knowledgePath(root, directory), { withFileTypes: true });
  for (const child of children.filter(entry => entry.isFile() && entry.name.endsWith(".md"))) {
    const path = knowledgePath(root, `${directory}/${child.name}`);
    expected.set(path, readKnowledgeText(path));
  }
  const minutesPath = knowledgePath(root, `${directory}/minutes.md`);
  const previous = expected.get(minutesPath)!;
  const metadata = readConceptMetadata(previous, minutesPath);
  if (metadata.type !== "Meeting Minutes") throw new Error(`Updated concept must be Meeting Minutes: ${minutesPath}`);
  requireSummary(metadata.title, "existing meeting title");
  requireSummary(metadata.description, "existing meeting description");
  const index = readDirectoryIndex(root, directory);
  validateDirectoryEntries(root, directory, index);
  const entry = index.entries.find(item => item.target === "minutes.md");
  if (!entry || index.title !== metadata.title || entry.title !== metadata.title || entry.description !== metadata.description) throw new Error(`Existing meeting metadata conflicts with its index: ${minutesPath}`);
  const sources = metadata.sources === undefined ? [] : metadata.sources as OkfSource[];
  const sourceIds = new Set<string>();
  const lastIds = new Map<string, number>();
  for (const source of sources) {
    if (typeof source.id !== "string" || !source.id.trim()) throw new Error(`Existing meeting source requires an ID: ${minutesPath}`);
    if (sourceIds.has(source.id)) throw new Error(`Duplicate meeting evidence source ID: ${minutesPath}: ${source.id}`);
    sourceIds.add(source.id);
    const match = /^(transcript|consultation|context)-(\d+)$/.exec(source.id);
    if (match) {
      const number = Number(match[2]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid existing source number: ${source.id}`);
      lastIds.set(match[1], Math.max(lastIds.get(match[1]) ?? 0, number));
    }
  }
  const previousBody = _conceptBody(previous);
  _requireCitations(previousBody, sourceIds);
  _requireConclusionCitations(conclusion, new Set(documents.map(document => document.id)));
  const mapping = new Map<string, string>();
  const appended = documents.map(document => {
    const prefix = document.id.split("-")[0];
    const next = (lastIds.get(prefix) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error(`Source number exceeds safe integer range: ${prefix}`);
    lastIds.set(prefix, next);
    const id = `${prefix}-${next}`;
    mapping.set(document.id, id);
    return { ...document, id };
  });
  const translated = { ...conclusion };
  for (const key of CONCLUSION_SECTIONS) translated[key] = conclusion[key].replace(CITATION, (text, footnote: string | undefined, plain: string | undefined) => text.replace(footnote ?? plain!, mapping.get(footnote ?? plain!)!));
  let lastFile = 0;
  for (const child of children) {
    const match = /^evidence-(\d+)\.md$/.exec(child.name);
    if (match) {
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number)) throw new Error(`Invalid existing evidence number: ${child.name}`);
      lastFile = Math.max(lastFile, number);
    }
  }
  if (!Number.isSafeInteger(lastFile + appended.length)) throw new Error("Evidence number exceeds safe integer range");
  const files = _meetingFiles(record, appended, translated, now, lastFile + 1);
  const current = files.get("minutes.md")!;
  const currentMetadata = readConceptMetadata(current, "meeting update");
  const combined = {
    ...metadata, ...currentMetadata,
    tags: [...new Set([...(metadata.tags === undefined ? [] : metadata.tags as string[]), ...conclusion.tags.map(tag => tag.trim())])],
    sources: [...sources, ...currentMetadata.sources as OkfSource[]],
    generated: { ...(metadata.generated === undefined ? {} : metadata.generated as Record<string, unknown>), ...currentMetadata.generated as Record<string, unknown> },
  };
  const header = renderConcept(combined, "").replace(/\n*$/, "\n");
  files.set("minutes.md", `${header}${previousBody}\n\n# Review update: ${now}\n\n${_conceptBody(current)}`);
  index.title = conclusion.title.trim();
  entry.title = conclusion.title.trim();
  entry.description = conclusion.description.trim();
  files.set("index.md", renderDirectoryIndex(index));
  return { files, expected };
}
