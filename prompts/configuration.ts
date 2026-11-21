// Static field help shared by direct editing and Agent-assisted setup.
// Keys, types, defaults, numeric bounds and conditional validation
// stay in src/.
export const CONFIG_FIELD_HELP = {
  recallLimit: {
    label: "Recall result limit",
    requirement: "required",
    description:
      "Maximum results per recall stage. The runtime requires this value.",
    defaultLabel: "20 (editor proposal; no runtime default)",
  },
  recallMode: {
    label: "Recall delivery mode",
    requirement: "optional",
    description:
      "normal returns transcripts. discussion consults confirmed " +
      "historical Pi sessions. choice asks after each recall. " +
      "The per-call choice never changes this setting.",
    defaultLabel: "choice",
  },
  "consultation.timeoutMs": {
    label: "Participant timeout (ms)",
    requirement: "required when consultation is configured",
    description:
      "Timeout for each initial question and follow-up. The editor " +
      "proposes a value; the runtime requires it.",
    defaultLabel: "120000 (editor proposal; no runtime default)",
  },
  "consultation.turnThreshold": (environmentName: string) => ({
    label: "Discussion turn threshold",
    requirement: "optional",
    description:
      "A session needs strictly more unique returned turns. " +
      `${environmentName}` +
      " overrides this setting.",
    defaultLabel: "5",
  }),
  knowledgePath: {
    label: "OKF knowledge directory",
    requirement: "optional",
    description:
      "Complete absolute OKF root shared by transcript conclusions " +
      "and Discussion. No consultation timeout is required. " +
      "Blank removes the custom path and selects the default root.",
  },
  jevEnable: {
    label: "Jev relevance filtering",
    requirement: "optional",
    description:
      "Review retrieved transcript segments with the configured " +
      "System One model.",
    defaultLabel: "false",
  },
  model: {
    label: "Jev decision model",
    requirement: "optional; required when manageOllama=false",
    description:
      "System One model name. Saving does not download or inspect " +
      "the model.",
    defaultLabel: "nimble",
  },
  "jevConnection.baseURL": {
    label: "Jev API root",
    requirement: "required when jevConnection is configured",
    description:
      "HTTP(S) root without credentials, query or fragment. Managed " +
      "Ollama requires a local HTTP root.",
  },
  "jevConnection.manageOllama": {
    label: "Manage local Ollama",
    requirement: "required when jevConnection is configured",
    description:
      "Allow runtime service management. Editing and saving never " +
      "start a service.",
    defaultLabel: "true",
  },
  "jevConnection.apiKeyEnv": {
    label: "API key environment variable name",
    requirement: "optional; required when manageOllama=false",
    description:
      "Name only, not the API key. Set the credential outside Pi. " +
      "Blank removes the name.",
    defaultLabel: "not set",
  },
  "jevConnection.contextWindow": {
    label: "Jev context window",
    requirement: "optional; required when manageOllama=false",
    description:
      "Positive input budget. Managed Ollama detects it at runtime " +
      "when omitted. Blank removes the cap.",
    defaultLabel: "auto-detected for managed Ollama",
  },
};

export const ENVIRONMENT_HELP = {
  discussionTurnThreshold: {
    requirement: "optional",
    default: "consultation.turnThreshold, then 5",
    description:
      "Read-only shell override. Use a canonical non-negative " +
      "decimal safe integer. Unset it in the shell to use the saved " +
      "value.",
  },
  databasePath: {
    requirement: "optional",
    default: "~/.pi/agent/memory.db",
    description:
      "External SQLite path. Changing it does not migrate the index. " +
      "Restart Pi after changing it.",
  },
  ollamaHost: {
    requirement: "optional",
    default: "managed service uses jevConnection.baseURL",
    description:
      "External Ollama input. Managed service startup overrides it " +
      "with the configured API root's host.",
  },
  apiKey: {
    requirement: "required when manageOllama=false",
    default: "not set",
    description:
      "Set the credential in your shell. The editor never reads, " +
      "displays or stores its value.",
  },
};
