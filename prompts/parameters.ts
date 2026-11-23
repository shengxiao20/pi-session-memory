// Parameter descriptions only. Types, defaults and validation remain in src/.
export const PARAMETER_HELP = {
  meeting: {
    title: "Single-line display title for the saved minutes.",
    topicPath:
      "Explicit relative path below meetings/, using lowercase " +
      "kebab-case segments. Reuse relevant existing topics; never " +
      "infer the path from the current working directory.",
    topicSummaries:
      "One single-line title and description for each topic_path " +
      "segment, in path order. Existing directory summaries must " +
      "match their indexes.",
    tags: "Cross-cutting labels. Use [] when no labels apply.",
  },
  setup: {
    turnThreshold:
      "Exclusive unique returned-turn threshold. The environment " +
      "variable PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD " +
      "overrides it.",
  },
  recall: {
    entities:
      "Literal topic entities used for both global transcript search " +
      "and stored session directory-name discovery, then transcript " +
      "search in those discovered sessions.",
    primaryEntity:
      "Complete core name or phrase copied verbatim from question, " +
      "not split, translated or paraphrased. Must also occur in " +
      "entities. Its case-insensitive literal match adds +10 once " +
      "per turn before ranking and LIMIT.",
    question:
      "The complete user question containing primary_entity " +
      "verbatim, also used by optional Jev filtering in both recall " +
      "stages.",
    reviewPrimaryEntity:
      "Reuse primary_entity from recall_memory: a verbatim core " +
      "phrase from question also included in entities; complete " +
      "phrase hits add +10 once per turn.",
    reviewQuestion:
      "The complete original user question used for Jev relevance " +
      "judgment.",
    fetchTurnId:
      "Exact Fetch turn ID returned by recall_memory or " +
      "review_jev_filtered. Copy the full value; do not parse its " +
      "suffix.",
    fetchBefore:
      "Number of turn-index positions before the target. Use 0 for " +
      "no preceding context.",
    fetchAfter:
      "Number of turn-index positions after the target. Use 0 for no " +
      "following context.",
  },
  knowledge: {
    writeQuestion:
      "The complete user request to save the current context as OKF.",
    writeContext:
      "A faithful snapshot of the current visible context that " +
      "supports the conclusion. This is agent-supplied evidence, " +
      "not a retrieved historical transcript. Cite it as context-1.",
    directory:
      "Omit or use an empty string for the bundle root. Otherwise " +
      "copy directory from a previous catalogue. Paths are " +
      "bundle-relative, below meetings/, without a trailing slash.",
  },
};
