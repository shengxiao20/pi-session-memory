# Agent capability

## Release notes

`/pi-session-memory-whats-new` shows the maintained release notes for the installed package version. On the first Pi session after an upgrade, the extension displays those notes once and records the shown version under `~/.pi/agent/pi-session-memory/whats-new.json`.

## Cross-session transcript recall

`recall_memory` searches locally indexed raw transcript turns from Pi, Claude Code, and Codex. It is on demand: history is never automatically injected into the model context.

Use 2–8 specific literal topic entities, including equivalent Chinese and English terms. Entities are OR alternatives; project directory, source, and time filters are strict scope filters. Results are ordered by literal-entity score and recency, then capped by the single editable `recallLimit` value in `~/.pi/agent/pi-session-memory/config.json`.

## Named-project recall

`recall_project_memory` is a strict second-stage fallback. First call `recall_memory`; call named-project recall only when that direct search returns no turns. This supports cross-workspace questions where the named project's historical sessions may refer to it only as “this project” and omit its name.

- Put the project directory name in `project`; it only exactly matches the final directory component of stored session CWDs.
- Pass the **identical Chinese-and-English topic entities** from the zero-result `recall_memory` call in `entities`; they search turns only after the project sessions are resolved.
- **Never repeat `project` in `entities`**, because the project name can be absent from its own transcript.
- If no project-scoped topic turn matches, the result contains recent session candidates for the resolved project. Use `fetch_session` to inspect the smallest useful range.

For “How is pi-session-memory’s database designed?”, first call `recall_memory` with `entities: ["数据库", "database"]`. Only if it returns no matches, call `recall_project_memory` with `project: "pi-session-memory"` and the identical entities, never `pi-session-memory` as an entity.

```text
recall_memory(Chinese + English topic entities)
  -> matching raw transcript turns -> fetch_session only when an excerpt lacks necessary context
  -> no matches -> recall_project_memory(project metadata + identical entities)
                   -> project-scoped turns or candidates -> fetch_session as needed
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
| `/memory-search <Chinese topic> \| <English topic>` | Required first-stage search of raw locally indexed history with equivalent bilingual topics. |
| `/memory-project-search <project> -- <Chinese topic> \| <English topic>` | Second-stage fallback after the direct search has no matches, reusing identical bilingual topics; the project only scopes session CWD matching. |
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
