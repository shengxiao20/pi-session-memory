/** Static user-facing overview displayed from the pi-session-memory command menu. */
export const SESSION_MEMORY_HELP = `pi-session-memory

This extension indexes local Pi, Claude Code, and Codex transcript history for on-demand cross-session retrieval.

Run /pi-session-memory to open one selectable menu (the only user-facing command):
- Help and release notes
- Local storage status
- Global history search with equivalent Chinese and English topics
- Project-scoped history search plus global history
- Historical-session import
- Current-project Claude Code and Codex session migration for /resume

All user-facing actions are accessed from this folded menu; no separate slash commands are registered.

Recall past discussions
- Ask what was discussed or decided about a specific topic.
- Pi searches local history only when needed, then reads the smallest useful session range.
- History is not injected automatically into context, and agent-generated summaries are not saved.

Local storage
- For search, enter exactly <Chinese topic> | <English topic> in the menu prompt.
- Project search additionally asks for the project name. Normalized project words match session CWD metadata (for example, pi app can match pi-native-app) and never search transcript text.
- Put persistent rules, preferences, and project instructions in AGENTS.md.

Configuration
- The optional JSON configuration file is ~/.pi/agent/pi-session-memory/config.json.
- Configure recallLimit as a positive integer to control the maximum ranked turns returned by recall.
- Set jevEnable to true to enable local Jev relevance filtering; it defaults to false.
- Set model to nimble, tev1:4b, or tev1:0.8b for Jev; it defaults to nimble.
- Example: { "recallLimit": 20, "jevEnable": false, "model": "nimble" }
- Missing or invalid configuration is reported as an error; there is no silent fallback.

History stays in local SQLite. An import error in one source file does not prevent indexing sessions from other Pi, Claude Code, or Codex sources.`;
