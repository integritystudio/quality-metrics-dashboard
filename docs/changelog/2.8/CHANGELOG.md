# v2.8 Changelog

Post-commit review fixes for `scripts/sync-to-kv.ts` agent-stats pipeline.

## Completed

### M1: Add explicit return type to `computeAgentActivity`
**Source**: code-review of 45e425a (feat: agent-stats)
Added `AgentActivityEntry` interface and annotated function return type. -- `scripts/sync-to-kv.ts`

### M2: Preserve raw `totalOutputSize` to avoid round-trip rounding drift
**Source**: code-review of 45e425a (feat: agent-stats)
`computeAgentActivity` now returns `totalOutputSize` alongside `avgOutputSize`. Cross-session accumulator uses raw total directly. -- `scripts/sync-to-kv.ts`

### L1: Update priority ordering comment to include `agent:` keys
**Source**: code-review of 45e425a (feat: agent-stats)
Updated top-of-file comment to `meta/dashboard/agent > metrics > trends > traces`. -- `scripts/sync-to-kv.ts:12`

### D1: Live dev route for agent stats
**Source**: agent-stats plan, deferred in 45e425a | **Resolved**: 9e5343d, 52e4296
`GET /api/agents` and `GET /api/agents/:sessionId` routes in `src/api/routes/agents.ts`. Initial route added in 9e5343d (multi-agent visualization), expanded with full aggregation in 52e4296.

### D2: Period-based agent aggregation (`?period=24h|7d|30d`)
**Source**: agent-stats plan, deferred in 45e425a | **Resolved**: 52e4296
`?period=24h|7d|30d` query param on `GET /api/agents` with date-bucketed span filtering. -- `src/api/routes/agents.ts:15-16`

### D3: Per-agent evaluation summary (relevance, coherence, faithfulness)
**Source**: agent-stats plan, deferred in 45e425a | **Resolved**: 52e4296
Trace-to-agent join via `loadEvaluationsByTraceIds` batch lookup. Per-agent `evalSummary` with avg/min/max/count per metric. -- `src/api/routes/agents.ts:78-107`

### D4: Daily invocation sparkline for agent detail
**Source**: agent-stats plan, deferred in 45e425a | **Resolved**: 52e4296
`dailyCounts[]` bucketed from `startTimeUnixNano`, rendered via `Sparkline` component in `AgentActivityPanel.tsx:233-267`.
