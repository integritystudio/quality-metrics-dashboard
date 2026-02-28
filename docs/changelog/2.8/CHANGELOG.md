# v2.8 Changelog

Agent-stats pipeline: backlog resolution, iterative code-review hardening, and `/agents` page.

## Backlog Items (from 45e425a code review)

### M1: Add explicit return type to `computeAgentActivity`
**Commit**: 61d5e4c
Added `AgentActivityEntry` interface and annotated function return type. -- `scripts/sync-to-kv.ts`

### M2: Preserve raw `totalOutputSize` to avoid round-trip rounding drift
**Commit**: 61d5e4c
`computeAgentActivity` now returns `totalOutputSize` alongside `avgOutputSize`. Cross-session accumulator uses raw total directly. -- `scripts/sync-to-kv.ts`

### L1: Update priority ordering comment to include `agent:` keys
**Commit**: 61d5e4c
Updated top-of-file comment to `meta/dashboard/agent > metrics > trends > traces`. -- `scripts/sync-to-kv.ts:12`

### D1: Live dev route for agent stats
**Commits**: 9e5343d, 52e4296
`GET /api/agents` and `GET /api/agents/:sessionId` routes in `src/api/routes/agents.ts`.

### D2: Period-based agent aggregation (`?period=24h|7d|30d`)
**Commit**: 52e4296
`?period=24h|7d|30d` query param on `GET /api/agents` with date-bucketed span filtering.

### D3: Per-agent evaluation summary (relevance, coherence, faithfulness)
**Commit**: 52e4296
Trace-to-agent join via `loadEvaluationsByTraceIds` batch lookup. Per-agent `evalSummary` with avg/min/max/count.

### D4: Daily invocation sparkline for agent detail
**Commit**: 52e4296
`dailyCounts[]` bucketed from `startTimeUnixNano`, rendered via `Sparkline` in `AgentActivityPanel.tsx`.

## Code-Review Fixes (iterative review loop)

### Strip `totalOutputSize` from session KV payloads
**Commit**: bf222df
Accumulator-only field stripped via destructure at serialization; retained in-memory for cross-session aggregation.

### Promote `AgentAccumulator` to module scope
**Commit**: bf222df
Moved from local `type` alias inside `main()` to module-scope `interface` alongside `AgentActivityEntry`.

### Replace unbounded `durations[]` with running sum/count
**Commit**: bf222df
`durationSum + durationCount` replaces per-span array allocation — O(1) memory per agent.

### Cap `sessionDurations` array for p95 computation
**Commit**: d208d20
`MAX_SESSION_DURATIONS` (10,000) constant bounds the array used for `percentile()`.

### Add JSDoc on `AgentAccumulator`
**Commit**: d208d20
Documents that the interface is in-memory only, never serialized to KV.

### Cap `acc.sessions` with recency-eviction
**Commits**: 3c56313, a96f146
`MAX_AGENT_SESSIONS` (100) cap with evict-oldest logic — ensures most recent sessions are retained regardless of `Map` iteration order. `totalSessionCount` and `lastSeenDate` tracked eagerly on accumulator.

### Non-mutating sorts on accumulator state
**Commits**: 3c56313, 75aec30
`slice().sort()` on both `sessionDurations` and `acc.sessions` to avoid in-place mutation. `localeCompare` replaced with plain `<`/`>` for locale-independent ISO 8601 ordering.

### Type `entry` against `AgentAccumulator['sessions'][number]`
**Commit**: 75aec30
Explicit annotation for compile-time safety at both `push` and eviction assignment sites.

## Agent Routes & Frontend Hardening

### `/agents` page with stats, eval summary, and sparklines
**Commit**: 52e4296
`AgentActivityPanel` with sortable table, expandable eval cards, daily sparkline, session/trace links. `useAgentStats` hook with period selector.

### Harden agent routes and types
**Commits**: 5183ff8, 767eaee, 4388919
- Remove unused `loadEvaluationsByTraceId` import; bulk-load via `loadEvaluationsByTraceIds`
- Strip user input from 400 error message (reflected content prevention)
- `traceIdsTotal` made optional; null-coalesced before subtraction
- `VALID_PERIODS` constant with 400 on invalid period; `MAX_IDS` cap; `KNOWN_SOURCE_TYPES` set

### Update README
**Commit**: 4388919
Added API routes table; updated KV priority string to include agent keys.
