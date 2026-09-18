# pi-session-memory feature map

> **Implementation baseline:** package version `0.6.0` (raw transcript index and native migration only).

## Architecture

```mermaid
flowchart LR
    Sources[Pi / Claude Code / Codex JSONL] --> Sync[Incremental history sync]
    Sync --> DB[(SQLite raw transcript index)]
    Host[Pi extension host] --> Recall[Cross-session recall]
    Recall <--> DB
    Host --> Migration[Native project-session migration]
    Migration --> Resume[Pi sessions for /resume]
```

## Recall flow

```mermaid
flowchart LR
    Request[recall_memory or /memory-search] --> Search[Literal entity search]
    Search --> Raw[Matching raw transcript turns]
    Raw --> Fetch[fetch_session: optional read-only context]
```

## Feature inventory

| Area | Entry points | Behavior |
| --- | --- | --- |
| Incremental history sync | `session_start` | Imports new or changed Pi, Claude Code, and Codex transcript history. |
| Live Pi turn persistence | `agent_settled` | Writes the completed current Pi turn to SQLite. |
| Cross-session recall | `recall_memory`, `/memory-search` | Searches and returns every matching raw transcript turn. |
| Session expansion | `fetch_session` | Retrieves a requested stored turn range as read-only evidence. |
| Native migration | Migration commands and tools | Converts current-project Claude Code or Codex sessions into native Pi sessions for `/resume`. |
| Storage visibility and import | `get_memory_stats`, `backfill_memory` | Shows raw-index totals and explicitly imports historical transcript data. |

The SQLite database contains `sessions`, `turns`, and `source_files` for local transcript retrieval.
