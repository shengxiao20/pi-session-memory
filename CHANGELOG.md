# Changelog

## [1.0.1]

### Package presentation

- Highlights SQLite-backed search across scattered Pi, Claude Code, and Codex history, optional multi-agent analysis, and reusable evidence-based knowledge.
- Adds npm keywords for session memory, cross-session history, multi-agent discussion, SQLite, and knowledge management.
- Aligns the README introduction, website headline, and search and social descriptions with the package message.
- Clarifies that retrieval uses literal substring matching, not typo-tolerant fuzzy search or vector similarity.
- Emphasizes retrieving source evidence instead of relying on lossy summaries, while clarifying that the plugin complements rather than replaces Pi's context compaction.
- Keeps retrieval, Discussion, and storage behavior unchanged.

## [1.0.0]

Version 1.0 establishes the current product baseline. The previously published npm `latest` version was `0.7.23`.

### Project website

- Adds an original dark memory-ledger design with amber highlights, rounded feature cards, and a review timeline.
- Adds a responsive GitHub Pages landing page with feature summaries and setup instructions.
- Uses separate static HTML, CSS, JavaScript, and SVG assets without a frontend framework.
- Adds GitHub Actions deployment that uploads only the website directory.
- Adds website and clipboard tests while keeping the unpublished package version at 1.0.0.
- Presents independent Discussion and source-verification routing as a primary 1.0 architecture feature.
- Adds a prominent responsive routing diagram to the hero and architecture section.
- Highlights the multi-agent topology: one main agent and up to three user-confirmed historical Pi agents.
- Shows direct transcript review, sequential private Discussion, independent `fetch_session` verification, and cited output as distinct paths.
- Links the homepage to ADR 0001 for the complete decision and implementation evidence.

### Historical review workflow

- Adds saved-knowledge-first review for explicit requests to look back at earlier work.
- Adds description-only metadata inspection and exact saved-document reuse.
- Runs global and entity-discovered project retrieval through one `recall_memory` call.
- Requires a verbatim primary phrase for deterministic ranking and keeps global and project results separate.
- Adds exact `turn_id` context expansion with explicit `before` and `after` windows.
- Keeps System One filtering optional and provides a separate audit of filtered-out evidence.

### Discussion

- Uses English labels in the historical-session picker and consultation results.
- Keeps historical questions and replies in their original language.
- Adds optional private multi-agent consultation with user-confirmed historical Pi sessions.
- Runs historical participants sequentially in memory without modifying their source JSONL files.
- Adds private follow-up, explicit finish, and explicit cancellation tools.
- Keeps main-agent tool permissions unchanged and never treats participant agreement as verification.
- Keeps `fetch_session` available for independent source checks during Discussion without automatic fallback or route replacement.
- Documents the request-scoped routing contract, alternatives, and consequences in ADR 0001.

### OKF knowledge

- Adds draft OKF v0.2 output for transcript and consultation evidence routes.
- Stores portable meeting minutes, evidence files, an index, and an update log.
- Reduces minutes and evidence frontmatter to one meaningful `description` property.
- Requires findings, decisions, uncertainty, disagreements, open questions, and actions.
- Returns the exact saved document as the final historical-review response.
- Supports either the default knowledge root or one configured Obsidian vault as the storage root.

### Setup and configuration

- Adds `setup_memory` for a sequential one-question-at-a-time setup guide.
- Adds `configure_memory` for approved, validated, atomic configuration writes.
- Preserves unrelated top-level settings and rejects malformed configuration without fallback.
- Supports optional Discussion, System One filtering, managed or unmanaged endpoints, Obsidian storage, and a custom non-Obsidian knowledge root.
- Keeps credentials in environment variables and excludes setup from history operations and service checks.

### Index safety and context isolation

- Excludes current and retired package-tool turns from the searchable SQLite index.
- Adds explicit cleanup with a verified SQLite backup and exact whole-turn deletion.
- Preserves source JSONL, saved OKF files, session metadata, and source tracking during cleanup.
- Keeps large tool evidence in temporary model context while persisting lightweight tool records.
- Improves Pi branch ownership, incomplete-turn indexing, stable turn identities, and parser-version reindexing.

### Operations

- Adds native current-project Claude Code and Codex migration with source selection.
- Adds explicit history statistics and full backfill tools.
- Limits `/pi-session-memory` to setup, history import, project-session migration, and indexed-tool-turn cleanup.
- Removes Help, search, status, knowledge, consultation, and conclusion actions from the command menu.
- Uses Pi's native extension update display instead of custom release-note state.

### Difference from npm 0.7.23

- Expands the registered Agent tools from 6 to 15.
- Adds nine tools for setup, configuration saving, saved knowledge, Discussion, OKF finalization, and index cleanup.
- Replaces transcript-only recall with a complete knowledge-first evidence and conclusion workflow.
- Replaces the broad menu with four direct lifecycle operations; transcript review remains discoverable through Agent tools.
- Replaces accumulated README version narratives with current product documentation and this single 1.0 baseline.
