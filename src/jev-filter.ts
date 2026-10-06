import { noul } from "@typesafe-ai/sdk";
import type { RecallTurnResult } from "./retriever.ts";
import type { JevRuntime } from "./jev-runtime.ts";
import type { JevModel } from "./config.ts";

const MAX_BATCH_ITEMS = 64;
const RESERVED_TOKENS = 256;
const MINIMUM_SEGMENT_TOKENS = 256;
const MAX_SEGMENT_TOKENS = 1_024;
const REQUEST_OVERHEAD_TOKENS = 512;
const RELEVANCE_THRESHOLD = 0.5;
const RELEVANCE_CRITERIA = {
  true: "The transcript segment materially helps answer the question.",
  false: "The transcript segment is only a keyword match or does not help answer the question.",
} as const;

interface JevWorkItem {
  candidateIndex: number;
  segmentIndex: number;
  segmentCount: number;
  text: string;
}

export interface JevFilterStats {
  /** Whether jev actively filtered candidates or literal recall remained in use. */
  status: "filtered" | "disabled" | "unavailable";
  model: JevModel;
  contextWindow: number;
  reviewed: number;
  retained: number;
  filtered: number;
  truncated: number;
  reason?: string;
}
export interface JevFilteredOutTurn { turn: RecallTurnResult; noul: number; }
export interface JevFilterResult { results: RecallTurnResult[]; filteredOut: JevFilteredOutTurn[]; stats: JevFilterStats; }

/** Judge each already-ranked literal recall candidate against the complete user question through Jev noul decisions. */
export async function filterRecallWithJev(runtime: JevRuntime, question: string, candidates: RecallTurnResult[]): Promise<JevFilterResult> {
  const model = runtime.selectedModel();
  const contextWindow = runtime.contextWindow();
  const budget = _tokenBudget(question, contextWindow);
  const segmentBudget = Math.min(MAX_SEGMENT_TOKENS, budget - REQUEST_OVERHEAD_TOKENS);
  if (segmentBudget < MINIMUM_SEGMENT_TOKENS) throw new Error(`Jev model context window ${contextWindow} leaves only ${segmentBudget} tokens for transcript evidence; at least ${MINIMUM_SEGMENT_TOKENS} are required`);
  const { items, truncated } = _workItems(candidates, segmentBudget);
  const candidateNouls = new Map<number, number>();
  for (const batch of _requestBatches(question, items, budget)) {
    const answers = await runtime.client().systemOne(_request(question, batch));
    for (const [index, item] of batch.entries()) {
      const noulValue = answers.answers[`item_${index}`].noul;
      candidateNouls.set(item.candidateIndex, Math.max(candidateNouls.get(item.candidateIndex) ?? 0, noulValue));
    }
  }
  const retained = candidates.filter((_candidate, index) => (candidateNouls.get(index) ?? 0) >= RELEVANCE_THRESHOLD);
  const filteredOut = candidates.flatMap((turn, index) => {
    const noulValue = candidateNouls.get(index) ?? 0;
    return noulValue < RELEVANCE_THRESHOLD ? [{ turn, noul: noulValue }] : [];
  });
  return { results: retained, filteredOut, stats: { status: "filtered", model, contextWindow, reviewed: candidates.length, retained: retained.length, filtered: filteredOut.length, truncated } };
}

function _request(question: string, batch: JevWorkItem[]) {
  return {
    state: { userQuestion: question },
    questions: Object.fromEntries(batch.map((item, index) => [
      `item_${index}`,
      noul(`Is this transcript segment directly relevant evidence for answering the user question? Segment ${item.segmentIndex + 1} of ${item.segmentCount}.\n\n${item.text}`, RELEVANCE_CRITERIA),
    ])),
  };
}

function _tokenBudget(question: string, contextWindow: number): number {
  const questionTokens = _estimateTokens(question);
  const budget = contextWindow - RESERVED_TOKENS - questionTokens;
  if (budget < MINIMUM_SEGMENT_TOKENS + REQUEST_OVERHEAD_TOKENS) throw new Error(`Jev model context window ${contextWindow} leaves only ${budget} tokens after request overhead; at least ${MINIMUM_SEGMENT_TOKENS + REQUEST_OVERHEAD_TOKENS} are required`);
  return budget;
}

function _workItems(candidates: RecallTurnResult[], tokenBudget: number): { items: JevWorkItem[]; truncated: number } {
  let truncated = 0;
  const items = candidates.flatMap((candidate, candidateIndex) => {
    const segments = _tokenSegments(`User: ${candidate.user_text}\n\nAssistant: ${candidate.reply_text}`, tokenBudget);
    if (segments.length > 1) truncated++;
    return segments.map((text, segmentIndex) => ({ candidateIndex, segmentIndex, segmentCount: segments.length, text }));
  });
  return { items, truncated };
}

/** Keep the aggregate request under the selected model's effective num_ctx, plus Jev's 64-question cap. */
function _requestBatches(question: string, items: JevWorkItem[], tokenBudget: number): JevWorkItem[][] {
  const batches: JevWorkItem[][] = [];
  let batch: JevWorkItem[] = [];
  for (const item of items) {
    const proposed = [...batch, item];
    if (proposed.length <= MAX_BATCH_ITEMS && _requestTokens(question, proposed) <= tokenBudget) {
      batch = proposed;
      continue;
    }
    if (!batch.length) throw new Error(`A single Jev segment exceeds the ${tokenBudget}-token request budget`);
    batches.push(batch);
    batch = [item];
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** A byte-per-token upper bound guarantees the request stays inside every model tokenizer's context window. */
function _estimateTokens(text: string): number { return Buffer.byteLength(text, "utf8"); }

function _tokenSegments(text: string, tokenBudget: number): string[] {
  const maximumBytes = tokenBudget;
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return [text];
  const segments: string[] = [];
  let segment = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      segments.push(segment);
      segment = character;
      bytes = characterBytes;
    } else {
      segment += character;
      bytes += characterBytes;
    }
  }
  if (segment) segments.push(segment);
  return segments;
}

function _requestTokens(question: string, batch: JevWorkItem[]): number {
  return _estimateTokens(JSON.stringify(_request(question, batch)));
}
