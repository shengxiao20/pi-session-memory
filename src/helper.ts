/** Static user-facing overview displayed from the pi-session-memory command menu. */
export const SESSION_MEMORY_HELP = `pi-session-memory

This extension indexes local Pi, Claude Code, and Codex transcript history for on-demand cross-session retrieval.

Run /pi-session-memory to open one selectable menu (the only user-facing command):
- Help and release notes
- Local storage status
- Global history search with equivalent Chinese and English topics
- Named-project directory discovery followed by content search within matching sessions
- Historical-session import
- Current-project Claude Code and Codex session migration for /resume

All user-facing actions are accessed from this folded menu; no separate slash commands are registered.

Recall past discussions
- Ask what was discussed or decided about a specific topic.
- One recall_memory tool call runs global recall first, then project recall with the same entities and complete question.
- Project discovery uses supplied entities and stored session directory names, never the current session, project, or CWD.
- Only final project turns already returned globally are removed by exact turn_id; there is no refill or retrieval change.
- Tool progress and compact results distinguish Global recall and Project recall; expand to read complete original turns.
- Pi searches local history only when needed, then reads the smallest useful session range.
- History is not injected automatically into context, and agent-generated summaries are not saved.

Local storage
- For search, enter exactly <Chinese topic> | <English topic> in the menu prompt.
- The manual project menu uses the same two entered Chinese/English topics to match stored session CWD final-directory names and then search those sessions' turns. It does not infer a project from the current CWD and does not run global recall or Jev.
- Put persistent rules, preferences, and project instructions in AGENTS.md.
- If Obsidian export is enabled in configuration, every completed history search writes its complete result to one new Markdown note in the configured vault. No selection is required.

Configuration
- The optional JSON configuration file is ~/.pi/agent/pi-session-memory/config.json.
- Configure recallLimit as a positive integer to cap each stage's ranked candidates; final project deduplication does not refill removed turns.
- Set jevEnable to true to enable System One relevance filtering; it defaults to false.
- Set model to the endpoint's decision model name; local configuration defaults to nimble (other examples: tev1:4b and tev1:0.8b).
- Omit jevConnection to retain managed local Ollama at http://127.0.0.1:11434.
- To configure a connection, set jevConnection.baseURL (the SDK appends /v1/systemone) and manageOllama explicitly.
- With manageOllama false, configure model, apiKeyEnv (the environment variable containing the API key), and contextWindow (positive integer input budget). No local startup, pull, or model inspection occurs.
- With manageOllama true, use a local HTTP root URL; contextWindow optionally caps the detected Ollama num_ctx.
- Remote example: { "model": "jev-latest", "jevConnection": { "baseURL": "https://api.typesafe.ai", "apiKeyEnv": "TYPESAFE_API_KEY", "contextWindow": 4096, "manageOllama": false } }
- Qwen Decision API uses the same client: use its workspace API root ending in /compatible-mode, DASHSCOPE_API_KEY, and decision-model-preview.
- Remote filtering sends candidate transcript fragments and the complete user question to the configured service. Reload the extension after changing connection configuration.
- Missing or empty API key environment variables are errors; no automatic provider detection or backend fallback is performed.
- Obsidian export is optional and defaults to disabled: omit obsidianExportEnabled and obsidianVaultPath to keep it disabled.
- To enable it, set obsidianExportEnabled to true and obsidianVaultPath to an existing vault directory; each completed search result is saved as one Markdown note.
- Base example: { "recallLimit": 20, "jevEnable": false, "model": "nimble" }
- Obsidian opt-in: { "obsidianExportEnabled": true, "obsidianVaultPath": "/absolute/path/to/existing/Obsidian Vault" }
- Missing or invalid configuration is reported as an error; there is no silent fallback.

The SQLite index stays local. An import error in one source file does not prevent indexing sessions from other Pi, Claude Code, or Codex sources.`;
