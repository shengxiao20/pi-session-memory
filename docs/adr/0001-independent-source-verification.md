# ADR 0001: Keep source verification independent from Discussion

- Status: Accepted
- Version: 1.0.0

## Context

A historical review can use two evidence routes after `recall_memory` finds candidate turns:

1. The transcript route returns recalled excerpts to the main agent.
2. Discussion asks user-confirmed historical Pi sessions to answer privately.

Discussion provides interpretation from earlier sessions. It does not replace the persisted source transcripts. The main agent can still need the exact surrounding transcript to check a participant claim, resolve ambiguity, or restore missing context.

Treating Discussion as a session-wide mode would remove useful main-agent tools. Automatically replacing a failed or incomplete Discussion with transcript retrieval would also hide an evidence-route change from the user.

## Decision

Discussion selects the output of one `recall_memory` request. It does not change the main agent's role, active tools, or permissions.

```text
Explicit historical-review request
└── recall_memory
    ├── Transcript route: Discussion disabled
    │   └── Return ranked transcript excerpts
    └── Consultation route: Discussion enabled
        └── Return private answers from user-confirmed Pi sessions

Independent main-agent verification
└── fetch_session(exact turn_id, smallest useful window)
    └── Read persisted transcript context without modifying the source
```

The following rules apply:

- `fetch_session` remains available to the main agent during an active Discussion.
- The main agent calls `fetch_session` only when an exact returned turn needs more context.
- Discussion does not automatically call `fetch_session`.
- A failed, cancelled, or incomplete Discussion does not automatically fall back to transcript retrieval.
- `fetch_session` does not replace participant answers. It supplies independent source evidence.
- Historical participants run sequentially, in memory, and without tools.
- Historical participants cannot modify their source JSONL files.
- `follow_up_session` privately clarifies one participant answer. It does not fetch transcript context.
- An active Discussion ends through `finish_session_consultation`, `cancel_session_consultation`, timeout, failure, or main-agent settlement.
- The transcript route ends through `finish_memory_recall` after the main agent compares the retrieved evidence.
- Participant agreement remains unverified until source evidence or other reliable evidence supports it.

## Why this matters

This separation keeps interpretation and verification distinct:

- Discussion answers: what selected historical sessions report.
- Transcript context: what the persisted source record contains.
- Main-agent conclusion: what the current agent can support after comparing the available evidence.

The user keeps control of participant selection. The main agent keeps control of source checks. Neither route silently changes into the other.

## Consequences

### Benefits

- The main agent can verify a consultant claim without ending Discussion.
- Consultation cannot reduce unrelated main-agent capabilities.
- Evidence-route changes remain explicit and observable.
- Source transcripts remain unchanged.
- Tests can validate routing and tool isolation separately.

### Costs

- The main agent must decide when additional transcript context is necessary.
- Consultation answers and fetched transcript context remain different evidence types.
- Callers must use the exact `turn_id` and the smallest useful context window.

## Rejected alternatives

### Disable `fetch_session` during Discussion

Rejected because Discussion is an evidence route for one recall request, not a global operating mode. Disabling the tool would prevent independent source verification.

### Automatically fetch transcripts after Discussion

Rejected because automatic fetching would replace the user-selected route and could expose more transcript context than needed.

### Automatically fall back when Discussion fails

Rejected because silent fallback would conceal a material change in evidence provenance. The failure remains visible so the user or main agent can choose the next action.

## Implementation evidence

- [`src/presentation/consultation-guidance.ts`](../../src/presentation/consultation-guidance.ts) states that Discussion is request-scoped and keeps independent tool calls available.
- [`extensions/index.ts`](../../extensions/index.ts) registers `fetch_session` independently from consultation lifecycle tools.
- [`tests/consultation.test.ts`](../../tests/consultation.test.ts) verifies that `fetch_session` works during Discussion and that main-agent tools remain unchanged.
- [`tests/e2e.test.ts`](../../tests/e2e.test.ts) verifies the public tool contracts and historical-review flow.
