import { mkdirSync, writeFileSync, existsSync, appendFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConsultationRecord } from "./consultation-runtime.ts";

export interface MeetingConclusion {
  description: string;
  findings: string;
  decisions: string;
  unverified_inferences: string;
  disagreements: string;
  open_questions: string;
  actions: string;
}

/** Save draft OKF v0.2 minutes and portable evidence. Do not claim verification. */
export function writeMeetingMinutes(record: ConsultationRecord, conclusion: MeetingConclusion) {
  const required: Array<keyof MeetingConclusion> = ["description", "findings", "decisions", "unverified_inferences", "disagreements", "open_questions", "actions"];
  for (const key of required) {
    const value = conclusion?.[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be non-empty; use None when absent`);
  }
  if (conclusion.description.trim() === record.question.trim()) throw new Error("OKF description must summarize the content instead of copying the review question");
  const now = new Date().toISOString();
  const root = record.knowledgePath;
  const destination = join(root, "meetings", record.id);
  const directory = join(root, "meetings", `.${record.id}.pending`);
  mkdirSync(join(root, "meetings"), { recursive: true });
  mkdirSync(directory);
  try {
    _writeMeetingFiles(directory, record, conclusion);
    renameSync(directory, destination);
  } catch (error) {
    rmSync(directory, { recursive: true });
    throw error;
  }
  const index = join(root, "index.md");
  if (!existsSync(index)) writeFileSync(index, "# Session memory knowledge\n", { flag: "wx" });
  appendFileSync(index, `\n- [${record.id}](meetings/${record.id}/minutes.md)\n`);
  const log = join(root, "log.md");
  const previous = existsSync(log) ? readFileSync(log, "utf8") : "# Knowledge update log\n";
  const heading = "# Knowledge update log\n";
  if (!previous.startsWith(heading)) throw new Error("Knowledge log has an unexpected heading");
  writeFileSync(log, `${heading}\n## ${now.slice(0, 10)}\n\n- ${now}: Added draft meeting [${record.id}](/meetings/${record.id}/minutes.md).\n${previous.slice(heading.length)}`);
  return { meeting_id: record.id, path: join(destination, "minutes.md"), status: "draft", okf_version: "0.2", markdown: readFileSync(join(destination, "minutes.md"), "utf8") };
}

function _writeMeetingFiles(directory: string, record: ConsultationRecord, conclusion: MeetingConclusion) {
  const route = record.kind === "transcript" ? "transcript" : "consultation";
  const sources = record.answers.map((answer, index) => ({ id: `${route}-${index + 1}`, resource: `/meetings/${record.id}/evidence-${index + 1}.md`, title: `${route === "transcript" ? "Transcript evidence" : "Consultation answer"} from ${answer.sessionId}` }));
  for (const [index, answer] of record.answers.entries()) {
    const evidence = record.evidence.filter(turn => turn.session_id === answer.sessionId);
    const metadata = { description: `${sources[index].title} supporting ${conclusion.description.trim()}` };
    const body = `# Question\n\n${answer.question}\n\n# Answer\n\n${answer.answer}\n\n# Indexed historical evidence\n\n${evidence.map(turn => `## ${turn.turn_id}\n\n${turn.user_text}\n\n${turn.reply_text}`).join("\n\n")}`;
    writeFileSync(join(directory, `evidence-${index + 1}.md`), `${_frontmatter(metadata)}\n${body}\n`, { flag: "wx" });
  }
  const metadata = { description: conclusion.description.trim() };
  const sections = [
    ["Question", record.question], ["Findings", conclusion.findings], ["Decisions", conclusion.decisions],
    ["Unverified inferences", conclusion.unverified_inferences], ["Disagreements", conclusion.disagreements],
    ["Open questions", conclusion.open_questions], ["Actions", conclusion.actions],
  ];
  const citations = sources.map((source, index) => `[^${source.id}]: [${source.title}](evidence-${index + 1}.md)`).join("\n");
  const path = join(directory, "minutes.md");
  writeFileSync(path, `${_frontmatter(metadata)}\n${sections.map(([heading, body]) => `# ${heading}\n\n${body}`).join("\n\n")}\n\n# Sources\n\n${sources.map(s => `- ${s.title}.[^${s.id}]`).join("\n")}\n\n${citations}\n`, { flag: "wx" });
}

function _frontmatter(value: Record<string, unknown>): string {
  return `---\n${Object.entries(value).map(([key, item]) => `${key}: ${JSON.stringify(item)}`).join("\n")}\n---\n`;
}
