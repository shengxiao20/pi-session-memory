# pi-session-memory

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
- Synchronizes changed history at Pi session start; `/memory-backfill` performs an explicit full rescan.
- Migrates current-project Claude Code or Codex sessions into separate native Pi sessions.
- Matches equivalent Windows project CWDs during migration, including `\\` versus `/`, drive-letter case, and trailing separators.

Search results are derived from stored source transcripts only and are never automatically injected into model context. Put project rules and preferences in `AGENTS.md`.

## What's new in 0.6.2

- When a current or named project is relevant, search raw history and project-directory CWD metadata together, then prioritize project-scoped evidence. Project words are normalized, so `pi app` matches `pi-native-app`.
- Both searches reuse the same Chinese and English topic entities. A project name scopes session metadata and is never required to appear in its own transcript.
- One editable `recallLimit` in `~/.pi/agent/pi-session-memory/config.json` caps results consistently for direct and project-scoped recall.

Run `/pi-session-memory-whats-new` in Pi to show the release notes for the installed version.

## Commands

| Command | Description |
| --- | --- |
| `/pi-session-memory-helper` | Show cross-session search and migration help. |
| `/pi-session-memory-whats-new` | Show release notes for the installed version. |
| `/memory-status` | Show locally indexed session and turn totals. |
| `/memory-search <Chinese topic> \| <English topic>` | Search locally indexed raw transcript history using equivalent bilingual topic entities when no project-specific context is needed. |
| `/memory-project-search <project> -- <Chinese topic> \| <English topic>` | Search both local history and the named project's CWD-scoped sessions; use when a project is relevant and reuse identical bilingual topics. The project matches CWD metadata and never searches transcript text. |
| `/memory-backfill` | Explicitly rescan historical Pi, Claude Code, and Codex JSONL. |
| `/project-session-migration` | Convert current-project Codex sessions for `/resume`. |
| `/project-claude-session-migration` | Convert current-project Claude Code sessions for `/resume`. |

## Agent tools

| Tool | Use when |
| --- | --- |
| `recall_memory` | Search prior work using 2–8 specific literal topic entities, including Chinese and English equivalents. When a current or named project is relevant, also call `recall_project_memory`. |
| `recall_project_memory` | Call alongside `recall_memory` whenever a current or explicitly named project is relevant. Reuse identical Chinese-and-English topic entities; put the project name only in `project`, never in `entities`, and prioritize its evidence. Its normalized words match the stored CWD directory name, so `pi app` can resolve `pi-native-app`. |
| `fetch_session` | A recall excerpt lacks needed context. Fetch the smallest useful range. It is read-only. |
| `get_memory_stats` | The user asks how much local history is indexed. |
| `backfill_memory` | The user explicitly asks to import, backfill, or rescan history. |
| `migrate_codex_project_sessions` | The user wants to continue current-project Codex work through `/resume`. |
| `migrate_claude_project_sessions` | The user wants to continue current-project Claude Code work through `/resume`. |

## Flow

```text
session_start -> syncChangedHistory() -> SQLite raw transcript index
no project context -> recall_memory(bilingual topic entities) -> matching raw transcript turns -> fetch_session (optional, read-only)
current or named project -> recall_memory(bilingual topic entities) + recall_project_memory(project metadata + identical bilingual topic entities) -> prioritize project-scoped turns or session candidates -> fetch_session (optional, read-only)
project migration command/tool -> native Pi session JSONL -> /resume
```

## Recall result limits

Edit `~/.pi/agent/pi-session-memory/config.json` to control recall volume:

```json
{
  "recallLimit": 20
}
```

`recall_memory` and `recall_project_memory` always return at most `recallLimit` ranked turns. Project-scoped topic search still examines every session whose CWD matches the project; the limit is applied after ranking, so older matching sessions remain searchable. When no project-scoped turn matches, at most `recallLimit` recent project-session candidates are returned instead. Invalid or missing configuration raises an error instead of silently choosing a fallback.

History remains on the local machine, by default in `~/.pi/agent/memory.db`. Deleting that database removes only the index; restarting Pi rebuilds it from local source JSONL files.

## Migration compatibility

Migration selects sessions whose recorded project CWD is equivalent to the current Pi project CWD. On Windows, `C:\\Work\\app\\`, `C:/Work/app`, and differences only in path letter case are treated as the same project. Migrated sessions are written using the current Pi project CWD, so they appear under that project in `/resume`.

## Development

```bash
npm test          # core database, raw recall, importer, and migration regression suite
```
