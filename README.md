# pi-session-memory

**Current version: 0.7.1**

## Install

```bash
pi install npm:pi-session-memory
```

A local-first Pi extension for **on-demand cross-session transcript search** across Pi, Claude Code, and Codex, plus native project-session migration to Pi `/resume` sessions.

## What it does

- Indexes local Pi, Claude Code, and Codex JSONL transcript turns in local SQLite.
- Provides `recall_memory` for literal raw-history search, returning a configured number of ranked matches.
- Provides `recall_project_memory` alongside direct recall whenever a current or named project is relevant: the project matches stored session CWD metadata and the identical bilingual topic entities search only those sessions.
- Provides `fetch_session` for read-only expansion of the smallest useful transcript range.
- Synchronizes changed history at Pi session start; the `/pi-session-memory` menu provides explicit full history import.
- Migrates current-project Claude Code or Codex sessions into separate native Pi sessions.
- Matches equivalent Windows project CWDs during migration, including `\\` versus `/`, drive-letter case, and trailing separators.

Search results are derived from stored source transcripts only and are never automatically injected into model context. Put project rules and preferences in `AGENTS.md`.

## What's new in 0.7.1

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
| `recall_memory` | Search prior work using 2–8 specific literal topic entities, including Chinese and English equivalents. When a current or named project is relevant, also call `recall_project_memory`. |
| `recall_project_memory` | Call alongside `recall_memory` whenever a current or explicitly named project is relevant. Reuse identical Chinese-and-English topic entities; put the project name only in `project`, never in `entities`, and prioritize its evidence. Its normalized words match the stored CWD directory name, so `pi app` can resolve `pi-native-app`. |
| `fetch_session` | A recall excerpt lacks needed context. Fetch the smallest useful range. It is read-only. |
| `get_memory_stats` | The user asks how much local history is indexed. |
| `backfill_memory` | The user explicitly asks to import, backfill, or rescan history. |
| `migrate_project_sessions` | The user wants to continue current-project Claude Code or Codex work through `/resume`; omit `sources` to migrate both. |
| `review_jev_filtered` | Inspect possible Jev false negatives after recall, using the original bilingual entities and complete question. |

## Flow

```text
session_start -> syncChangedHistory() -> SQLite raw transcript index
no project context -> recall_memory(bilingual topic entities) -> matching raw transcript turns -> fetch_session (optional, read-only)
current or named project -> recall_memory(bilingual topic entities) + recall_project_memory(project metadata + identical bilingual topic entities) -> prioritize project-scoped turns or session candidates -> fetch_session (optional, read-only)
project migration command/tool -> native Pi session JSONL -> /resume
```

## JSON configuration

The extension reads its optional global configuration from:

```text
~/.pi/agent/pi-session-memory/config.json
```

Create or edit that JSON file to configure recall volume and optional Jev relevance filtering:

```json
{
  "recallLimit": 20,
  "jevEnable": false,
  "model": "nimble"
}
```

Configuration fields:

- `recallLimit`: required positive integer. `recall_memory` and `recall_project_memory` return at most this many ranked turns.
- `jevEnable`: optional boolean, default `false`. Set it to `true` to have local Jev review already-ranked turns against the complete user question and filter keyword-only false positives.
- `model`: optional Jev/Ollama model, default `nimble`. Allowed values are `nimble`, `tev1:4b`, and `tev1:0.8b`.

When Jev is enabled, the extension starts or reuses local Ollama and ensures the selected model is installed. Jev setup or request failures leave literal recall active. Existing files may omit `jevEnable` and `model` and receive the defaults above. Missing or invalid configuration raises an error instead of silently choosing a fallback.

Project-scoped topic search still examines every session whose CWD matches the project; `recallLimit` is applied after ranking, so older matching sessions remain searchable. When no project-scoped turn matches, at most `recallLimit` recent project-session candidates are returned instead.

History remains on the local machine, by default in `~/.pi/agent/memory.db`. Deleting that database removes only the index; restarting Pi rebuilds it from local source JSONL files.

## Migration compatibility

Migration selects sessions whose recorded project CWD is equivalent to the current Pi project CWD. On Windows, `C:\\Work\\app\\`, `C:/Work/app`, and differences only in path letter case are treated as the same project. Migrated sessions are written using the current Pi project CWD, so they appear under that project in `/resume`.

## Development

```bash
npm test          # core database, raw recall, importer, and migration regression suite
```
