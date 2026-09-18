# pi-session-memory

A local-first Pi extension for **on-demand cross-session transcript search** across Pi, Claude Code, and Codex, plus native project-session migration to Pi `/resume` sessions.

## What it does

- Indexes local Pi, Claude Code, and Codex JSONL transcript turns in local SQLite.
- Provides `recall_memory` for literal raw-history search that returns every match.
- Provides `fetch_session` for read-only expansion of the smallest useful transcript range.
- Synchronizes changed history at Pi session start; `/memory-backfill` performs an explicit full rescan.
- Migrates current-project Claude Code or Codex sessions into separate native Pi sessions.

Search results are derived from stored source transcripts only and are never automatically injected into model context. Put project rules and preferences in `AGENTS.md`.

## Commands

| Command | Description |
| --- | --- |
| `/pi-session-memory-helper` | Show cross-session search and migration help. |
| `/memory-status` | Show locally indexed session and turn totals. |
| `/memory-search <query>` | Search locally indexed raw transcript history. |
| `/memory-backfill` | Explicitly rescan historical Pi, Claude Code, and Codex JSONL. |
| `/project-session-migration` | Convert current-project Codex sessions for `/resume`. |
| `/project-claude-session-migration` | Convert current-project Claude Code sessions for `/resume`. |

## Agent tools

| Tool | Use when |
| --- | --- |
| `recall_memory` | The user explicitly asks about a prior discussion, or agrees to history search. Use 2–8 specific literal entities. |
| `fetch_session` | A recall excerpt lacks needed context. Fetch the smallest useful range. It is read-only. |
| `get_memory_stats` | The user asks how much local history is indexed. |
| `backfill_memory` | The user explicitly asks to import, backfill, or rescan history. |
| `migrate_codex_project_sessions` | The user wants to continue current-project Codex work through `/resume`. |
| `migrate_claude_project_sessions` | The user wants to continue current-project Claude Code work through `/resume`. |

## Flow

```text
session_start -> syncChangedHistory() -> SQLite raw transcript index
recall_memory -> matching raw transcript turns -> fetch_session (optional, read-only)
project migration command/tool -> native Pi session JSONL -> /resume
```

History remains on the local machine, by default in `~/.pi/agent/memory.db`. Deleting that database removes only the index; restarting Pi rebuilds it from local source JSONL files.

## Development

```bash
npm test          # core database, raw recall, importer, and migration regression suite
```
