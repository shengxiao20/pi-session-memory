# Native Claude Code/Codex-to-Pi Project Session Migration — Spec

## Goal

Allow a user to convert each historical Claude Code or Codex session for the active project into a separate, native Pi session that can be selected through Pi `/resume` and continued normally.

This is distinct from SQLite historical import and `recall_memory`:

- Native migration writes Pi session JSONL files for direct continuation in Pi.
- `recall_memory` searches local SQLite excerpts and does not restore a client session.

## Design

- Export `migrateClaudeProjectSessions(cwd)` and `migrateCodexProjectSessions(cwd)` from `src/session-migration.ts`.
- Both source wrappers use one source-parameterized migration pipeline to keep Pi v3 writing, output naming, error isolation, and idempotence consistent.
- Scan Claude Code JSONL under `~/.claude/projects` and Codex JSONL under `~/.codex/sessions`.
- Select only sessions with `session.cwd === cwd`.
- Create one Pi v3 session JSONL per source session under Pi's default session directory for that cwd.
- Name migrated sessions `Migrated from Claude Code: <session-id>` or `Migrated from Codex: <session-id>` so they are recognizable in `/resume`.
- Convert user and assistant textual messages only.
  - Claude Code excludes client-injected context, meta, and sidechain records.
  - Codex excludes system/developer prompts, reasoning, tool calls, and tool results.
- Require each converted text message to have a stable source-native ID; record an issue instead of fabricating an ID.
- Use source-namespaced deterministic output file names and skip an already migrated source session, making reruns idempotent.
- Register both user commands and Pi tools with descriptions that state this is native continuation, not ordinary recall:
  - Claude Code: `/project-claude-session-migration`, `migrate_claude_project_sessions`
  - Codex: `/project-session-migration`, `migrate_codex_project_sessions`

## Acceptance criteria

1. Each current-project Claude Code and Codex fixture produces one independently resumable Pi session with the expected user/assistant message sequence.
2. A source session from another project is not migrated.
3. A second migration skips existing output session files.
4. A malformed source file or a textual message without a stable native ID becomes an isolated issue and does not block other sessions.
5. Claude and Codex output paths cannot collide when their native session IDs match.
6. `npm test` and `git diff --check` pass.
