import assert from "node:assert/strict";
import type { Candidate, Category, CorpusTurn, Evidence, Split } from "./types.ts";
import { containsSecret, isEvaluationText } from "./privacy.ts";

const STOP = new Set(`about after again against also another any because before being between both could does doing down during each few from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very what when where which while with would your about agent answer build change code file history issue memory model package project pi plan question recall result session should task test tool user using want`.split(" "));
const CHANGE = /\b(?:actually|instead|rather than|changed? (?:to|from)|switch(?:ed)? to|no longer|now use|replaced? (?:by|with)|decided to|correction|update:|supersed(?:e|ed))\b|(?:改为|改成|换成|不再使用|改用|决定(?:改|换)|后来发现|更正|更新为|取代)/i;

let PROJECT_SPLITS = new Map<string, Split>();
export function setProjectSplits(projects: { project_id: string; sessions: number }[]): void {
  const ordered = [...projects].sort((a, b) => b.sessions - a.sessions || a.project_id.localeCompare(b.project_id));
  PROJECT_SPLITS = new Map(ordered.map((project, index) => [project.project_id,
    index % 20 < 14 ? "train" : index % 20 < 17 ? "dev" : "test"]));
}
function splitFor(project: string): Split { return PROJECT_SPLITS.get(project) ?? "train"; }
function words(text: string): string[] {
  const matches = text.match(/[A-Za-z][A-Za-z0-9_.-]{4,}|[\p{Script=Han}]{4,}/gu) ?? [];
  const expanded = matches.flatMap(word => {
    if (!/^\p{Script=Han}+$/u.test(word)) return [word];
    const grams: string[] = [];
    for (let index = 0; index + 4 <= word.length; index += 2) grams.push(word.slice(index, index + 4));
    if (word.length >= 5) grams.push(word.slice(-4));
    return grams;
  });
  return [...new Set(expanded.map(word => word.toLowerCase()).filter(word => !STOP.has(word) && !/^\d+$/.test(word)))];
}
function excerpt(text: string, limit = 450): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}…`;
}
function quoteContaining(text: string, term: string): string {
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  return (index < 0 ? text.slice(0, 450) : text.slice(Math.max(0, index - 180), Math.min(text.length, index + term.length + 270))).trim();
}
function evidence(turn: CorpusTurn, field: Evidence["field"], quote: string): Evidence {
  assert(turn[field].includes(quote), "Evidence quote must appear in its source turn");
  return { turn_id: turn.turn_id, session_id: turn.session_id, timestamp: turn.timestamp, field, quote };
}
function makeCandidate(input: {
  category: Category; project: string; question: string; cutoff: number; sourceTurns: CorpusTurn[];
  evidence: Evidence[]; answer: string;
}): Candidate {
  const { category, project, question, cutoff, sourceTurns, evidence: sources, answer } = input;
  assert(question.length >= 15 && answer.trim(), "Candidate question and answer must be non-empty");
  assert(!containsSecret(`${question}\n${answer}\n${sources.map(item => item.quote).join("\n")}`), "Secret-like content in candidate");
  assert(!isEvaluationText(`${question}\n${answer}`), "Evaluation contamination in candidate");
  const project_id = sourceTurns[0]?.project_id ?? project;
  return {
    sample_id: `${category}|${project_id}|${sources.map(item => item.turn_id).join("|")}|${question}`,
    category, split: splitFor(project_id), project_id, question, cutoff_timestamp: cutoff,
    scope: { project_id, through_timestamp: cutoff }, source_turn_ids: sources.map(item => item.turn_id),
    evidence: sources, review_status: "pending", answerable: null, gold_answer: null,
    candidate_answer: excerpt(answer, 1000),
  };
}

function oneSession(turns: CorpusTurn[]): Candidate[] {
  const eligible = turns.filter(turn => turn.user_text.length >= 20 && turn.reply_text.length >= 100 && turn.reply_text.length <= 12000 &&
    !/^(?:好的|谢谢|ok|okay|yes|no|继续|明白)[.!。！\s]*$/i.test(turn.user_text.trim()));
  const ranked = [...eligible].sort((a, b) => a.turn_id.localeCompare(b.turn_id));
  return ranked.map((turn) => {
    const prompt = excerpt(turn.user_text, 220);
    const answer = excerpt(turn.reply_text, 900);
    return makeCandidate({ category: "single_session", project: turn.project_id,
      question: `在这段历史中，对请求「${prompt}」当时给出的答复是什么？`, cutoff: turn.timestamp,
      sourceTurns: [turn], evidence: [evidence(turn, "reply_text", turn.reply_text.slice(0, 450).trim())], answer });
  });
}

function crossSession(turns: CorpusTurn[]): Candidate[] {
  const byProject = groupBy(turns, turn => turn.project_id);
  const candidates: Candidate[] = [];
  for (const [project, projectTurns] of byProject) {
    const byTerm = new Map<string, Map<string, CorpusTurn>>();
    for (const turn of projectTurns) {
      for (const term of words(`${turn.user_text}\n${turn.reply_text}`)) {
        const sessions = byTerm.get(term) ?? new Map<string, CorpusTurn>();
        if (!sessions.has(turn.session_id)) sessions.set(turn.session_id, turn);
        byTerm.set(term, sessions);
      }
    }
    for (const [term, sessionMap] of byTerm) {
      if (sessionMap.size < 2 || term.length < 4) continue;
      const selected = [...sessionMap.values()].sort((a, b) => a.timestamp - b.timestamp).slice(0, 2);
      if (selected[0]!.session_id === selected[1]!.session_id) continue;
      const sources = selected.map(turn => {
        const field: Evidence["field"] = turn.reply_text.toLowerCase().includes(term) ? "reply_text" : "user_text";
        return evidence(turn, field, quoteContaining(turn[field], term));
      });
      const answer = sources.map((item, index) => `会话 ${index + 1}：${item.quote}`).join("\n");
      candidates.push(makeCandidate({ category: "cross_session", project,
        question: `在该项目中，按时间排序后最早提到「${term}」的两段不同会话分别记录了什么？`,
        cutoff: Math.max(...selected.map(turn => turn.timestamp)), sourceTurns: selected, evidence: sources, answer }));
    }
  }
  return candidates.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
}

function decisionChange(turns: CorpusTurn[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const sessionTurns of groupBy(turns, turn => turn.session_id).values()) {
    const ordered = [...sessionTurns].sort((a, b) => a.timestamp - b.timestamp || a.turn_index - b.turn_index);
    for (let index = 1; index < ordered.length; index++) {
      const later = ordered[index]!;
      const changedText = `${later.user_text}\n${later.reply_text}`;
      const marker = CHANGE.exec(changedText);
      if (!marker) continue;
      const before = ordered.slice(0, index).filter(turn => later.timestamp - turn.timestamp < 90 * 24 * 3600 * 1000);
      const laterTerms = words(changedText).sort((a, b) => b.length - a.length);
      let best: { turn: CorpusTurn; term: string; score: number } | undefined;
      for (const turn of before) {
        const previousText = `${turn.user_text}\n${turn.reply_text}`;
        const term = laterTerms.find(candidate => candidate.length >= 4 && previousText.toLowerCase().includes(candidate));
        if (!term) continue;
        const score = term.length * 100 + Math.min(turn.timestamp, later.timestamp) / 1e15;
        if (!best || score > best.score) best = { turn, term, score };
      }
      if (!best) continue;
      const term = best.term;
      const beforeField: Evidence["field"] = best.turn.reply_text.toLowerCase().includes(term) ? "reply_text" : "user_text";
      const afterField: Evidence["field"] = later.user_text.toLowerCase().includes(term) ? "user_text" : "reply_text";
      const sources = [evidence(best.turn, beforeField, quoteContaining(best.turn[beforeField], term)),
        evidence(later, afterField, quoteContaining(later[afterField], term))];
      candidates.push(makeCandidate({ category: "decision_change", project: later.project_id,
        question: `在这段会话中，「${term}」的先前记录是什么？后续记录又如何更改或修正？`, cutoff: later.timestamp,
        sourceTurns: [best.turn, later], evidence: sources, answer: `较早记录：${sources[0]!.quote}\n后续记录：${sources[1]!.quote}` }));
    }
  }
  return candidates.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
}

function insufficientEvidence(turns: CorpusTurn[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [project, projectTurns] of groupBy(turns, turn => turn.project_id)) {
    const ordered = [...projectTurns].sort((a, b) => a.timestamp - b.timestamp || a.turn_index - b.turn_index);
    const priorTerms = new Set<string>();
    const priorTexts: string[] = [];
    let index = 0;
    while (index < ordered.length) {
      const timestamp = ordered[index]!.timestamp;
      const end = ordered.findIndex((turn, start) => start >= index && turn.timestamp > timestamp);
      const stop = end < 0 ? ordered.length : end;
      for (const turn of ordered.slice(index, stop)) {
        const text = `${turn.user_text}\n${turn.reply_text}`;
        const absent = words(text).filter(term => term.length >= 8 && !priorTerms.has(term) &&
          !priorTexts.some(previous => previous.toLowerCase().includes(term.toLowerCase())));
        for (const term of absent.slice(0, 1)) {
          const cutoff = Math.max(0, timestamp - 1);
          candidates.push(makeCandidate({ category: "insufficient_evidence", project, question:
            `截至 ${new Date(cutoff).toISOString()} 的历史中，是否已明确提到「${term}」？若找不到记录，请回答证据不足。`,
            cutoff, sourceTurns: [], evidence: [],
            answer: `候选生成器在项目历史时间戳不晚于 ${cutoff} 的记录中未找到该精确词项；人工需确认这是否构成真实的证据不足题。` }));
          break;
        }
      }
      for (const turn of ordered.slice(index, stop)) {
        const text = `${turn.user_text}\n${turn.reply_text}`;
        for (const term of words(text)) priorTerms.add(term);
        priorTexts.push(text);
      }
      index = stop;
    }
  }
  return candidates.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
}

function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) { const id = key(value); const group = groups.get(id) ?? []; group.push(value); groups.set(id, group); }
  return groups;
}

export interface CandidatePool { candidates: Candidate[]; available: Record<Category, number>; }
export function buildCandidates(corpus: CorpusTurn[]): CandidatePool {
  const generated: Candidate[] = [...oneSession(corpus), ...crossSession(corpus), ...decisionChange(corpus), ...insufficientEvidence(corpus)];
  const unique = new Map(generated.map(candidate => [candidate.sample_id, candidate]));
  const candidates = [...unique.values()];
  assert(candidates.every(candidate => candidate.review_status === "pending" && candidate.gold_answer === null && candidate.answerable === null));
  const available = Object.fromEntries(["single_session", "cross_session", "decision_change", "insufficient_evidence"].map(category =>
    [category, candidates.filter(candidate => candidate.category === category).length])) as Record<Category, number>;
  return { candidates: candidates.sort((a, b) => a.sample_id.localeCompare(b.sample_id)), available };
}

function splitQuotas(total: number): Record<Split, number> {
  const exact = { train: total * 0.70, dev: total * 0.15, test: total * 0.15 };
  const result: Record<Split, number> = { train: Math.floor(exact.train), dev: Math.floor(exact.dev), test: Math.floor(exact.test) };
  let remaining = total - result.train - result.dev - result.test;
  const order: Split[] = (["train", "dev", "test"] as Split[]).sort((a, b) =>
    (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])) || a.localeCompare(b));
  for (const split of order) if (remaining-- > 0) result[split]++;
  return result;
}

function takeSpread(candidates: Candidate[], wanted: number): Candidate[] {
  const projects = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const items = projects.get(candidate.project_id) ?? [];
    items.push(candidate); projects.set(candidate.project_id, items);
  }
  for (const items of projects.values()) items.sort((a, b) => (a.source_turn_ids[0] ?? "").localeCompare(b.source_turn_ids[0] ?? "") || a.question.localeCompare(b.question));
  const projectIds = [...projects.keys()].sort((a, b) => projects.get(b)!.length - projects.get(a)!.length || a.localeCompare(b));
  const selected: Candidate[] = [];
  while (selected.length < wanted) {
    let added = false;
    for (const project of projectIds) {
      const candidate = projects.get(project)!.shift();
      if (candidate) { selected.push(candidate); added = true; }
      if (selected.length === wanted) break;
    }
    if (!added) break;
  }
  return selected;
}

export function selectCandidates(pool: Candidate[], quotas: Record<Category, number>): Candidate[] {
  const selected: Candidate[] = [];
  for (const category of ["single_session", "cross_session", "decision_change", "insufficient_evidence"] as const) {
    const wanted = splitQuotas(quotas[category]);
    for (const split of ["train", "dev", "test"] as const) {
      selected.push(...takeSpread(pool.filter(candidate => candidate.category === category && candidate.split === split), wanted[split]));
    }
  }
  return selected.sort((a, b) => a.split.localeCompare(b.split) || a.category.localeCompare(b.category) || a.project_id.localeCompare(b.project_id) || a.sample_id.localeCompare(b.sample_id))
    .map((candidate, index) => ({ ...candidate, sample_id: `candidate-${String(index + 1).padStart(4, "0")}` }));
}
