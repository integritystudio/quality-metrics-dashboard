# Dashboard Backlog

Open items from code reviews and deferred work.

## Medium

#### ~~M1: Add explicit return type to `computeAgentActivity`~~ Done
**Priority**: P3 | **Source**: code-review of 45e425a (feat: agent-stats)
Added `AgentActivityEntry` interface and annotated function return type. -- `scripts/sync-to-kv.ts`

#### ~~M2: Preserve raw `totalOutputSize` to avoid round-trip rounding drift~~ Done
**Priority**: P3 | **Source**: code-review of 45e425a (feat: agent-stats)
`computeAgentActivity` now returns `totalOutputSize` alongside `avgOutputSize`. Cross-session accumulator uses raw total directly. -- `scripts/sync-to-kv.ts`

## Low

#### ~~L1: Update priority ordering comment to include `agent:` keys~~ Done
**Priority**: P4 | **Source**: code-review of 45e425a (feat: agent-stats)
Updated top-of-file comment to `meta/dashboard/agent > metrics > trends > traces`. -- `scripts/sync-to-kv.ts:12`

## Deferred (from plan)

#### D1: Live dev route for agent stats (`src/api/routes/agents.ts`)
**Priority**: P3 | **Source**: agent-stats plan, deferred in 45e425a
No frontend consumer yet; attribute filter mismatch risk with local dev backend. Defer until dashboard page is built.

#### D2: Period-based agent aggregation (`?period=24h|7d|30d`)
**Priority**: P3 | **Source**: agent-stats plan, deferred in 45e425a
Significant complexity for v1. Current implementation uses full 30d window.

#### D3: Per-agent evaluation summary (relevance, coherence, faithfulness)
**Priority**: P3 | **Source**: agent-stats plan, deferred in 45e425a
Requires trace-to-agent join logic not yet available.

#### D4: Daily invocation sparkline for agent detail
**Priority**: P4 | **Source**: agent-stats plan, deferred in 45e425a
Nice-to-have visualization, not essential for v1.