# Dashboard Backlog

Open items from code reviews and deferred work.

## Medium

#### M1: Add explicit return type to `computeAgentActivity`
**Priority**: P3 | **Source**: code-review of 45e425a
Return type is inferred from `Object.entries(acc).map(...)`. Add a named `AgentActivityEntry` type and annotate the function for contract clarity in a 1K-line file. -- `scripts/sync-to-kv.ts`

#### M2: Preserve raw `totalOutputSize` to avoid round-trip rounding drift
**Priority**: P3 | **Source**: code-review of 45e425a
Cross-session accumulator reconstructs total from `avgOutputSize * invocations`, but `avgOutputSize` is already `Math.round(total/n)`. Drift compounds across sessions. Fix: return raw `totalOutputSize` from `computeAgentActivity` and accumulate directly. -- `scripts/sync-to-kv.ts`

## Low

#### L1: Update priority ordering comment to include `agent:` keys
**Priority**: P4 | **Source**: code-review of 45e425a
Top-of-file comment (line 11) says `meta/dashboard > metrics > trends > traces` but `agent:` entries now route to the same bucket as metrics. Update to `meta/dashboard/agent > metrics > trends > traces`. -- `scripts/sync-to-kv.ts:11`

## Deferred (from plan)

#### D1: Live dev route for agent stats (`src/api/routes/agents.ts`)
**Priority**: P3 | **Source**: agent-stats plan
No frontend consumer yet; attribute filter mismatch risk with local dev backend. Defer until dashboard page is built.

#### D2: Period-based agent aggregation (`?period=24h|7d|30d`)
**Priority**: P3 | **Source**: agent-stats plan
Significant complexity for v1. Current implementation uses full 30d window.

#### D3: Per-agent evaluation summary (relevance, coherence, faithfulness)
**Priority**: P3 | **Source**: agent-stats plan
Requires trace-to-agent join logic not yet available.

#### D4: Daily invocation sparkline for agent detail
**Priority**: P4 | **Source**: agent-stats plan
Nice-to-have visualization, not essential for v1.
