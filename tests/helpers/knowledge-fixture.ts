import type { MeetingConclusion } from "../../src/knowledge/meeting-minutes.ts";
import type { RecallTurnResult } from "../../src/contracts/recall.ts";

/** Shared explicit topic metadata for output, tool and SDK integration tests. */
export const knowledgeFields: Pick<MeetingConclusion, "title" | "topic_path" | "topic_summaries" | "tags"> = {
  title: "Joule research review",
  topic_path: "agent-memory/joule",
  topic_summaries: [
    { title: "Agent memory", description: "Historical agent research and implementation reviews." },
    { title: "Joule", description: "Joule research, deployment and open questions." },
  ],
  tags: ["joule", "research"],
};

/** Create distinct sessions for transcript publication and navigation tests. */
export function knowledgeTurn(index = 0): RecallTurnResult {
  return {
    turn_id: `pi:session-${index}:user-1`, session_id: `pi:session-${index}`, turn_index: 0,
    source: "pi", cwd: "/test/project", ts: index, score: 10,
    user_text: "EVIDENCE_BODY_NOT_METADATA", reply_text: `Historical reply ${index}`,
  };
}
