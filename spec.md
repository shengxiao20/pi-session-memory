# pi-session-memory — Spec

## Goal

A pi extension that persists every conversation turn to SQLite and exposes a
`recall_memory` tool so the LLM can retrieve relevant past turns when the user
references previous discussions.

## Architecture

```
pi turn_end event ──────────────────────────┐
                                             ▼
                                 Writer (src/writer.ts)
                                 - writes current pi turns
                                             │
/backfill command ────────┐                 │
                           ▼                 ▼
                    Source adapters → SQLite ~/.pi/agent/memory.db
                    - Pi JSONL        sessions + turns
                    - Claude JSONL
                    - Codex JSONL
                                             │
                                             ▼
                                 recall_memory tool
                                 - LLM supplies entities[]
                                 - LIKE substring match + hit-score ranking
                                 - returns top-5 turns
```

## Tables

### sessions
| column     | type    | note                          |
|------------|---------|-------------------------------|
| session_id | TEXT PK | native source session ID (UUID) |
| source     | TEXT    | `pi`, `claude`, or `codex`     |
| cwd        | TEXT    | working directory             |
| started_at | INTEGER | unix ms                       |
| model_id   | TEXT    | first model_change value      |
| jsonl_path | TEXT    | absolute path to source file  |

### turns
| column      | type    | note                                      |
|-------------|---------|-------------------------------------------|
| turn_id     | TEXT PK | `{session_id}:{user_message_id}` — stable across live write and backfill |
| session_id  | TEXT FK |                                           |
| turn_index  | INTEGER | display order within session; never used as identity |
| ts          | INTEGER | user message timestamp (unix ms)          |
| user_text   | TEXT    | user message content                      |
| reply_text  | TEXT    | assistant final text (all text blocks)    |
| tool_names  | TEXT    | JSON array e.g. `["bash","read"]`         |

There is intentionally no full-text virtual table. Retrieval uses escaped
SQLite `LIKE` against the complete `user_text` and `reply_text`, because literal
substring coverage and retrieval quality are prioritized over index performance.

## Write Path

Trigger: `agent_settled` event, after the agent run and any automatic
continuations have completed.

Steps:
1. Locate the latest user `SessionEntry` in `ctx.sessionManager.getBranch()` and
   use its stable entry ID as `user_message_id`; do not use pi's transient `turnIndex`.
2. Extract `user_text` from that user entry's text content blocks.
3. Walk branch entries after that user entry to collect assistant text blocks →
   `reply_text`, and toolCall names → `tool_names`.
4. Upsert source=`pi` session row (INSERT OR IGNORE).
5. Insert turn by stable ID (INSERT OR IGNORE — live writing and backfill target
   the same row).

## Retrieval Path (recall_memory tool)

### Tool Invocation Policy

- **Direct recall:** Call `recall_memory` immediately when the user explicitly
  asks to review, remember, summarize, continue, or compare a prior discussion
  about a topic.
- **Knowledge-gap recall:** When the user asks about a topic you cannot answer
  confidently from the current conversation and your general knowledge, but it
  may have been discussed in the user's past sessions, ask the user whether they
  want you to search their conversation history. Call `recall_memory` only after
  the user agrees.
- Do not search history merely because a question is difficult when the user has
  not indicated that their own prior work or discussions are relevant.

Input: `{ entities: string[] }` — 2-5 key terms extracted by LLM from user query.

Steps:
1. Build per-entity LIKE hit score:
   - `user_text` match = 2 points
   - `reply_text` match = 1 point
2. `SELECT ... WHERE (LOWER(user_text) LIKE ? OR LOWER(reply_text) LIKE ?) OR ...`
3. Escape `%`, `_`, and `\\` in every entity, then use `LIKE ? ESCAPE '\\'` so
   technical names containing LIKE wildcards remain literal substring matches.
4. `ORDER BY hits DESC, ts DESC LIMIT 5`

No FTS5 or write-time preprocessing. LIKE is a literal substring match after
escaping, so it does not lose substring matches through tokenization.

## Backfill

`/memory-backfill` scans and imports all historical records. All writes use
`INSERT OR IGNORE`, so it is safe and idempotent to run repeatedly.

| source | scan root | accepted user/assistant records | excluded records |
|---|---|---|---|
| pi | `~/.pi/agent/sessions/**/*.jsonl` | `message.role=user|assistant` | thinking, tool results, non-text content |
| claude | `~/.claude/projects/**/*.jsonl` | `type=user|assistant`, `message.role=user|assistant` | `isMeta`, sidechains, slash commands, local-command tags, continuation summaries, system/snapshot/attachments |
| codex | `~/.codex/sessions/**/*.jsonl` | `type=response_item`, `payload.type=message`, `role=user|assistant` | developer/system context, AGENTS.md and environment-context injection, IDE/image context, reasoning and tool events |

Each adapter outputs the common `ImportedSession` / `ImportedTurn` model.
Turns pair one accepted user message with all following accepted assistant text
until the next accepted user message. Each source adapter preserves the native
user-message ID (`pi entry.id`, Claude `uuid`, Codex `payload.id`) so rerunning
backfill never creates a duplicate of an already live-written pi turn.

## Acceptance Criteria

- A pi session with multiple user turns produces one distinct `turns` row per
  user message; no row is dropped because `turnIndex` restarts.
- Running backfill after live pi writing does not duplicate those pi turns.
- Claude and Codex injected context records listed above are absent from
  `turns.user_text`.
- Entity text containing `%`, `_`, or `\\` only matches its literal occurrence.
- Automated tests cover stable turn identity, LIKE escaping/ranking, and
  cross-source backfill parsing.

## File Structure

```
pi-session-memory/
├── spec.md
├── package.json
├── tsconfig.json
├── extensions/
│   └── index.ts       ← extension entry: tool + /memory-backfill
├── tests/
│   └── core.test.ts   ← persistence identity and literal-LIKE tests
└── src/
    ├── db.ts          ← DatabaseSync schema + upsert helpers
    ├── writer.ts      ← live pi turn_end writer
    ├── retriever.ts   ← LIKE query + hit-score ranking
    └── backfill.ts    ← Pi / Claude / Codex adapters and import runner
```

## Constraints

- Zero external dependencies (use `node:sqlite`, `node:fs`, `node:path`, `node:os`)
- Idempotent writes (INSERT OR IGNORE on turn_id)
- DB path: `~/.pi/agent/memory.db`
- No fallback / silent failure — let errors surface
