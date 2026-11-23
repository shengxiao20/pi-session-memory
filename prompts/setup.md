# Set up pi-session-memory

## When to use this guide

Use `setup_memory` when the user asks how this plugin works, how to use it, or
asks to run setup. The agent starts this guide with `setup_memory`. Its result
also includes field metadata with defaults and required conditions. The
`/pi-session-memory` command provides direct configuration editing, guided
setup, Pi history import, and indexed-tool-turn cleanup actions. This guide is
for configuration, not historical review. Do not call inspect, recall,
consultation, migration, import or cleanup tools during configuration setup.
After a successful guided setup save, offer the separate optional import step
below. General usage questions and direct field editing do not offer import.

## Direct configuration editor

Users can select **Edit configuration** from `/pi-session-memory` without asking
the Agent to run setup. The editor lists 11 JSON variables with aligned
`(optional)` or `(required)` and `(now: value)` metadata. Rows show saved
values. Unset fields show their default value or default description. Nested
variables are indented. Select a field to see its current value and detailed
conditions. Enter a value or choose a boolean to save immediately. There are no
Save or Cancel actions and no extra confirmation. Esc keeps a field unchanged or
leaves the menu. Previously submitted values remain saved. Blank input uses the
default shown in the field dialog. Optional fields without literal defaults
become unset. Invalid values raise errors and do not save that edit. Unchanged
fields retain their current values; unset defaults initialize on submission. Set
connection details before disabling local management. `knowledgePath` specifies
the complete OKF root. Saving a path does not move existing knowledge. The
values `20` and `120000` are editor proposals, not runtime defaults, for
`recallLimit` and `consultation.timeoutMs`. The editor does not modify shell
variables or read credentials. Editing never starts services, imports history,
or performs consultation. Restart Pi for startup checks.

## Interaction rules

These rules apply to Agent-assisted setup, not the direct editor. Agent saving
still requires final approval.

1. Explain the plugin briefly: it indexes local Pi history. Explicit historical
   review inspects relevant saved OKF directory branches and meeting metadata
   first. No clear match starts transcript search, with optional relevance
   filtering or private historical-session consultation.
2. Read the current configuration returned by `setup_memory`. Show its path. If
   it is missing, explain that setup can create it after approval. Never create
   it merely because this guide was opened.
3. Ask **one question per assistant reply**, in the numbered order below. Wait
   for each answer. Use the user's language. Do not present a questionnaire or
   ask several subquestions together.
4. Explain each feature before asking whether to enable it. Show the existing
   setting when available. Preserve settings the user does not change.
5. Skip a disabled feature's detail questions, but explain which optional
   parameters it supports. Do not assume that an omitted answer means yes.
   Proposed values are suggestions, not saved defaults.
6. The user can stop at any point. Cancellation does not write anything. A
   general usage question does not authorize configuration changes. Ask whether
   the user wants to continue with configuration.
7. Never ask for API keys, certificates or secret values. Ask only for an
   environment variable name when needed.
8. After all relevant answers, show the proposed JSON changes and the exact
   configuration path. Ask one final question: **Save these settings?**
9. After explicit approval, call `configure_memory` with the complete proposed
   supported settings. Do not ask the user to edit the file manually. Include
   every supported setting the user keeps, including complete nested objects.
   Supported settings are a complete replacement; omitted optional settings are
   removed. The tool retains unrelated top-level keys automatically; do not
   supply them as new settings. Do not claim success if the tool raises an
   error.
10. Do not start Ollama, pull models, contact a remote endpoint or run history
    operations during setup. No retry or fallback is allowed. Settings do not
    prove service readiness.

## Questions, in order

### 1. Start configuration

Explain the Agent tools for saved OKF reading, storage statistics, full Pi
import, backed-up SQLite cleanup, transcript conclusion saving, and consultation
control. The command menu directly exposes configuration editing, guided setup,
import, and cleanup. Transcript review remains an Agent workflow. Each
destructive or state-changing operation requires a separate explicit request.
Ask: **Would you like to configure the plugin now?** If no, answer usage
questions without writing configuration.

### 2. Retrieval limit

`recallLimit` is a required positive integer. It caps each global/project
retrieval stage before final deduplication. Two stages can return up to twice
this limit; removed duplicates are not refilled. Show the existing value. For a
new configuration, suggest 20 and ask for approval. Ask: **How many candidate
turns should each retrieval stage keep?**

### 3. Recall delivery and historical-session consultation

`recallMode` controls explicit historical recall through `recall_memory`:

- `normal` returns transcript evidence without opening historical agents.
- `discussion` consults user-confirmed historical Pi sessions.
- `choice` asks after each completed global/project search. It is the default.

The native terminal menu shows returned-turn counts and both routes. The choice
applies only to that call; it does not change configuration. Esc cancels without
returning evidence or opening agents. Non-interactive use must select `normal`
or `discussion` in configuration. `fetch_session` stays a precise transcript
extension and does not show this menu. Both evidence routes save draft OKF.

The old `enableDiscussion` key is no longer supported. Runtime reads reject it.
An approved configuration save removes it and uses the proposed `recallMode`.
There is no automatic boolean conversion or configuration write.

Ask: **Which recall mode should be used: choice, normal, or discussion?** For
`choice` or `discussion`, ask next: **What timeout should each consultation
request use, in milliseconds?** `consultation.timeoutMs` must be positive. It
applies to the initial question and each follow-up. There is no runtime timeout
default. Suggest 120000 only when no value exists; obtain approval. `discussion`
requires consultation settings. `choice` can leave them absent, but selecting
Discussion then raises an explicit error, not a normal fallback.

After a timeout answer, ask next: **What unique returned-turn threshold should
Discussion use?** `consultation.turnThreshold` defaults to `5` and accepts a
non-negative safe integer. A session needs strictly more unique returned turns,
after optional Jev filtering and deduplication. `0` admits one returned turn.
The environment override `PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD` takes
priority. It requires canonical decimal notation without whitespace or leading
zeros, except `0`. Invalid values raise errors. Keep existing consultation
settings in `normal` mode unless the user requests a change. Any consultation
object still requires a positive timeout.

All eligible sessions start selected in the participant checklist. There is no
session-count cap. The user confirms participants before agents open. Agents run
in memory and never modify original JSONL. Main-agent permissions stay
unchanged. Agreement is not verification. No eligible participants or a
cancelled checklist produces no consultation answers, not a transcript fallback.

### 4. Optional relevance filtering

`jevEnable` enables System One relevance filtering of candidate transcript
fragments. When off, retrieval uses literal matching and ranking without this
model. Explain its optional `model` and `jevConnection` settings even if
filtering stays off. Ask: **Enable Jev relevance filtering?** If enabled, ask
the following questions one at a time:

1. **Should this plugin manage local Ollama, or use an already managed
   local/remote service?** `jevConnection.manageOllama: true` permits local
   startup, model pull and inspection during normal operation. `false` does not
   manage the service.
2. **Which model should filter results?** `model` accepts a non-empty System One
   model name. Examples: `nimble`, `tev1:4b`, `tev1:0.8b`. The legacy default is
   `nimble`; unmanaged service configuration requires an explicit model.
3. **What API root should the service use?** `jevConnection.baseURL` excludes
   credentials, query, hash and the full systemone endpoint. Managed Ollama
   requires a local HTTP root, such as `http://127.0.0.1:11434`. Unmanaged
   connections accept an HTTP(S) API root. The SDK appends `/v1/systemone`.
4. **Which environment variable contains the API key?** Ask this only for
   unmanaged connections, or if the user explicitly wants a managed-service key
   variable. `jevConnection.apiKeyEnv` stores the variable name, never the
   secret. Unmanaged connections require it. Missing runtime credentials raise
   errors; setup does not populate the environment.
5. **What input-token budget should filtering use?**
   `jevConnection.contextWindow` is a positive integer. Unmanaged connections
   require it. For managed Ollama, it is optional and caps the inspected model
   context; the user can keep it unset.

Warn before confirming a remote connection: candidate transcript fragments leave
the local machine for that service. When filtering stays off, preserve its
existing model/connection settings unless the user requests a change.

### 5. OKF knowledge location

`knowledgePath` is an optional absolute root shared by transcript conclusions,
Discussion, and saved knowledge reading. Without it, the root is
`~/.pi/agent/pi-session-memory/knowledge/`. It is independent of `consultation`;
setting a knowledge path does not require a timeout or a consultation object.
Ask: **Use the default knowledge directory or a custom absolute path?** If
custom, ask for that path in the next reply. The path is the complete bundle
root. The plugin does not append a subdirectory. Resolution and configuration
saving do not create it. The first knowledge save creates missing directories.
Invalid paths raise errors. No duplicate output or storage fallback is created.

Older `obsidianExportEnabled`, `obsidianVaultPath`, and
`consultation.knowledgePath` fields are rejected, not automatically migrated.
For an existing configuration, explain the retired fields before proposing a
repair. Ask the user to approve the complete target root. To keep an existing
vault bundle in place, explicitly select its current `pi-session-memory`
subdirectory. To keep an old custom root, explicitly select that same root.
Approved saving removes retired fields but never moves or deletes documents.
Leave all other settings, including omitted optional values, unchanged unless
the user approves a change. Selecting the default root removes `knowledgePath`;
it does not delete files from the previous root.

### 6. Environment-only options

Explain these inputs. They are **not** JSON configuration keys:

- `MEMORY_DB_PATH`: overrides the SQLite path. The default is
  `~/.pi/agent/memory.db`. Changing it does not migrate the existing index.
- `PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD`: exclusive unique returned-turn
  threshold for Discussion, default `5`. Use `0` for all historical sessions
  with at least one hit. Set it before starting Pi. Values must be non-negative
  safe integers in decimal notation, without whitespace or leading zeros except
  `0`. Empty, malformed, negative, fractional, or unsafe values raise errors.
  Setup does not save this variable.
- `OLLAMA_HOST`: the plugin does not use it for unmanaged connections; `baseURL`
  selects the endpoint. Managed Ollama overrides its child process value with
  the configured API root.
- The variable named by `apiKeyEnv`: supplies the secret at runtime. Do not read
  or print its value.

Ask: **Keep your environment settings unchanged?** Setup edits only this
plugin's JSON configuration. If the user wants environment changes, explain that
they are a separate task. Do not insert environment names as unsupported JSON
keys.

### 7. Review and save

Show the selected feature switches, all changed parameter values, and a JSON
diff. Include retained values so the user can check them. Use the current file
as the starting point; do not replace unrelated keys with a template. The file
is `~/.pi/agent/pi-session-memory/config.json`, resolved against the current
user's home directory. Ask: **Save these settings to this file?** Only after
approval, call `configure_memory`. Report the saved path and explain:

- Tools reread configuration on invocation. Restart Pi to rerun service
  readiness checks, not history import.
- Enabling Jev does not prove that the service, model or credentials are ready.
- Pi startup does not import history. Each completed Agent run writes the latest
  current user turn. Existing history requires an explicit import.
- Configuration saving does not modify JSONL or saved OKF, and does not import
  history or run SQLite cleanup. Its recorded tool turns remain excluded from
  SQLite like other package-tool turns.

## Optional history import after setup

Configuration setup is complete only after `configure_memory` succeeds. Then
provide one optional history-import step outside configuration setup. Saving
configuration is not approval to import. Do not offer this step for general
usage questions, direct field editing, cancelled setup, or a failed save.

1. Explain that Pi startup does not import existing history. Full import reads
   all discovered Pi session files into SQLite. It can restore sessions that the
   user manually deleted from the database. It does not modify source JSONL or
   saved OKF documents.
2. Ask one question: **Import all existing Pi history now?** Wait for a separate
   explicit answer. Do not assume that approval to save settings means yes.
3. Only after explicit import approval, call `backfill_memory` once. This is a
   separate import operation, not part of `configure_memory`. Do not run recall,
   Jev filtering, consultation, migration, cleanup or service checks for it.
4. If the user declines, does not answer, or cancels, do not import. The saved
   configuration remains unchanged. The user can later select **Import history**
   from `/pi-session-memory` or explicitly ask the Agent to import.
5. Report the import result and any failures. Do not retry, use a fallback, or
   claim success for failed files. Import failure does not undo the saved
   configuration.

## New-file proposal

This is a proposal only. Do not save it before the user answers and approves.

```json
{
  "recallLimit": 20,
  "recallMode": "choice",
  "jevEnable": false,
  "model": "nimble",
  "jevConnection": {
    "baseURL": "http://127.0.0.1:11434",
    "manageOllama": true
  }
}
```
