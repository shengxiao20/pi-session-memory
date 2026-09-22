# Agent capability

## Cross-session transcript recall

`recall_memory` searches locally indexed raw transcript turns from Pi, Claude Code, and Codex. It is on demand: history is never automatically injected into the model context.

Use 2–8 specific literal entities. Entities are OR alternatives; project directory, source, and time filters are strict scope filters. Every matching turn is returned in the same tool result; there is no page limit or offset parameter.

```text
recall_memory
  -> matching raw transcript turns
  -> fetch_session only when an excerpt lacks necessary context
```

## `fetch_session`

Fetches an ordered range from a session returned by `recall_memory`.

- It is read-only source evidence.
- It reads only the requested source transcript range.
- Request the smallest useful inclusive turn range.
- Output includes the canonical source turn ID for reference.

## Manual commands

| Command | Purpose |
| --- | --- |
| `/memory-search <query>` | Search raw locally indexed transcript history. |
| `/memory-status` | Show indexed session and turn totals. |
| `/memory-backfill` | Explicitly rescan local Pi, Claude Code, and Codex history. |
| `/project-session-migration` | Convert current-project Codex sessions into native Pi `/resume` sessions. |
| `/project-claude-session-migration` | Convert current-project Claude Code sessions into native Pi `/resume` sessions. |

## Native project-session migration

Use `migrate_claude_project_sessions` or `migrate_codex_project_sessions` only when the user explicitly wants to continue a current-project source session in Pi. Each migrated source session becomes a separate native Pi session selectable through `/resume`.

Project matching is path-format aware. Equivalent Windows CWDs match despite slash direction, drive-letter/path letter case, or a trailing separator; migrated sessions use Pi's current project CWD so `/resume` lists them in the active project.

## Storage operations

- `get_memory_stats` reports raw history index totals.
- `backfill_memory` rescans local source JSONL only after an explicit user request.
- Deleting `~/.pi/agent/memory.db` deletes only the local index. On the next Pi startup, the extension recreates the raw-history schema and reimports available local JSONL history.

## Boundaries

The extension stores source transcript metadata and text required for retrieval. Search is on demand and never automatically injects history into model context. Durable user preferences, instructions, and project rules belong in `AGENTS.md`, not in this SQLite history index.
