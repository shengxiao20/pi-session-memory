# Changelog

## [2.0.10]

### One OKF knowledge root

- Replaces Obsidian-specific storage settings and
  `consultation.knowledgePath` with independent top-level `knowledgePath`.
- Uses the complete absolute root without appending a subdirectory.
  An omitted path retains the existing default knowledge root.
- Shares one root across transcript conclusions, private consultation
  minutes, and saved knowledge reading. A custom root does not require
  consultation settings or a timeout.
- Rejects retired fields during runtime reads. Approved saves remove them;
  no automatic path conversion, document migration, or duplicate output runs.
- Keeps OKF draft metadata, separate evidence, citations, navigation,
  publication rollback, and exact saved-document replies unchanged.
- Updates the shared 11-field editor, sequential Agent setup, tool guidance,
  path-redacted status, documentation, and targeted prompt contracts.
- Removes the Environment entry from direct configuration editing.
  Runtime shell overrides and Agent setup metadata remain available.
- Shows `now: value` in configuration rows. Saved values replace default
  labels; unset fields show existing defaults or default descriptions.
  Values remain complete, and successful edits refresh the rows.
  Saving, validation, default initialization, and Esc behavior are unchanged.
- Adds storage tests for all modes, both evidence routes, explicit errors,
  in-place repair, omitted optional values, and unchanged documents.
- Leaves retrieval, Jev, participant selection, and source JSONL unchanged.
  Does not publish or deploy.

## [2.0.9]

### Recall delivery modes

- Replaces `enableDiscussion` with `recallMode`: `choice`, `normal`, or
  `discussion`. An omitted mode defaults to `choice`.
- In `choice`, asks after each completed global/project recall through
  Pi's native terminal menu. Shows deduplicated counts and route help.
- Keeps choices request-local. Esc cancels without returning evidence or
  opening agents. Non-interactive choice raises a clear error.
- Preserves transcript output in `normal` and confirmed private agents
  in `discussion`. Neither a missing timeout nor an empty participant
  set silently selects normal.
- Rejects the retired switch during runtime reads. Approved editor or
  Agent-assisted saves remove it; no automatic conversion or write runs.
- Adds a three-value selector to the shared 13-field configuration editor
  and updates Agent setup, tool guidance, status, and contract tests.
- Leaves `fetch_session`, result limits, ranking, Jev review, deduplication,
  participant thresholds, main tools, and source JSONL behavior unchanged.
- Updates local version, documentation, and source-reviewed file counts.
  Does not publish or deploy.

## [2.0.8]

### Recall input validation

- Removes the two-to-eight entity count bounds from `recall_memory`,
  `review_jev_filtered`, and shared runtime validation.
- Allows punctuation-only entities, including `?` and `？`, in the full
  recall workflow. Project discovery returns no matches when entities
  have no letter or number tokens instead of raising a validation error.
- Preserves non-empty string checks, required primary-entity membership,
  and the case-insensitive verbatim phrase check against the question.
- Keeps result limits, ranking, Jev review, project matching, duplicate
  removal, consultation, and source-history behavior unchanged.
- Tests one and seventeen entities, both tool schemas, punctuation in
  user and assistant text, mixed project tokens, and retained errors.
- Updates only the approved recall and review tool contract fingerprints.
- Updates the README, website version, and native Extension Updates notes.
  Does not publish or deploy.

## [2.0.7]

### Agentic setup menu

- Renames the command menu's `Setup` action to `Agentic setup`.
- Shows `Agentic setup` before `Edit configuration`.
- Keeps the same Agent request and approval-based configuration workflow.
- Tests the menu order, setup request, and unchanged no-write boundary.
- Updates the README, website version, and native Extension Updates notes.
  Does not publish or deploy.

## [2.0.6]

### Prompt lint and formatting

- Adds `npm run format` to format only `prompts/` with Prettier.
- Adds `npm run lint` to check ESLint rules and Prettier formatting.
- Enforces 80 characters per TypeScript line, including strings, templates,
  URLs, and comments. Wraps Markdown prose at 80 characters.
- Splits long prompt literals without changing runtime text, whitespace,
  registered tool metadata, complete schemas, or model/response formats.
- Reflows the Markdown setup guide without changing wording or steps.
  Preserves raw-text and pre-format wording fingerprints.
- Runs lint before `npm test`. Tests reject long lines without exclusions
  and verify the guide's unchanged wording and installed package resources.
- Keeps lint dependencies in development only. Does not change runtime
  logic, rewrite other source files, publish, or deploy.
- Updates the README, website version, and native Extension Updates notes.

## [2.0.5]

### Centralized prompt resources

- Moves tool descriptions, snippets, guidelines, parameter descriptions, configuration help, flow rules, and model prompts into `prompts/`.
- Moves the sequential setup guide to `prompts/setup.md`. Keeps its content unchanged.
- Uses named TypeScript exports and static imports. Keeps tool registration, complete schemas, validation, TUI logic, and service behavior at their existing call sites.
- Preserves existing notice exports through re-exports. Missing resources raise errors without default text or template-parser fallback.
- Packages all shared resources and declares `pi.prompts: []`. Internal Markdown does not register extra slash commands.
- Adds pre-extraction text fingerprints, model-format checks, archive-import checks, missing-resource tests, and prompt dependency checks.
- Keeps the static architecture map scoped to the entry point and `src/`. Notes that shared prompt resources are omitted; dependency tests cover the full source and prompt graph.
- Updates the README, static website, npm version, and native Extension Updates notes. Does not publish or deploy.

## [2.0.4]

### Compact, immediate configuration editing

- Removes Save, Cancel, and the extra confirmation dialog from the direct editor.
- Saves each valid field immediately when the user submits its value. Esc keeps a field unchanged or leaves the menu.
- Keeps previously saved fields when the user exits. Rejects invalid input and concurrent configuration changes without overwriting settings.
- Shortens both command-menu labels and field rows. Separates variable names from aligned `(optional)` or `(required)` and `(default: value)` metadata.
- Indents nested variables. Moves current values and full requirements into the field dialog.
- Keeps strict conditional validation. Users configure connection details or the vault path before enabling the dependent setting.
- Preserves final approval for Agent-assisted setup, atomic saves, unknown top-level settings, and the no-service/no-history boundary.
- Updates editor tests, documentation, website, npm version, and native Extension Updates notes. Does not publish or deploy.

## [2.0.3]

### Direct configuration editor

- Adds **Edit configuration** to `/pi-session-memory`. Shows all 13 supported fields, current values, defaults, and optional/required conditions.
- Uses native Pi field dialogs and an in-memory draft. Validates the complete proposal and requires explicit confirmation before saving.
- Provides editor proposals of `20` for `recallLimit` and `120000` for `consultation.timeoutMs`; neither is a runtime default.
- Shares field metadata with `setup_memory`. Reuses `configure_memory` for Agent-assisted editing after final approval.
- Saves `consultation.turnThreshold` with default `5`. The existing environment variable overrides it and retains strict validation.
- Applies complete replacement of supported settings, including removal of omitted optional settings. Preserves unrelated top-level keys.
- Serializes configuration writes with Pi's per-file mutation queue. Rejects a stale editor draft if configuration changes before saving.
- Keeps environment variables and credentials outside JSON. Editing does not read credential values, start services, import history, or run consultation.
- Removes retired documentation, figure dependencies, and publication declarations. Keeps source-behavior tests and adds package-resource checks.
- Updates the README, setup guide, static website, source-map file counts, native Extension Updates notes, and npm version.
- Does not migrate history, publish the package, or deploy the website.

## [2.0.2]

### Historical-session turn threshold

- Removes the three-session candidate cap from Discussion.
- Adds `PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD`, an environment-only exclusive threshold with default `5`.
- Admits every historical native Pi session with more than the threshold's number of unique returned turns.
- Counts only this recall's turns after optional Jev filtering and exact turn-ID deduplication. Retrieval-stage limits remain unchanged.
- Accepts `0` to admit every session with at least one returned turn. Invalid, empty, fractional, negative, or unsafe values raise errors.
- Keeps all eligible candidates initially selected and opens only user-confirmed sessions. Adds a scrollable candidate window and per-session counts.
- Preserves the active-main-session exclusion, sequential private requests, tool-free participants, source JSONL, and cleanup behavior.
- Adds threshold boundary, duplicate-count, multi-session activation, invalid-input, and TUI viewport tests.
- Updates the README, setup guide, architecture figures, website, native Extension Updates notes, and npm version.
- Does not change JSON configuration keys, migrate history, publish the package, or deploy the website.

## [2.0.1]

### Focused meeting navigation

- Lists only `minutes.md` in new meeting indexes. Retains all evidence files, structured sources, and Sources footnotes.
- Validates immediate local evidence references, file types, evidence concept metadata, and duplicate source IDs or targets.
- Rejects missing evidence, unsafe paths, symlinks, and unlisted files or directories. Evidence filenames do not bypass validation.
- Applies evidence validation to meeting reads, meeting-directory inspection, and direct meeting discovery in topic catalogues.
- Keeps evidence bodies out of catalogue results. Preserves source JSONL, SQLite history, configuration, and historical-review routing.
- Adds tests for both evidence routes, empty sources, source integrity, and navigation without duplicate evidence entries.
- Updates the README, architecture guide, native Extension Updates notes, npm version, and website version label.
- Does not automatically rewrite existing indexes, migrate knowledge, or publish the package.

## [2.0.0]

### Breaking: OKF concepts and topic navigation

- Requires `title`, `topic_path`, ordered `topic_summaries`, and `tags` in both finish-tool conclusions.
- Adds required concept `type`, draft status, producer/version, write time, and structured sources to minutes and evidence.
- Joins claim footnotes to source IDs and rejects unknown citations. Does not mark discussion agreement as verified.
- Uses explicit lowercase kebab-case topic paths, without current-directory inference, automatic renaming, or storage fallback.
- Generates per-directory indexes with display titles and descriptions. Only the bundle-root index contains version frontmatter.
- Groups root log updates by ISO dates, newest first.
- Adds progressive directory inspection and path-based `concept_id`, while retaining stable meeting IDs and exact saved-document reuse.
- Accepts unknown concept types and extension keys. Reports missing optional summaries and metadata/index mismatches without inventing values.
- Rejects unsafe paths, symlinks, duplicate meeting IDs, missing published indexes, and inconsistent directory listings.
- Separates metadata, layout, indexes, publication, and output composition into focused modules. Failed publication rolls back completed changes.
- Stores Obsidian knowledge under `<vault>/pi-session-memory/`, without changing unrelated vault-root notes.
- Does not migrate or automatically delete legacy knowledge. Obsolete bundles require explicit user-directed removal.
- Updates the README, setup guide, architecture documentation, native Extension Updates notes, unit tests, and SDK integration tests.
- Preserves source JSONL, SQLite history, configuration keys, and request-scoped historical-review routing. Publishing remains a separate action.
- Adds a Chinese monochrome entity-level architecture figure with square frames, orthogonal connectors, and SVG, PDF, and PNG exports.

## [1.1.2]

### CodeGraph architecture documentation

- Adds a shared CodeGraph Map illustration to the README and GitHub Pages, covering nine source module groups and 35 TypeScript files.
- Saves a sanitized Map snapshot with declared relationships and a separately verified dynamic history import.
- Separates source dependencies from historical-review participation and routing.
- Documents module responsibilities, type-only dependencies, foundation boundaries, and explicit map refresh steps.
- Adds source-to-snapshot and snapshot-to-SVG consistency checks, plus website map accessibility and navigation checks.
- Packages the architecture SVG and evidence snapshot with the existing source architecture guide.
- Preserves public tools, commands, configuration, and runtime behavior. Publishing and website deployment remain separate actions.

## [1.1.1]

### Domain organization

- Groups source modules by history, settings, relevance, recall, knowledge, presentation, consultation, and setup responsibilities.
- Extracts shared transcript and consultation record types into `src/contracts/` to remove reverse implementation dependencies.
- Keeps `extensions/index.ts` as the Pi entry point and preserves existing tools, commands, and review behavior.
- Updates internal imports, tests, and the packaged setup-guide path for the new directories.
- Adds an architecture test for domain boundaries, import targets, and dependency cycles.
- Documents module responsibilities and invocation relationships in the README and source architecture guide.
- Excludes `.github/`, `scripts/`, `site/`, and `sites/` from the repository's CodeGraph index while retaining tests.
- Leaves Git tracking, npm packaging, and SQLite transcript indexing unchanged.

## [1.1.0]

### Pi-only history

- Removes Claude Code and Codex JSONL parsers and SQLite imports.
- Removes Claude Code and Codex project-session migration and its Agent tool and command-menu action.
- Aligns maintained history with Discussion, which currently activates participants from native Pi sessions.
- Avoids maintaining external session formats that Discussion cannot activate directly.
- Restricts session, source-file, retrieval, and project metadata types to native Pi history.
- Deletes existing non-Pi rows when an older SQLite index opens.
- Updates tests, setup guidance, package metadata, and website content for Pi-only support.

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
