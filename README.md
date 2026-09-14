# pi-session-memory

[![npm version](https://img.shields.io/npm/v/pi-session-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-session-memory)
[![Pi package](https://img.shields.io/badge/Pi-package-6B5BFF)](https://pi.dev/packages)

A local-first Pi extension that saves completed conversations to SQLite and gives the agent a `recall_memory` tool for retrieving relevant discussions from previous Pi, Claude Code, and Codex sessions.

> **Paper:** An accompanying arXiv paper is planned. [arXiv:XXXX.XXXXX](https://arxiv.org/abs/XXXX.XXXXX) *(placeholder; not published yet)*

## Features

- Persists completed Pi conversations in `~/.pi/agent/memory.db`.
- Imports historical session records from Pi, Claude Code, and Codex with `/memory-backfill`.
- Exposes `recall_memory`, allowing Pi to retrieve relevant prior discussions when users explicitly refer to earlier work.
- Uses stable native user-message IDs and `INSERT OR IGNORE`, making live persistence and backfill idempotent.
- Searches literal substrings with escaped SQLite `LIKE` patterns, including technical terms containing `%`, `_`, or `\\`.
- Uses only Node.js built-ins and SQLite (`node:sqlite`); no external runtime dependencies.

## Installation

```bash
pi install npm:pi-session-memory@0.1.0
```

To try the package without installing it permanently:

```bash
pi -e npm:pi-session-memory@0.1.0
```

## Usage

### Import existing history

Run this once after installation, and again whenever you want to scan newly available historical session files:

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
completed Pi agent run ───► SQLite memory.db ◄─── /memory-backfill
                                  ▲                     │
                                  │                     ▼
                           recall_memory         Pi / Claude / Codex
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

## Paper placeholder

```bibtex
@article{pi-session-memory-2026,
  title        = {Persistent Local-First Cross-Session Memory for Coding Agents},
  author       = {Anonymous},
  year         = {2026},
  eprint       = {XXXX.XXXXX},
  archivePrefix = {arXiv},
  primaryClass = {cs.AI},
  note         = {Placeholder; preprint forthcoming}
}
```

Replace the title, authors, arXiv identifier, and citation metadata after the preprint is submitted.
