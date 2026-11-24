import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const LOCOMO_SOURCE = Object.freeze({
  repository: "https://github.com/snap-research/locomo",
  commit: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
  path: "data/locomo10.json",
  blob: "d95b872480b413d935821fdc3c84f8a8f5f29e73",
  sha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
});

export interface Dialogue { speaker: string; dia_id: string; text: string; blip_caption?: string; }
export interface Question { question: string; answer?: string | number; evidence: string[]; category: number; }
export interface Sample { sample_id: string; conversation: Record<string, unknown>; qa: Question[]; }
export interface HistoryTurn { sessionId: string; turnId: string; dialogueId: string; turnIndex: number; timestamp: number; text: string; }

export function sha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }

/** Verify the published bytes before parsing the benchmark. */
export function readDataset(path: string): Sample[] {
  const bytes = readFileSync(path);
  assert.equal(sha256(bytes), LOCOMO_SOURCE.sha256, "LoCoMo checksum mismatch");
  return parseDataset(JSON.parse(bytes.toString("utf8")));
}

export function parseDataset(value: unknown): Sample[] {
  assert(Array.isArray(value) && value.length > 0, "Dataset must contain samples");
  const ids = new Set<string>();
  for (const sample of value) {
    assert(sample && typeof sample === "object");
    assert(typeof sample.sample_id === "string" && /^[A-Za-z0-9_-]+$/.test(sample.sample_id), "Invalid sample_id");
    assert(!ids.has(sample.sample_id), "Duplicate sample_id");
    ids.add(sample.sample_id);
    assert(sample.conversation && typeof sample.conversation === "object" && !Array.isArray(sample.conversation));
    assert(Array.isArray(sample.qa) && sample.qa.length > 0);
    for (const qa of sample.qa) {
      assert(typeof qa.question === "string" && qa.question.trim());
      assert(Number.isInteger(qa.category) && qa.category >= 1 && qa.category <= 5);
      assert(Array.isArray(qa.evidence) && qa.evidence.every((id: unknown) => typeof id === "string"));
      if (qa.category !== 5) assert(typeof qa.answer === "string" || typeof qa.answer === "number", "Missing gold answer");
    }
    historyTurns(sample);
  }
  return value as Sample[];
}

/** Use the same ordered question selection in retrieval and full-context evaluations. */
export function selectQuestions(sample: Sample, categories: number[], limit: number | null) {
  const eligible = sample.qa.map((qa, questionIndex) => ({ qa, questionIndex })).filter(({ qa }) => categories.includes(qa.category));
  const selected = limit === null ? eligible : eligible.slice(0, limit);
  assert(selected.length > 0, "No questions match the configured categories");
  return selected;
}

/** Map each utterance to one synthetic Pi turn; exclude all annotations and summaries. */
export function historyTurns(sample: Sample): HistoryTurn[] {
  const keys = Object.keys(sample.conversation).filter(key => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  assert(keys.length > 0, "Conversation has no sessions");
  const ids = new Set<string>();
  return keys.flatMap(key => {
    const date = sample.conversation[`${key}_date_time`];
    assert(typeof date === "string", `Missing date: ${key}`);
    const timestamp = _timestamp(date);
    const dialogues = sample.conversation[key];
    assert(Array.isArray(dialogues) && dialogues.length > 0, `Empty session: ${key}`);
    return dialogues.map((dialogue: Dialogue, turnIndex: number) => {
      assert(typeof dialogue.speaker === "string" && dialogue.speaker.trim());
      assert(typeof dialogue.text === "string" && dialogue.text.trim());
      assert(typeof dialogue.dia_id === "string" && /^D\d+:\d+$/.test(dialogue.dia_id), "Invalid dialogue id");
      assert(!ids.has(dialogue.dia_id), "Duplicate dialogue id");
      ids.add(dialogue.dia_id);
      assert(dialogue.blip_caption === undefined || typeof dialogue.blip_caption === "string");
      const caption = dialogue.blip_caption === undefined ? "" : `\nImage caption: ${dialogue.blip_caption}`;
      return { sessionId: `${sample.sample_id}:${key}`, turnId: `${sample.sample_id}:${dialogue.dia_id}`,
        dialogueId: dialogue.dia_id, turnIndex, timestamp: timestamp + turnIndex,
        text: `Date: ${date}\n[${dialogue.dia_id}] ${dialogue.speaker}: ${dialogue.text}${caption}` };
    });
  });
}

/** LoCoMo supplies local clock times without a timezone; UTC preserves their relative order. */
function _timestamp(date: string): number {
  const match = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/.exec(date);
  assert(match, `Invalid LoCoMo date: ${date}`);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = months.indexOf(match[5]);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const day = Number(match[4]);
  const year = Number(match[6]);
  assert(month >= 0 && hour >= 1 && hour <= 12 && minute < 60 && day >= 1 && day <= 31);
  const timestamp = Date.UTC(year, month, day, hour % 12 + (match[3] === "pm" ? 12 : 0), minute);
  const parsed = new Date(timestamp);
  assert(parsed.getUTCMonth() === month && parsed.getUTCDate() === day, `Invalid LoCoMo date: ${date}`);
  return timestamp;
}
