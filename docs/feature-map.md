# pi-session-memory feature map

> **Implementation baseline:** package version `0.6.2` (raw transcript index and native migration only).

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
    Request[recall_memory or /memory-search] --> Search[Chinese and English literal topic entity search]
    Search --> Raw[Matching raw transcript turns]
    Search -->|No matches| ProjectRequest[recall_project_memory or /memory-project-search]
    ProjectRequest --> Resolve[Project name matches session CWD basename]
    Resolve --> ScopedSearch[Identical bilingual topic entities search resolved project sessions]
    ScopedSearch --> Raw
    Raw --> Fetch[fetch_session: optional read-only context]
```

## Feature inventory

| Area | Entry points | Behavior |
| --- | --- | --- |
| Incremental history sync | `session_start` | Imports new or changed Pi, Claude Code, and Codex transcript history. |
| Live Pi turn persistence | `agent_settled` | Writes the completed current Pi turn to SQLite. |
| Cross-session recall | `recall_memory`, `/memory-search` | Required first stage; searches ranked raw transcript turns using Chinese and English topic entities, capped by editable JSON configuration. |
| Named-project recall | `recall_project_memory`, `/memory-project-search` | Second-stage fallback only after no direct matches; resolves a named project's session CWDs, then searches only those sessions using identical bilingual topic entities. |
| Session expansion | `fetch_session` | Retrieves a requested stored turn range as read-only evidence. |
| Native migration | Migration commands and tools | Converts current-project Claude Code or Codex sessions into native Pi sessions for `/resume`, matching equivalent Windows CWD path formats. |
| Storage visibility and import | `get_memory_stats`, `backfill_memory` | Shows raw-index totals and explicitly imports historical transcript data. |

The SQLite database contains `sessions`, `turns`, and `source_files` for local transcript retrieval.
