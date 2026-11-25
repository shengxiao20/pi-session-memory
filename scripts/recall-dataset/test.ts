import assert from "node:assert/strict";
import { buildCandidates, selectCandidates, setProjectSplits } from "./candidates.ts";
import { redact } from "./privacy.ts";
import { validateCorpus } from "./source.ts";
import { validateDataset } from "./validate.ts";
import type { CorpusTurn } from "./types.ts";

function turn(input: Partial<CorpusTurn> & Pick<CorpusTurn, "turn_id" | "session_id" | "timestamp" | "user_text" | "reply_text">): CorpusTurn {
  return { project_id: "project-001", turn_index: 0, redactions: 0, ...input };
}

const corpus = [
  turn({ turn_id: "t1", session_id: "s1", timestamp: 1000, turn_index: 1,
    user_text: "Please explain how to configure StreamDeck in this detailed request.",
    reply_text: "The StreamDeck setup uses LegacyRunner. Keep the settings in the project configuration file and verify the startup output." }),
  turn({ turn_id: "t2", session_id: "s2", timestamp: 2000, turn_index: 1,
    user_text: "Can you review the StreamDeck configuration in this other request?",
    reply_text: "StreamDeck uses a shared profile. Record the selected configuration in the project notes and check the service response." }),
  turn({ turn_id: "t3", session_id: "s3", timestamp: 3000, turn_index: 1,
    user_text: "Please use LegacyRunner for the integration in this detailed request.",
    reply_text: "LegacyRunner is the initial integration choice. Test the runner against the local development service." }),
  turn({ turn_id: "t4", session_id: "s3", timestamp: 4000, turn_index: 2,
    user_text: "Actually, change the integration to ModernRunner and keep the same acceptance checks.",
    reply_text: "We changed to ModernRunner because it supports the required integration mode. The earlier LegacyRunner choice is superseded." }),
  turn({ turn_id: "t5", session_id: "s4", timestamp: 5000, turn_index: 1,
    user_text: "Please look up NewVectorEngine for this detailed implementation question.",
    reply_text: "NewVectorEngine has not been discussed in this source turn before today; inspect the vendor instructions first." }),
];

validateCorpus(corpus);
setProjectSplits([{ project_id: "project-001", sessions: 4 }]);
const pool = buildCandidates(corpus);
assert(pool.candidates.some(candidate => candidate.category === "single_session"));
assert(pool.candidates.some(candidate => candidate.category === "cross_session" && candidate.evidence.length === 2));
assert(pool.candidates.some(candidate => candidate.category === "decision_change" && candidate.evidence.length === 2));
assert(pool.candidates.some(candidate => candidate.category === "insufficient_evidence" && candidate.evidence.length === 0));
const selected = selectCandidates(pool.candidates, { single_session: 1, cross_session: 1, decision_change: 1, insufficient_evidence: 1 });
assert.equal(selected.length, 4);
assert.equal(new Set(selected.map(candidate => candidate.sample_id)).size, 4);
assert(selected.every(candidate => candidate.review_status === "pending" && candidate.answerable === null && candidate.gold_answer === null));
const summary = validateDataset(corpus, selected);
assert.equal(summary.candidates, 4);
const cleaned = redact("Contact me at person@example.com from `/Users/alice/My Project/private/file.ts`");
assert.equal(cleaned.count, 2);
assert(!cleaned.text.includes("person@example.com"));
assert(!cleaned.text.includes("private/file.ts"));
console.log("Recall-dataset generator tests passed.");
