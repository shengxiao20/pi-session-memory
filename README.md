# pi-session-memory

[中文](README_zh.md)

**Current version: 0.7.23**

## Install

```bash
pi install npm:pi-session-memory
```

Local-first cross-session & cross-agent dialogue search based on sqlite with optional local or remote System One semantic relevance filtering, or direct session migration from Claude Code and Codex to Pi, and optional Obsidian export, compatible in Chinese and English.

## What it does

- Indexes local Pi, Claude Code, and Codex JSONL transcript turns in local SQLite.
- Provides `recall_memory` as one automatic sequential operation: unconditional global literal search across every indexed turn, followed by entity-discovered project-session search with the same entities and complete question. Its public interface has no CWD, project, source, session, or time filters.
- The project stage matches supplied entities against stored session CWD final-directory names, then searches only matching sessions. After optional Jev review, it removes turns whose exact `turn_id` was already returned by the global stage. Ranking, limits, directory matching, and Jev logic are unchanged; removed results are not refilled.
- Shows **Global recall** and **Project recall** separately in tool progress and compact results. Expand the result to read the complete original turns. The separate `recall_project_memory` agent tool is no longer registered; manual global/project menu searches remain independent and unchanged.
- Provides `fetch_session` for read-only expansion of the smallest useful transcript range.
- Synchronizes changed history at Pi session start; the `/pi-session-memory` menu provides explicit full history import.
- Migrates current-project Claude Code or Codex sessions into separate native Pi sessions.
- Matches equivalent Windows project CWDs during migration, including `\\` versus `/`, drive-letter case, and trailing separators.

Search results are derived from stored source transcripts only and are never automatically injected into model context. Put project rules and preferences in `AGENTS.md`.

## Invocation configuration summary

All six agent tools append a two-line invocation-time configuration snapshot to their results and progress updates. Compact recall rendering keeps both lines visible:

```text
Config · Jev=off (nimble) · Obsidian=off · manageOllama=on · limit=20
Env · MEMORY_DB_PATH=unset · API key=local-placeholder · OLLAMA_HOST=unset (managed override)
```

The first line reports configured switches, the model and recall limit, not runtime readiness. The second reports whether the relevant environment inputs are non-empty; when `apiKeyEnv` is configured, its variable name and `set`/`unset` replace the local placeholder label. Managed Ollama overrides its child process's `OLLAMA_HOST` with the configured connection address; unmanaged connections do not use `OLLAMA_HOST`. No credential values, database/vault paths or endpoint URLs are displayed. Each invocation rereads configuration; its progress and final result share one snapshot. Original result sections and structured details stay unchanged, and Obsidian notes contain only search evidence, not this operational summary. Manual menu behavior is unchanged.

## Transcript turn semantics

- Pi imports follow `id`/`parentId`, including non-message entries between messages. Each user entry with searchable text owns one turn; replies on alternate branches belong to their nearest user ancestor, never to the last user in file order. Multiple replies to the same user are aggregated in file order; this is a turn index, not a reconstruction of one active branch.
- Pi live writes and imports share the same turn builder. Repeated writes refresh accumulated reply text and tool names instead of ignoring later output. `turn_index` is the zero-based user-entry position in the complete session file, not the active branch; image-only users occupy a position but are not searchable turns.
- User turns without a text reply remain indexed, including interrupted requests and tool-only responses. Pi and Claude tool-only assistant messages retain their tool names.
- Parser-version changes automatically reindex unchanged Pi, Claude Code and Codex files at the next session start. This corrects old pairings and indices without editing source transcripts. Old cached index ranges may change once during this upgrade; use ranges from fresh recall results. Invalid Pi IDs or parent links produce an import issue and leave the file's previous index intact rather than treating it as linear history.

## Obsidian export

Obsidian export is optional and disabled by default: omit both `obsidianExportEnabled` and `obsidianVaultPath` to keep it disabled. To enable it, set `obsidianExportEnabled` to `true` and `obsidianVaultPath` to an existing vault directory. Every completed history search then writes its complete search evidence (excluding the invocation configuration summary) as one new root-level Markdown note, including searches with no matches. No result selection or Vault-path prompt is required. Each note receives a timestamp and UUID filename, so it never overwrites an existing note.

Obsidian export has no separate agent tool and adds no vault configuration to agent context. The combined recall tool exports both stages together as one complete note, using the same deduplicated project results as its text and structured details; menu searches continue to export independently.

## What's new in 0.7.23

- **Two-line configuration snapshot:** every agent tool result and progress update reports Jev/model, Obsidian, local Ollama management, recall limit and relevant environment-variable `set`/`unset` states. Compact recall keeps both lines visible.
- **Safe, isolated diagnostics:** no key values, paths or endpoint URLs are exposed; original evidence, structured details, retrieval and Obsidian exports are unchanged. Configuration status does not imply runtime readiness.
- **Regression coverage:** adds isolated summary/decorator tests and E2E checks for progress, compact rendering, redaction and exports. Run `/reload` to load the updated local extension.

## What's new in 0.7.22

- **Ollama startup safety:** missing CLI startup errors reject normally and surface through existing runtime diagnostics instead of crashing Pi with an unhandled child-process error.
- **Correct Pi branch ownership:** replies follow `parentId`; imports and live writes share a stable, complete-history user-turn index.
- **Complete turn preservation:** live writes refresh appended replies and tool names; imports preserve unanswered user requests and tool-only responses. Parser versions trigger automatic index repair on the next session start.
- **Jev request validation:** every fully serialized single-segment request must fit the existing byte-based budget, including segments that begin a new batch. Oversized requests raise an explicit error before any batches are sent; no new fallback or automatic backend switching is added.
- **Regression coverage:** adds isolated tests for all five fixes. Run `/reload` to load the updated extension.

## What's new in 0.7.21

- **Theme-aware recall text:** compact results, expanded originals, progress and errors use Pi's `toolOutput` foreground color on every line instead of the terminal's default text color. Tool-panel backgrounds and global theme settings are not changed.
- **Packaging:** includes the linked Chinese README in the npm package.
- **Display-only fix:** retrieval, Jev filtering, deduplication, structured results and exports remain unchanged. Run `/reload` to load the updated local extension.

## What's new in 0.7.20

- **One protocol/client:** Ollama, official Jev and Qwen Decision API share the existing System One request and `.noul` response processing; no OpenAI adapter is included.
- **Configurable connection:** `jevConnection` provides `baseURL`, `apiKeyEnv`, `contextWindow` and explicit `manageOllama`. Model names are no longer restricted to the three local examples.
- **Independent local management:** only managed local connections start Ollama, pull models or inspect `/api/show`; legacy configurations retain the original local behavior.
- **Explicit remote setup:** unmanaged connections require a model, API key environment variable and input budget. Missing credentials raise errors; there is no provider detection or backend switching.
- **Algorithm unchanged:** retrieval, segmentation, batching, probability aggregation and the `0.5` relevance threshold remain unchanged. Remote filtering sends candidate original fragments and the complete question to the configured service.

## What's new in 0.7.19

- **One automatic call:** `recall_memory` runs global recall first, then project recall; the model no longer has to invoke two tools in order.
- **Final-output deduplication:** project results remove only exact `turn_id` values returned globally, after both stages' optional Jev review. No pre-query exclusions or refill are added.
- **Separate terminal stages:** progress and compact rendering keep Global recall and Project recall distinguishable; expanded text, structured results, and the single Obsidian note agree.
- **Retrieval unchanged:** SQL, ranking, `recallLimit`, directory matching, and Jev behavior remain intact. Manual menu searches and `review_jev_filtered` retain their existing behavior.

## What's new in 0.7.18

- Continues the bilingual Chinese and English README presentation.

## What's new in 0.7.17

- Adds bilingual Chinese and English npm metadata and README documentation.

## What's new in 0.7.16

- **Gallery extension discovery:** adds the `pi-extension` npm keyword, so this package is included when visitors filter the Pi package gallery by **extension**.

## What's new in 0.7.15

- **Entity-driven project discovery:** `recall_project_memory` no longer accepts `project`; it uses the same entities as global recall to match stored session CWD directory names.
- **Two-stage project search:** any entity matching a stored project/session directory discovers those sessions, then the same entities search only their turns.
- **Always paired:** every prior-history question calls both global turn recall and entity-driven project-session recall, without current runtime context.

## What's new in 0.7.14

- **Exact recall semantics:** `recall_memory` always searches every indexed transcript turn globally, with no current Pi session, project, or CWD context.
- **Stored-session-name discovery:** `recall_project_memory` runs only for a project-name keyword explicitly supplied by the user; it first matches stored session CWD directory names, then searches turns only in matched sessions.
- **No runtime inference:** project lookup never derives a project from the current Pi session, current directory, or runtime context.

## What's new in 0.7.13

- **Complementary recall responsibilities:** `recall_memory` searches all transcript content globally, while `recall_project_memory` searches sessions belonging to the named project.
- **Mandatory paired invocation:** prior-work questions involving the current project or any named project, repository, application, agent, service, or codebase must call both tools with identical entities and question.
- **No current-directory fallback:** project resolution uses only the explicit `project` argument and stored session CWD directory names.

## What's new in 0.7.11

- **Uninterrupted project recall:** `recall_project_memory` no longer accepts source or time filters; it always searches every turn in sessions resolved from `project`.
- **Minimal project interface:** project recall now accepts only `project`, `entities`, and `question`.

## What's new in 0.7.10

- **Every-turn global recall:** `recall_memory` now has no CWD, project, source, session, or time scope; it always searches all indexed SQLite turns.
- **Unscopeable interface:** only `entities` and `question` remain in its public parameters, preventing agents from silently narrowing global searches.

## What's new in 0.7.9

- **Quiet disabled Jev:** when `jevEnable` is `false`, global and project recall show only recall results without the redundant Jev status section.
- **Diagnostics preserved:** Jev status remains visible when filtering is enabled, unavailable, or fails.

## What's new in 0.7.8

- **Guaranteed global recall:** `recall_memory` no longer exposes a CWD parameter and always searches every indexed project.
- **Dedicated project scope:** only `recall_project_memory` performs named-project discovery by matching stored CWD directory names; use it only when the user supplies a project-name keyword. It is independent of global transcript search.
- **Consistent Jev review:** global `review_jev_filtered` audits cannot be accidentally restricted by the current CWD either.

## What's new in 0.7.7

- **Optional Obsidian configuration:** `obsidianExportEnabled` and `obsidianVaultPath` can both be omitted; export remains disabled by default. Configure a vault path only when explicitly enabling export.

## What's new in 0.7.6

- **Automatic per-search Obsidian notes:** with `obsidianExportEnabled`, every completed history search writes its complete result to one new Markdown note in `obsidianVaultPath` without selection.
- **No agent exposure:** Obsidian export is not registered as an agent tool and is not added to agent context.

## What's new in 0.7.5

- **Configuration-controlled Obsidian export:** configure its vault location with `obsidianExportEnabled` and `obsidianVaultPath`.
- **No agent exposure:** Obsidian export is not registered as an agent tool and is not added to agent context.

## What's new in 0.7.4

- **Explicit Obsidian export:** selectively write displayed recall results to new Markdown notes in an existing vault.
- **Safe writes:** exports require exact source turn IDs and refuse missing vaults, invalid selections, and existing target files.

## What's new in 0.7.3

- **Startup notifications:** history synchronization remains enabled, while the automatic sync summary is no longer displayed when a Pi session starts.
- **Operational notices:** synchronization errors and Jev availability status notifications remain visible.

## What's new in 0.7.2

- **Codex history compatibility:** import legacy transcripts with missing message IDs and distinguish child threads from their root session. Repeated turn metadata no longer causes duplicate turn keys.
- **Shared migration identities:** native-session migration uses the same deterministic message identity rules as indexing, preserving repeated messages.
- **Automatic index upgrade:** unchanged Codex files are reparsed once after the parser upgrade. Existing records are replaced transactionally without resetting the database. Back up the index if exact pre-upgrade restoration is required; record-based IDs are stable under append, but not earlier record insertions or removals.

## What's new in 0.7.0

- **One command only:** use the `/pi-session-memory` folded menu for help, release notes, storage status, global/project recall, history import, and session migration. The former standalone slash commands are removed.
- **Optional Jev filtering:** enable local Jev semantic review after literal ranking to filter keyword-only false positives; review failures keep literal recall active.
- **Expanded agent tools:** project-scoped recall, unified Claude Code/Codex migration, and `review_jev_filtered` are available through the Pi tool interface.
- **Package version:** updated to `0.7.0`.

Run `/pi-session-memory` in Pi to open the menu and access every user-facing capability.

## Commands

| Command | Description |
| --- | --- |
| `/pi-session-memory` | Open the selectable menu for help, release notes, status, recall, import, and migration. All user-facing actions are accessed from this menu. |

## Agent tools

| Tool | Use when |
| --- | --- |
| `recall_memory` | For every prior-conversation or prior-work question, call once with 2–8 literal entities and the complete question. It automatically runs global recall, then entity-discovered project recall, and removes final project turns already returned globally by exact `turn_id`. No current session, project, or CWD context is used. |
| `fetch_session` | A recall excerpt lacks needed context. Fetch the smallest useful range. It is read-only. |
| `get_memory_stats` | The user asks how much local history is indexed. |
| `backfill_memory` | The user explicitly asks to import, backfill, or rescan history. |
| `migrate_project_sessions` | The user wants to continue current-project Claude Code or Codex work through `/resume`; omit `sources` to migrate both. |
| `review_jev_filtered` | Inspect possible Jev false negatives after recall, using the original bilingual entities and complete question. |

## Flow

```text
session_start -> syncChangedHistory() -> SQLite raw transcript index
one recall_memory(entities, question) call:
  global = existing global literal recall -> optional Jev
  project = existing entity-driven project recall -> optional Jev
  project_unique = project turns whose turn_id is not in global final results
  return separate global and project_unique sections -> fetch_session (optional, read-only)
manual global/project menu searches -> existing independent literal searches (no Jev)
enabled export -> every completed history search -> one complete result Markdown note in the configured existing Obsidian vault
project migration command/tool -> native Pi session JSONL -> /resume
```

## JSON configuration

The extension reads its optional global configuration from:

```text
~/.pi/agent/pi-session-memory/config.json
```

Create or edit that JSON file to configure recall volume and optional Jev relevance filtering. Obsidian fields are not required:

```json
{
  "recallLimit": 20,
  "jevEnable": false,
  "model": "nimble"
}
```

To explicitly enable automatic Obsidian export, add both fields:

```json
{
  "obsidianExportEnabled": true,
  "obsidianVaultPath": "/absolute/path/to/existing/Obsidian Vault"
}
```

Configuration fields:

- `recallLimit`: required positive integer. Each recall stage retrieves at most this many ranked candidates independently. Project deduplication runs only afterward and never refills removed turns, so a combined call can return up to twice this limit before cross-stage duplicates are removed. Per-stage Jev statistics describe review before deduplication; `project.duplicatesRemoved` separately reports removed final turns.
- `obsidianExportEnabled`: optional boolean; defaults to `false`. When `true`, every completed history search automatically writes one complete result note.
- `obsidianVaultPath`: required non-empty path when `obsidianExportEnabled` is `true`. It must identify an existing vault directory when a search is exported.
- `jevEnable`: optional boolean, default `false`. Set it to `true` to review already-ranked turns against the complete user question and filter keyword-only false positives through System One.
- `model`: non-empty decision model name. Omitted local configuration defaults to `nimble`; other local examples include `tev1:4b` and `tev1:0.8b`. Unmanaged connections must provide an explicit model.
- `jevConnection`: optional connection object. Omit it to retain managed local Ollama at `http://127.0.0.1:11434`. If provided, `baseURL` and `manageOllama` are required:
  - `baseURL`: HTTP(S) API root with no embedded credentials, query or fragment. The SDK appends `/v1/systemone`; do **not** use the full endpoint or include `/v1` as the suffix for the services below. Qwen's API root ends in `/compatible-mode`.
  - `manageOllama`: explicit boolean, not inferred from URL or model. `true` requires a local HTTP root URL (`127.0.0.1`, `localhost`, or `[::1]`) and manages Ollama startup, version validation, model pull, and `num_ctx` inspection at that address. CLI calls use the same address via `OLLAMA_HOST`. `false` performs none of these operations, including for an independently managed Ollama endpoint.
  - `apiKeyEnv`: name of the environment variable containing the API key, required when `manageOllama` is `false`. Missing or empty values raise an error before any decision request. Managed Ollama uses the existing `ollama` placeholder unless an explicit environment variable is configured. Keys are not stored in configuration or added to tool output.
  - `contextWindow`: positive integer effective input budget, required when `manageOllama` is `false`; set it within your model's actual limits. No remote model discovery is attempted. For managed Ollama, this optional budget caps the detected `num_ctx` and cannot increase it.

### Switching System One endpoints

All three use the same TypeSafe SDK and the existing filtering code. They differ only in connection/model settings, not request/response adapters:

| Service | `baseURL` | `model` example | `apiKeyEnv` | `manageOllama` |
| --- | --- | --- | --- | --- |
| Managed local Ollama | `http://127.0.0.1:11434` | `nimble` | Omit for the `ollama` placeholder | `true` |
| Official Jev | `https://api.typesafe.ai` | `jev-latest` | `TYPESAFE_API_KEY` | `false` |
| Qwen Decision API (Singapore) | `https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode` | `decision-model-preview` | `DASHSCOPE_API_KEY` | `false` |

Official Jev example (the `4096` budget is an example, not a claim about the model's maximum):

```json
{
  "recallLimit": 20,
  "jevEnable": true,
  "model": "jev-latest",
  "jevConnection": {
    "baseURL": "https://api.typesafe.ai",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "contextWindow": 4096,
    "manageOllama": false
  }
}
```

Set `TYPESAFE_API_KEY` in the environment of the Pi process. To use Qwen, replace the URL with your workspace's `/compatible-mode` API root, set `model` to `decision-model-preview` and `apiKeyEnv` to `DASHSCOPE_API_KEY`, and supply that region/workspace's key. Use [TypeSafe's System One documentation](https://docs.typesafe.ai/api/system-one) and [Alibaba Cloud's Decision API documentation](https://www.alibabacloud.com/help/en/model-studio/decision-model-api) for access, regions and current model limits. This is the Decision/System One API, **not** the ordinary Qwen chat-completions API.

Reload the extension after changing model or connection settings; switching a live runtime's connection is rejected. A remote connection becomes ready after local configuration and credential resolution; readiness does not imply its endpoint or key has been verified by a network request. Authentication, connection and other request failures retain the existing Jev-unavailable/literal-recall behavior for that session. Local Ollama setup failures keep their existing behavior too; neither case switches to another backend. Missing/invalid configuration or missing configured API-key credentials raises an error instead of choosing a fallback.

**Privacy:** the SQLite index and source files stay local, but enabling a remote System One endpoint sends the complete user question and candidate transcript fragments to that service. Remote filtering is opt-in; legacy configurations remain local.

Project-scoped topic search still examines every session whose stored CWD directory matches a supplied entity; `recallLimit` is applied after ranking, so older matching sessions remain searchable. The combined tool includes only sessions attached to its final unique project turns. Manual project menu search keeps its existing behavior, including up to `recallLimit` recent project-session candidates when no project-scoped turn matches.

The SQLite index remains on the local machine, by default in `~/.pi/agent/memory.db`. Deleting that database removes only the index; restarting Pi rebuilds it from local source JSONL files.

## Migration compatibility

Migration selects sessions whose recorded project CWD is equivalent to the current Pi project CWD. On Windows, `C:\\Work\\app\\`, `C:/Work/app`, and differences only in path letter case are treated as the same project. Migrated sessions are written using the current Pi project CWD, so they appear under that project in `/resume`.
