// Shared identifiers for tool registration and prompt text.
export const TOOL_NAMES = {
  inspectMemoryKnowledge: "inspect_memory_knowledge",
  readMemoryKnowledge: "read_memory_knowledge",
  recallMemory: "recall_memory",
  fetchSession: "fetch_session",
  reviewJevFiltered: "review_jev_filtered",
  followUpSession: "follow_up_session",
  finishSessionConsultation: "finish_session_consultation",
  finishMemoryRecall: "finish_memory_recall",
  writeOkf: "write_okf",
  cancelSessionConsultation: "cancel_session_consultation",
  getMemoryStats: "get_memory_stats",
  backfillMemory: "backfill_memory",
  cleanMemoryToolTurns: "clean_memory_tool_turns",
  setupMemory: "setup_memory",
  configureMemory: "configure_memory",
} as const;
