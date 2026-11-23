import { existsSync, readFileSync } from "node:fs";
import type { ConsultationRecord } from "../contracts/consultation.ts";
import type { ContextRecord, EvidenceRecord, MeetingRecord } from "../contracts/knowledge.ts";
import { knowledgePath, listMeetingLocations, requireSummary, validateMeetingId, validateTopicPath, type TopicSummary } from "./knowledge-layout.ts";
import { escapeMarkdown, planKnowledgeIndexes, renderDirectoryIndex, type IndexEntry } from "./knowledge-index.ts";
import { publishKnowledge } from "./knowledge-publication.ts";
import { renderConcept, type MEETING_EVIDENCE_TYPES } from "./okf-frontmatter.ts";

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
export function writeContextMinutes(record: ContextRecord, conclusion: MeetingConclusion) {
  if (typeof record.context !== "string" || !record.context.trim()) throw new Error("context must be non-empty");
  return _writeMeetingMinutes(record, conclusion, () => [{
    id: "context-1", title: "Current context supplied by the main agent", type: "Current Context Evidence",
    body: `# Question\n\n${record.question}\n\n# Current context\n\n${record.context}\n\n# Provenance\n\nThis is an agent-supplied snapshot of the current context, not a retrieved historical transcript. It is not independently verified.`, evidence: [],
  }]);
}

/** Save transcript evidence once, without synthetic consultation answers. */
export function writeTranscriptMinutes(record: EvidenceRecord, conclusion: MeetingConclusion) {
  return _writeMeetingMinutes(record, conclusion, () => [...new Set(record.evidence.map(turn => turn.session_id))].map((sessionId, index) => {
    const evidence = record.evidence.filter(turn => turn.session_id === sessionId);
    return {
      id: `transcript-${index + 1}`, title: `Transcript evidence from ${sessionId}`, type: "Transcript Evidence",
      body: `# Question\n\n${record.question}\n\n# Indexed historical evidence\n\n${_renderEvidence(evidence)}`, evidence,
    };
  }));
}

/** Save private consultation answers and their supporting historical evidence. */
export function writeMeetingMinutes(record: ConsultationRecord, conclusion: MeetingConclusion) {
  return _writeMeetingMinutes(record, conclusion, () => record.answers.map((answer, index) => {
    const evidence = record.evidence.filter(turn => turn.session_id === answer.sessionId);
    return {
      id: `consultation-${index + 1}`, title: `Consultation answer from ${answer.sessionId}`, type: "Consultation Evidence",
      body: `# Question\n\n${answer.question}\n\n# Answer\n\n${answer.answer}\n\n# Indexed historical evidence\n\n${_renderEvidence(evidence)}`, evidence,
    };
  }));
}

/** Validate and publish every evidence route through the same atomic writer. */
function _writeMeetingMinutes(record: MeetingRecord, conclusion: MeetingConclusion, documents: () => EvidenceDocument[]) {
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
  if (listMeetingLocations(root).some(location => location.meeting_id === record.id)) throw new Error(`Duplicate meeting_id: ${record.id}`);
  const relativeDirectory = ["meetings", ...parts, record.id].join("/");
  const destination = knowledgePath(root, relativeDirectory);
  if (existsSync(destination)) throw new Error(`Knowledge meeting destination already exists: ${destination}`);
  for (let index = 1; index <= parts.length; index++) {
    if (existsSync(knowledgePath(root, ["meetings", ...parts.slice(0, index), "minutes.md"].join("/")))) throw new Error("topic_path cannot descend into an existing meeting");
  }
  const now = new Date().toISOString();
  const files = _meetingFiles(record, documents(), conclusion, now);
  const updates = planKnowledgeIndexes(root, parts, conclusion.topic_summaries, record.id, conclusion.title, conclusion.description, now);
  publishKnowledge(root, destination, files, updates);
  const relative_path = `${relativeDirectory}/minutes.md`;
  return { meeting_id: record.id, concept_id: relative_path.slice(0, -3), path: knowledgePath(root, relative_path), status: "draft", okf_version: "0.2", markdown: files.get("minutes.md")! };
}

function _renderEvidence(evidence: EvidenceRecord["evidence"]): string {
  return evidence.map(turn => `## ${turn.turn_id}\n\n${turn.user_text}\n\n${turn.reply_text}`).join("\n\n");
}

function _meetingFiles(record: MeetingRecord, documents: EvidenceDocument[], conclusion: MeetingConclusion, now: string): Map<string, string> {
  const sources = documents.map((document, index) => ({ id: document.id, resource: `./evidence-${index + 1}.md`, title: document.title }));
  const sourceIds = new Set(sources.map(source => source.id));
  for (const key of ["findings", "decisions", "unverified_inferences", "disagreements", "open_questions", "actions"] as const) {
    for (const match of conclusion[key].matchAll(/\[\^([^\]\n]+)\]/g)) if (!sourceIds.has(match[1])) throw new Error(`Unknown OKF source citation: ${match[1]}`);
  }
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
    const target = `evidence-${index + 1}.md`;
    files.set(target, renderConcept(metadata, body));
  }
  const metadata = { type: "Meeting Minutes", title: conclusion.title.trim(), description: conclusion.description.trim(), ...common, sources };
  const sections = [
    ["Question", record.question], ["Findings", conclusion.findings], ["Decisions", conclusion.decisions],
    ["Unverified inferences", conclusion.unverified_inferences], ["Disagreements", conclusion.disagreements],
    ["Open questions", conclusion.open_questions], ["Actions", conclusion.actions],
  ];
  const citations = sources.map((source, index) => `[^${source.id}]: [${escapeMarkdown(source.title)}](evidence-${index + 1}.md)`).join("\n");
  files.set("minutes.md", renderConcept(metadata, `# ${escapeMarkdown(conclusion.title.trim())}\n\n${sections.map(([heading, body]) => `# ${heading}\n\n${body}`).join("\n\n")}\n\n# Sources\n\n${sources.map(source => `- ${source.title}.[^${source.id}]`).join("\n")}\n\n${citations}`));
  files.set("index.md", renderDirectoryIndex({ title: conclusion.title.trim(), entries }));
  return files;
}
