# Set up pi-session-memory

## When to use this guide

Use `setup_memory` when the user asks how this plugin works, how to use it, or asks to run setup.
The agent starts this guide with `setup_memory`. The `/pi-session-memory` command provides direct setup, history import, project-session migration, and indexed-tool-turn cleanup actions.
This guide is for configuration, not historical review. Do not call inspect, recall, consultation, migration, import or cleanup tools during setup.

## Interaction rules

1. Explain the plugin briefly: it indexes local Pi, Claude Code and Codex history. Explicit historical review checks saved OKF descriptions first. No clear match starts transcript search, with optional relevance filtering or private historical-session consultation.
2. Read the current configuration returned by `setup_memory`. Show its path. If it is missing, explain that setup can create it after approval. Never create it merely because this guide was opened.
3. Ask **one question per assistant reply**, in the numbered order below. Wait for each answer. Use the user's language. Do not present a questionnaire or ask several subquestions together.
4. Explain each feature before asking whether to enable it. Show the existing setting when available. Preserve settings the user does not change.
5. Skip a disabled feature's detail questions, but explain which optional parameters it supports. Do not assume that an omitted answer means yes. Proposed values are suggestions, not saved defaults.
6. The user can stop at any point. Cancellation does not write anything. A general usage question does not authorize configuration changes. Ask whether the user wants to continue with configuration.
7. Never ask for API keys, certificates or secret values. Ask only for an environment variable name when needed.
8. After all relevant answers, show the proposed JSON changes and the exact configuration path. Ask one final question: **Save these settings?**
9. After explicit approval, call `configure_memory` with the complete proposed supported settings. Do not ask the user to edit the file manually. The tool retains unrelated top-level keys automatically; do not supply them as new settings. Do not claim success if the tool raises an error.
10. Do not start Ollama, pull models, contact a remote endpoint or run history operations during setup. No retry or fallback is allowed. Settings do not prove service readiness.

## Questions, in order

### 1. Start configuration

Explain the Agent tools for saved OKF reading, storage statistics, full import, native Claude Code/Codex migration, backed-up SQLite cleanup, transcript conclusion saving, and consultation control. The command menu directly exposes setup, import, migration, and cleanup. Transcript review remains an Agent workflow. Each destructive or state-changing operation requires a separate explicit request.
Ask: **Would you like to configure the plugin now?** If no, answer usage questions without writing configuration.

### 2. Retrieval limit

`recallLimit` is a required positive integer. It caps each global/project retrieval stage before final deduplication. Two stages can return up to twice this limit; removed duplicates are not refilled.
Show the existing value. For a new configuration, suggest 20 and ask for approval.
Ask: **How many candidate turns should each retrieval stage keep?**

### 3. Historical-session consultation

`enableDiscussion` enables private consultation only for explicit historical recall. The user selects historical Pi sessions. Agents run in memory and do not modify original JSONL. Their agreement is not verification. Main-agent tool permissions remain unchanged.
When off, the main agent reads transcript evidence directly. Both routes save draft OKF conclusions.
Ask: **Enable Discussion?**
If enabled, ask next: **What timeout should each consultation request use, in milliseconds?**
`consultation.timeoutMs` must be a positive integer. It applies to the initial request and each follow-up. There is no runtime default for enabled Discussion. Suggest 120000 only if no value exists; obtain approval.

### 4. Optional relevance filtering

`jevEnable` enables System One relevance filtering of candidate transcript fragments. When off, retrieval uses literal matching and ranking without this model.
Explain its optional `model` and `jevConnection` settings even if filtering stays off.
Ask: **Enable Jev relevance filtering?**
If enabled, ask the following questions one at a time:

1. **Should this plugin manage local Ollama, or use an already managed local/remote service?** `jevConnection.manageOllama: true` permits local startup, model pull and inspection during normal operation. `false` does not manage the service.
2. **Which model should filter results?** `model` accepts a non-empty System One model name. Examples: `nimble`, `tev1:4b`, `tev1:0.8b`. The legacy default is `nimble`; unmanaged service configuration requires an explicit model.
3. **What API root should the service use?** `jevConnection.baseURL` excludes credentials, query, hash and the full systemone endpoint. Managed Ollama requires a local HTTP root, such as `http://127.0.0.1:11434`. Unmanaged connections accept an HTTP(S) API root. The SDK appends `/v1/systemone`.
4. **Which environment variable contains the API key?** Ask this only for unmanaged connections, or if the user explicitly wants a managed-service key variable. `jevConnection.apiKeyEnv` stores the variable name, never the secret. Unmanaged connections require it. Missing runtime credentials raise errors; setup does not populate the environment.
5. **What input-token budget should filtering use?** `jevConnection.contextWindow` is a positive integer. Unmanaged connections require it. For managed Ollama, it is optional and caps the inspected model context; the user can keep it unset.

Warn before confirming a remote connection: candidate transcript fragments leave the local machine for that service.
When filtering stays off, preserve its existing model/connection settings unless the user requests a change.

### 5. Obsidian storage

`obsidianExportEnabled` selects an Obsidian vault as the single OKF storage root. Manual transcript menu searches also export Markdown notes there. It does not automatically export every agent search.
Ask: **Enable Obsidian storage and manual-search export?**
If enabled, ask next: **What is the existing absolute Obsidian vault path?**
`obsidianVaultPath` must identify an existing directory. Invalid paths raise errors. No duplicate output or storage fallback is created.
If disabled, preserve any saved vault path; it is inactive. Setup retains omitted top-level keys and does not delete them.

### 6. Non-Obsidian knowledge location

When Obsidian is off, `consultation.knowledgePath` is an optional legacy custom absolute knowledge root shared by transcript conclusions and Discussion. Without it, the root is `~/.pi/agent/pi-session-memory/knowledge/`.
Explain this setting even when Obsidian is enabled; it is then inactive.
When Obsidian is off, ask: **Use the default knowledge directory or a custom absolute path?**
If custom, ask for that path in the next reply. Any configured `consultation` object also requires a positive `timeoutMs`, even when Discussion is off. Ask for it separately if it has not been specified.
If the user chooses the default root, supply a complete `consultation` object without `knowledgePath` when that object already exists. Retain its positive `timeoutMs`, even when Discussion is off. Omitting the entire object retains the current custom root. If no consultation object exists and Discussion is off, leave it absent.

### 7. Environment-only options

Explain these inputs. They are **not** JSON configuration keys:

- `MEMORY_DB_PATH`: overrides the SQLite path. The default is `~/.pi/agent/memory.db`. Changing it does not migrate the existing index.
- `OLLAMA_HOST`: the plugin does not use it for unmanaged connections; `baseURL` selects the endpoint. Managed Ollama overrides its child process value with the configured API root.
- The variable named by `apiKeyEnv`: supplies the secret at runtime. Do not read or print its value.

Ask: **Keep your environment settings unchanged?** Setup edits only this plugin's JSON configuration. If the user wants environment changes, explain that they are a separate task. Do not insert environment names as unsupported JSON keys.

### 8. Review and save

Show the selected feature switches, all changed parameter values, and a JSON diff. Include retained values so the user can check them. Use the current file as the starting point; do not replace unrelated keys with a template.
The file is `~/.pi/agent/pi-session-memory/config.json`, resolved against the current user's home directory.
Ask: **Save these settings to this file?**
Only after approval, call `configure_memory`. Report the saved path and explain:

- Tools reread configuration on invocation. Restart Pi to rerun startup synchronization and service readiness checks.
- Enabling Jev does not prove that the service, model or credentials are ready.
- Startup synchronization can update the index; configuration saving itself does not run synchronization.
- Setup does not modify JSONL or saved OKF, and does not run SQLite cleanup. Its recorded tool turns remain excluded from SQLite like other package-tool turns.

## New-file proposal

This is a proposal only. Do not save it before the user answers and approves.

```json
{
  "recallLimit": 20,
  "enableDiscussion": false,
  "jevEnable": false,
  "model": "nimble",
  "jevConnection": {
    "baseURL": "http://127.0.0.1:11434",
    "manageOllama": true
  },
  "obsidianExportEnabled": false
}
```
