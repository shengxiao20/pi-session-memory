import assert from "node:assert/strict";
import type { Candidate, Category, CorpusTurn } from "./types.ts";

export function validateDataset(corpus: CorpusTurn[], candidates: Candidate[]): Record<string, unknown> {
  assert(corpus.length > 0 && candidates.length > 0, "Dataset needs source turns and candidate questions");
  const turns = new Map(corpus.map(turn => [turn.turn_id, turn]));
  assert.equal(turns.size, corpus.length, "Duplicate source turn IDs");
  const ids = new Set<string>();
  const projectSplits = new Map<string, string>();
  const counts: Record<string, number> = { train: 0, dev: 0, test: 0 };
  const categories: Record<Category, number> = { single_session: 0, cross_session: 0, decision_change: 0, insufficient_evidence: 0 };
  for (const candidate of candidates) {
    assert(candidate.sample_id && !ids.has(candidate.sample_id), "Missing or duplicate candidate ID"); ids.add(candidate.sample_id);
    assert(candidate.review_status === "pending" && candidate.answerable === null && candidate.gold_answer === null,
      "Unreviewed candidates cannot carry gold labels");
    assert(candidate.scope.project_id === candidate.project_id && candidate.scope.through_timestamp === candidate.cutoff_timestamp,
      "Candidate scope and cutoff disagree");
    assert(categories[candidate.category] !== undefined, "Unknown question category");
    categories[candidate.category]++;
    counts[candidate.split]++;
    const existingSplit = projectSplits.get(candidate.project_id);
    assert(existingSplit === undefined || existingSplit === candidate.split, "Project appears in multiple splits");
    projectSplits.set(candidate.project_id, candidate.split);
    assert(candidate.source_turn_ids.length === candidate.evidence.length, "Source IDs and evidence references disagree");
    for (const [index, item] of candidate.evidence.entries()) {
      const turn = turns.get(item.turn_id);
      assert(turn, `Evidence references unknown source turn: ${item.turn_id}`);
      assert(turn.session_id === item.session_id && turn.timestamp === item.timestamp, "Evidence metadata mismatch");
      assert(turn.project_id === candidate.project_id && turn.timestamp <= candidate.cutoff_timestamp, "Evidence outside candidate scope");
      assert(turn[item.field].includes(item.quote), "Evidence quote does not exactly occur in sanitized source");
      assert(candidate.source_turn_ids[index] === item.turn_id, "Source turn order mismatch");
    }
    const uniqueSessions = new Set(candidate.evidence.map(item => item.session_id));
    if (candidate.category === "single_session") assert(uniqueSessions.size === 1 && candidate.evidence.length === 1, "Single-session candidate needs one source");
    if (candidate.category === "cross_session") assert(uniqueSessions.size >= 2, "Cross-session candidate needs multiple source sessions");
    if (candidate.category === "decision_change") assert(uniqueSessions.size === 1 && candidate.evidence.length >= 2, "Decision-change candidate needs two turns in one session");
    if (candidate.category === "insufficient_evidence") {
      assert(candidate.evidence.length === 0, "Insufficient-evidence candidate must not disclose supporting evidence");
      const term = /「([^」]+)」/.exec(candidate.question)?.[1];
      assert(term, "Insufficient-evidence question needs a quoted search term");
      assert(!corpus.some(turn => turn.project_id === candidate.project_id && turn.timestamp <= candidate.cutoff_timestamp &&
        `${turn.user_text}\n${turn.reply_text}`.toLowerCase().includes(term.toLowerCase())), "Negative candidate has an exact pre-cutoff source match");
    }
  }
  const sourceIds = new Set(corpus.map(turn => turn.turn_id));
  for (const candidate of candidates) for (const id of candidate.source_turn_ids) assert(sourceIds.has(id), "Candidate source is absent from corpus");
  return { corpus_turns: corpus.length, candidates: candidates.length, project_count: projectSplits.size,
    split_counts: counts, category_counts: categories,
    split_projects: Object.fromEntries([...projectSplits].sort(([a], [b]) => a.localeCompare(b))) };
}
