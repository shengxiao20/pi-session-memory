import assert from "node:assert/strict";
import type { EvalConfig, ResolvedModels } from "./config.ts";
import type { Question } from "./dataset.ts";
import { complete, parseGrade } from "./models.ts";
import { normalizeAnswer, tokenF1, type AnswerResult } from "./metrics.ts";

export interface ConversationTurn { turnId: string; text: string; reply: string; }

/** Keep answer prompts, input fields, scoring and budgets identical across scenarios. */
export async function answerAndGrade(qa: Question, questionIndex: number, turns: ConversationTurn[], config: EvalConfig,
  models: Pick<ResolvedModels, "answer" | "judge">, audit: string): Promise<Omit<AnswerResult, "sampleId" | "totalMs">> {
  const contextCharacters = JSON.stringify(turns).length;
  assert(contextCharacters <= config.contextCharacterLimit, `Conversation context exceeds explicit ${config.contextCharacterLimit}-character limit`);
  assert(qa.answer !== undefined, "Gold answer is required for scoring");
  const answered = await complete(models.answer, { role: "answer", questionIndex, input: { question: qa.question, turns }, json: false }, config.timeoutMs, audit);
  const goldAnswer = String(qa.answer);
  const judged = await complete(models.judge, { role: "judge", questionIndex,
    input: { question: qa.question, gold_answer: goldAnswer, prediction: answered.content }, json: true }, config.timeoutMs, audit);
  return {
    questionIndex, category: qa.category, question: qa.question, goldAnswer, prediction: answered.content,
    correct: parseGrade(judged.content), exactMatch: normalizeAnswer(answered.content) === normalizeAnswer(goldAnswer),
    tokenF1: tokenF1(answered.content, goldAnswer), contextCharacters, answerMs: answered.latencyMs, judgeMs: judged.latencyMs,
    promptTokens: answered.usage.promptTokens + judged.usage.promptTokens,
    completionTokens: answered.usage.completionTokens + judged.usage.completionTokens,
  };
}
