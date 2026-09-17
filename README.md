# pi-session-memory

[![npm version](https://img.shields.io/npm/v/pi-session-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-session-memory)
[![Pi package](https://img.shields.io/badge/Pi-package-6B5BFF)](https://pi.dev/packages)

A local-first Pi extension that saves completed conversations to SQLite and gives the agent a `recall_memory` tool for retrieving relevant discussions from previous Pi, Claude Code, and Codex sessions.

## Features

- Persists completed Pi conversations in `~/.pi/agent/memory.db`.
- Automatically imports only new or changed Pi, Claude Code, and Codex session files when Pi starts.
- Supports a forced full SQLite history rescan with `/memory-backfill`.
- Converts current-project Codex sessions into separate native Pi sessions with `/project-session-migration`, ready to select through `/resume`.
- Exposes `recall_memory`, allowing Pi to retrieve relevant prior discussions when users explicitly refer to earlier work.
- Uses stable native user-message IDs and `INSERT OR IGNORE`, making live persistence and backfill idempotent.
- Searches literal substrings with escaped SQLite `LIKE` patterns, including technical terms containing `%`, `_`, or `\\`.
- Ranks results by literal relevance and recency, boosts an explicitly scoped project, and limits results to two turns per session for diversity.
- Supports explicit durable memories, which remain after their source transcript turns are deleted.
- Suppresses a raw turn from recall when an active durable memory contains the same unchanged pinned source evidence; other turns in that session remain eligible.
- Associates recalled durable memories with later source-session activity and newer query-relevant evidence from the same or another session, so users can explicitly compare, confirm, or supersede them without silent updates.
- Includes status, direct search, and permanent deletion commands so users can inspect and control local memory.
- Uses only Node.js built-ins and SQLite (`node:sqlite`); no external runtime dependencies.

## Installation

```bash
pi install npm:pi-session-memory
```

This unpinned source can receive package-update checks at Pi startup. After a new release, update it explicitly with:

```bash
pi update npm:pi-session-memory
# or update every unpinned Pi extension
pi update --extensions
```

Restart Pi after the update to load the new extension code.

To try the latest package without installing it permanently:

```bash
pi -e npm:pi-session-memory
```

To intentionally pin a known version (which `pi update --extensions` skips), add its version explicitly:

```bash
pi install npm:pi-session-memory@0.3.0
```

## Usage

### Import existing history

At Pi startup, the extension automatically scans the three source roots. It compares
per-file size and modification time to saved sync state; only new or changed JSONL
files are read and hashed with SHA-256 before import. Unchanged files are skipped.

Use this command when you intentionally want to force a full rescan of every
historical JSONL file:

```text
/memory-backfill
```

The command imports eligible user/assistant exchanges from:

| Source | Session location |
| --- | --- |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/*.jsonl` |

### Continue a Codex session natively in Pi

Use this command only when you want to continue prior **Codex** work as a real Pi session rather than search it as memory:

```text
/project-session-migration
```

It selects Codex JSONL files whose recorded `cwd` exactly equals the current project, then creates one independent Pi v3 session JSONL for each under Pi's normal session directory. Each migrated entry is named `Migrated from Codex: <session-id>`.

After the command completes, run:

```text
/resume
```

and select the migrated session to continue it in Pi. Existing migrated outputs are skipped on subsequent runs.

The converter preserves user and assistant text messages only. It deliberately does not convert Codex system/developer prompts, reasoning, tool calls, or tool results into Pi messages. Migration is separate from SQLite backfill and `recall_memory`; normal cross-client recall does not require migration.

#### Context compaction and retention

Compaction reduces what a running client sends to its model; it is not necessarily deletion of the local JSONL history. In locally observed Claude Code and Codex files, compaction is appended as a separate event (`system/compact_boundary` for Claude Code and `compacted` for Codex), while earlier user/assistant message records remain in the file and remain importable. This is observed behavior rather than a retention guarantee from those clients.

The extension indexes normalized user/assistant text and selected tool names, not every JSONL event. It intentionally excludes reasoning, full tool inputs/outputs, system/developer context, workspace state, Pi custom records, Claude compaction metadata, and Codex handoff summaries. See [`quick-notes/jsonl-schema.md`](quick-notes/jsonl-schema.md) for source-specific formats and the exact importer boundary.

### Recall prior work

The extension instructs Pi to call `recall_memory` when a user explicitly asks about a previous discussion, for example:

```text
What did we decide about LangGraph last time?
```

`recall_memory` is the discovery step: it searches and ranks the complete active durable-memory and raw-turn match set using the original request plus important entities. It supports optional exact project-directory, source, and time-window filters. Each tool response deliberately renders five results and reports `totalResults` and `nextOffset`; when more candidates are needed, Pi repeats the exact same query and filters with that explicit offset. This pages model context without silently limiting the local search. Raw transcript candidates contain a short excerpt plus a session ID and turn index, rather than the entire turn context. When surrounding conversation is needed to answer accurately, Pi calls `fetch_session` with that session ID and the smallest useful turn-index range. When an initial literal search is empty, Pi may make up to two additional local searches using reasoned alternatives—such as abbreviations, expansions, aliases, translations, or likely task wording—while retaining the original filters.

When recall returns a durable memory, Pi is instructed to naturally communicate a relevant remembered conclusion and provenance when useful. It reports later activity in the memory's source session separately from newer query-relevant evidence to compare; that evidence can come from the original session or another newer session. Pi compares the old memory with the evidence as a possible confirmation, supplement, conflict, or replacement, then asks whether you want to keep, confirm, or replace it. It never claims a memory was updated or superseded without your explicit choice.

### Inspect and control memory

Recall and freshness explanations are automatic model behavior. The commands below remain deliberate user-control actions for inspecting or changing stored memory; they are not required for normal recalled answers.

```text
/remember Keep SQLite writes local only
/memory-pin pi:<session-id>:<user-message-id>
/memory-list [decision]
/memory-confirm <memory-id>
/memory-supersede <old-memory-id> <new-memory-id>
/memory-history <memory-id>
/memory-forget <memory-id>
/memory-delete-turn pi:<session-id>:<user-message-id>
/memory-status
/memory-search SQLite migration
```

`fetch_session` is an agent tool, not a user command: Pi invokes it selectively after `recall_memory` when it needs additional context from a specific discovered session.

- `/remember <text>` saves an explicit durable `fact` scoped to the current project.
- `/memory-pin <turn-id>` promotes a historical turn to a durable fact and records its source session, source turn ID, and a hash of the pinned evidence.
- `/memory-list [kind]` displays durable memories, optionally limited to `preference`, `decision`, `fact`, `project_state`, `task`, or `lesson`.
- Recall distinguishes later activity in a memory's source session from newer query-relevant evidence to compare. That evidence may come from the original session or another newer session; it is a review signal, not an automatic update.
- `/memory-confirm <memory-id>` records that an active memory remains current by updating `last_confirmed_at`.
- `/memory-supersede <old-memory-id> <new-memory-id>` explicitly replaces an active memory while retaining the old record for history; superseded memories are excluded from normal recall.
- `/memory-history <memory-id>` displays the complete oldest-to-newest supersession chain.
- `/memory-forget <memory-id>` permanently deletes a durable memory without deleting its source transcript.
- `/memory-delete-turn <turn-id>` permanently deletes one raw turn; its session is also removed if it has no turns left.
- `/memory-status` reports turn and session totals, per-source distribution, and newest memory time.
- `/memory-search <query>` previews the same local literal retrieval used by the agent.

## How it works

```text
Pi / Claude Code / Codex history ──► incremental source sync ──► SQLite memory.db
                                                                  ▲
                                                                  │
                                                           recall_memory

Current-project Codex JSONL ──► /project-session-migration ──► native Pi session JSONL ──► /resume
```

After a Pi agent run settles, the extension captures the latest user message and the subsequent assistant replies/tool names from the active session branch. Historical imports normalize each supported source into the same session/turn schema.

The database stays on the local machine at:

```text
~/.pi/agent/memory.db
```

## Privacy

Conversation data is stored and queried locally. This package does not add a remote storage service or transmit conversation history on its own. Review the source and your model provider's configuration before using it with sensitive conversations.

## Release notes

| Version | Highlights |
| --- | --- |
| `0.3.0` | Replaces source-session-only freshness hints with provenance-linked evidence comparison across newer same-session and cross-session turns. This changes recall output and `freshness_candidate` semantics, but keeps tool inputs, slash commands, SQLite data, and explicit user-controlled memory mutation compatible; no migration is required. |
| `0.2.1` | Pages `recall_memory` results in explicit five-result `offset` windows while still evaluating the complete local match set; npm publishing now uses a runtime-file allowlist. |
| `0.2.0` | Added cross-client SQLite recall and durable-memory controls, plus native current-project Codex-to-Pi session migration for `/resume`. |
| `0.1.4` | Automatically syncs new or changed Pi, Claude Code, and Codex history when Pi starts; `/memory-backfill` forces a full rescan. |
| `0.1.3` | Improved package documentation and installation guidance. |
| `0.1.2` | Added the MIT license. |
| `0.1.1` | Added repository and package metadata for public distribution. |
| `0.1.0` | Initial release: local SQLite memory, Pi live persistence, historical import, and `recall_memory` retrieval. |

## Release compatibility review

Before every significant release, review these compatibility surfaces and record any migration or versioning decision:

1. **Install/package:** package name, Pi manifest, runtime dependencies, and published file allowlist.
2. **Persistent data:** SQLite schema/migrations, JSONL-import compatibility, and any data rewrite.
3. **Agent tools and commands:** tool names, input schemas, result/details contracts, and slash commands.
4. **Retrieval and agent behavior:** ranking, pagination, freshness/evidence semantics, prompt policy, and automatic side effects.
5. **Public TypeScript/module API:** exported types/functions and required result fields.

The `0.3.0` review found no installation, SQLite, command, or tool-input breaking change. It intentionally changes recall result semantics and adds evidence fields, so it is released as a minor `0.x` version rather than a patch.

## Development

```bash
npm test
```
