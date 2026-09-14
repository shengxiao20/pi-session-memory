# pi-session-memory

[![npm version](https://img.shields.io/npm/v/pi-session-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-session-memory)
[![Pi package](https://img.shields.io/badge/Pi-package-6B5BFF)](https://pi.dev/packages)

A local-first Pi extension that saves completed conversations to SQLite and gives the agent a `recall_memory` tool for retrieving relevant discussions from previous Pi, Claude Code, and Codex sessions.

## Features

- Persists completed Pi conversations in `~/.pi/agent/memory.db`.
- Automatically imports only new or changed Pi, Claude Code, and Codex session files when Pi starts.
- Supports a forced full rescan with `/memory-backfill`.
- Exposes `recall_memory`, allowing Pi to retrieve relevant prior discussions when users explicitly refer to earlier work.
- Uses stable native user-message IDs and `INSERT OR IGNORE`, making live persistence and backfill idempotent.
- Searches literal substrings with escaped SQLite `LIKE` patterns, including technical terms containing `%`, `_`, or `\\`.
- Uses only Node.js built-ins and SQLite (`node:sqlite`); no external runtime dependencies.

## Installation

```bash
pi install npm:pi-session-memory@0.1.4
```

To try the package without installing it permanently:

```bash
pi -e npm:pi-session-memory@0.1.4
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

### Recall prior work

The extension instructs Pi to call `recall_memory` when a user explicitly asks about a previous discussion, for example:

```text
What did we decide about LangGraph last time?
```

```text
回顾一下我们开发历史中关于 Joule 的内容
```

The tool searches prior user prompts and assistant responses, ranks matches by entity hits, and returns the five most relevant turns.

## How it works

```text
Pi startup ──► incremental source sync ──► SQLite memory.db ◄── completed Pi agent run
                                                  ▲
                                                  │
                                           recall_memory
                                                  │
                                      Pi / Claude / Codex
```

After a Pi agent run settles, the extension captures the latest user message and the subsequent assistant replies/tool names from the active session branch. Historical imports normalize each supported source into the same session/turn schema.

The database stays on the local machine at:

```text
~/.pi/agent/memory.db
```

## Privacy

Conversation data is stored and queried locally. This package does not add a remote storage service or transmit conversation history on its own. Review the source and your model provider's configuration before using it with sensitive conversations.

## Development

```bash
npm test
```
