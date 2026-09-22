/** Static user-facing overview displayed by the pi-session-memory helper command. */
export const SESSION_MEMORY_HELP = `pi-session-memory

This extension indexes local Pi, Claude Code, and Codex transcript history for on-demand cross-session retrieval.

Recall past discussions
- Ask what was discussed or decided about a specific topic.
- Pi searches local history only when needed, then reads the smallest useful session range.
- History is not injected automatically into context, and agent-generated summaries are not saved.

Migrate project sessions
- Run /project-claude-session-migration or /project-session-migration only when you explicitly want to continue current-project Claude Code or Codex sessions through Pi /resume.
- Each source session becomes a separate native Pi session.
- Equivalent Windows path spellings use the same project match; migrated sessions appear in the current project's /resume list.

What's New
- Run /pi-session-memory-whats-new to view release notes for the installed version. New release notes appear once when a new version first starts.

Local storage
- Run /memory-search <query> to search raw local transcript history.
- Run /memory-backfill only when you explicitly want to rescan all historical sessions.
- Run /memory-status to show indexed session and turn totals.
- Put persistent rules, preferences, and project instructions in AGENTS.md.

History stays in local SQLite. An import error in one source file does not prevent indexing sessions from other Pi, Claude Code, or Codex sources.`;
