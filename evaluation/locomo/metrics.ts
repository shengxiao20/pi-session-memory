import assert from "node:assert/strict";

export interface EvidenceMetric {
  status: "valid" | "empty" | "invalid";
  invalidIds: string[];
  recall: number | null;
  complete: boolean | null;
}
export interface AnswerResult {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  goldAnswer: string;
  prediction: string;
  correct: boolean;
  exactMatch: boolean;
  tokenF1: number;
  contextCharacters: number;
  answerMs: number;
  judgeMs: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
}
export interface QuestionResult extends AnswerResult {
  evidence: EvidenceMetric;
  query: { entities: string[]; primary_entity: string; };
  retrieved: { turnId: string; dialogueId: string; stage: "global" | "project"; score: number; }[];
  globalCandidates: number;
  projectCandidates: number;
  duplicatesRemoved: number;
  retrievalMs: number;
}

/** Preserve malformed annotations as explicit exclusions from evidence metrics; never repair them. */
export function evidenceMetric(goldIds: string[], retrievedIds: string[], availableIds: Set<string>): EvidenceMetric {
  const gold = [...new Set(goldIds)];
  const invalidIds = gold.filter(id => !availableIds.has(id));
  if (invalidIds.length) return { status: "invalid", invalidIds, recall: null, complete: null };
  if (gold.length === 0) return { status: "empty", invalidIds, recall: null, complete: null };
  const retrieved = new Set(retrievedIds);
  const hits = gold.filter(id => retrieved.has(id)).length;
  return { status: "valid", invalidIds, recall: hits / gold.length, complete: hits === gold.length };
}

export function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b(a|an|the)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Diagnostic bag-of-words F1, without LoCoMo's category-specific official scoring. */
export function tokenF1(prediction: string, goldAnswer: string): number {
  const predicted = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const gold = normalizeAnswer(goldAnswer).split(" ").filter(Boolean);
  if (!predicted.length || !gold.length) return Number(predicted.length === gold.length);
  const counts = new Map<string, number>();
  for (const token of gold) counts.set(token, (counts.get(token) ?? 0) + 1);
  let matches = 0;
  for (const token of predicted) {
    const count = counts.get(token) ?? 0;
    if (count > 0) { matches++; counts.set(token, count - 1); }
  }
  return 2 * matches / (predicted.length + gold.length);
}

function _average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

export function summarizeAnswers(results: AnswerResult[]) {
  assert(results.length > 0, "No completed evaluation questions");
  return {
    questions: results.length,
    projectJudgeAccuracy: _average(results.map(result => Number(result.correct))),
    diagnosticExactMatch: _average(results.map(result => Number(result.exactMatch))),
    diagnosticTokenF1: _average(results.map(result => result.tokenF1)),
    answerMeanMs: _average(results.map(result => result.answerMs)),
    judgeMeanMs: _average(results.map(result => result.judgeMs)),
    totalMeanMs: _average(results.map(result => result.totalMs)),
    totalPromptTokens: results.reduce((sum, result) => sum + result.promptTokens, 0),
    totalCompletionTokens: results.reduce((sum, result) => sum + result.completionTokens, 0),
    byCategory: Object.fromEntries([...new Set(results.map(result => result.category))].sort().map(category => {
      const group = results.filter(result => result.category === category);
      return [category, { questions: group.length, projectJudgeAccuracy: _average(group.map(result => Number(result.correct))) }];
    })),
  };
}

export function summarize(results: QuestionResult[]) {
  const answerSummary = summarizeAnswers(results);
  const evidence = results.filter(result => result.evidence.status === "valid");
  const durations = results.map(result => result.retrievalMs).sort((a, b) => a - b);
  return {
    ...answerSummary,
    evidenceEligibleQuestions: evidence.length,
    evidenceEmptyQuestions: results.filter(result => result.evidence.status === "empty").length,
    evidenceInvalidQuestions: results.filter(result => result.evidence.status === "invalid").length,
    evidenceRecall: evidence.length ? _average(evidence.map(result => result.evidence.recall!)) : null,
    evidenceCompleteRate: evidence.length ? _average(evidence.map(result => Number(result.evidence.complete))) : null,
    retrievalMeanMs: _average(durations),
    retrievalP95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
  };
}
