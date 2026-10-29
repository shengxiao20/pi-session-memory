import { recallTurns } from "./retriever.ts";
import { recallProjectMemory, type ProjectRecallOptions, type ProjectRecallResult } from "./project-retriever.ts";
import type { JevFilterResult } from "./jev-filter.ts";

export interface RecallWorkflowOptions extends ProjectRecallOptions { question: string; }
export interface RecallWorkflowProgress {
  stage: "global" | "project";
  message: string;
}
export interface RecallWorkflowResult {
  global: JevFilterResult;
  project: ProjectRecallResult & Omit<JevFilterResult, "results"> & { duplicatesRemoved: number };
}
export type RecallReviewer = (
  question: string,
  results: JevFilterResult["results"],
  progress: (message: string) => void,
) => Promise<JevFilterResult>;

/** Run the existing global and project searches sequentially, then deduplicate only final project output. */
export async function recallSequentially(
  options: RecallWorkflowOptions,
  review: RecallReviewer,
  progress: (update: RecallWorkflowProgress) => void,
): Promise<RecallWorkflowResult> {
  const globalProgress = (message: string) => progress({
    stage: "global", message: `Global recall: ${message}\nProject recall: waiting for global recall.`,
  });
  globalProgress("searching all indexed turns…");
  const global = await review(options.question, recallTurns(options.entities), globalProgress);

  const projectProgress = (message: string) => progress({
    stage: "project", message: `Global recall: complete — ${global.results.length} turns returned.\nProject recall: ${message}`,
  });
  projectProgress("searching entity-discovered project sessions…");
  const literalProject = recallProjectMemory(options);
  const reviewedProject = await review(options.question, literalProject.results, projectProgress);

  const globalTurnIds = new Set(global.results.map((turn) => turn.turn_id));
  const results = reviewedProject.results.filter((turn) => !globalTurnIds.has(turn.turn_id));
  const retainedSessionIds = new Set(results.map((turn) => turn.session_id));
  return {
    global,
    project: {
      ...reviewedProject,
      results,
      sessions: literalProject.sessions.filter((session) => retainedSessionIds.has(session.session_id)),
      duplicatesRemoved: reviewedProject.results.length - results.length,
    },
  };
}
