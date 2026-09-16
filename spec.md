# Native Codex-to-Pi Project Session Migration — Spec

## Goal

Allow a user to convert each historical Codex session for the active project into a separate, native Pi session that can be selected through Pi `/resume` and continued normally.

This is distinct from SQLite historical import and `recall_memory`:

- Native migration writes Pi session JSONL files for direct continuation in Pi.
- `recall_memory` searches local SQLite excerpts and does not restore a client session.

## Design

- Export `migrateCodexProjectSessions(cwd)` from `src/session-migration.ts`.
- Scan Codex JSONL sessions and select only sessions with `session.cwd === cwd`.
- Create one Pi v3 session JSONL per Codex session under Pi's default session directory for that cwd.
- Write a `Migrated from Codex: <session-id>` session name so it is recognizable in `/resume`.
- Convert user and assistant textual messages only. Do not represent Codex system/developer prompts, tool calls, or tool results as Pi conversation messages.
- Use deterministic output file names and skip an already migrated Codex session, making reruns idempotent.
- Register `/project-session-migration` for users and `migrate_codex_project_sessions` for Pi agents. Both descriptions must state that this is native Pi continuation, not ordinary recall.

## Acceptance criteria

1. Each current-project Codex fixture produces one independently resumable Pi session with the expected user/assistant message sequence.
2. Another project's Codex session is not migrated.
3. A second migration skips existing output session files.
4. A malformed source file becomes an isolated issue and does not block other sessions.
5. `npm test` and `git diff --check` pass.
