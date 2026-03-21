# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### G5: Multi-Agent Workflow Visualization — Remaining Work

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-A | WorkflowTimeline swimlane component (per-agent horizontal lanes, handoff markers) | P3 | impl-g5 Phase 4 |
| G5-B | AgentWorkflowView dual-tab container (DAG / Timeline toggle with ARIA tablist) | P3 | impl-g5 Phase 5 |
| G5-C | Navigation link from AgentSessionPage to /workflows/:sessionId | P3 | impl-g5 Phase 5 |
| G5-D | Session list multi-agent badge (indicator on sessions with >1 agent) | P4 | impl-g5 Phase 5 |
| G5-E | Bundle size spike — verify workflow-viz chunk with `npx vite-bundle-visualizer` | P3 | impl-g5 v2.0 |

### G5: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-WG5 | Turns with undefined `agentName` are silently dropped — add observability counter | P4 | WG-5 |
| G5-WG9 | `durationMs` on WorkflowNode sums nested spans (double-counts wall time) — document or fix | P4 | WG-9 |
| G5-C1 | `agent.name` vs `gen_ai.agent.name` attribute key: route uses former, transformer uses latter — verify both attributes are present on real spans | P3 | WG-C1 |
| G5-M1 | `classifyShape` only detects pairwise back-edges; misses 3+ node cycles (A→B→C→A) — needs DFS cycle detection | P3 | WG-M1 |
| G5-M2 | `inferFromSpans` strict `<=` for edge inference misses near-concurrent spans — consider epsilon tolerance | P4 | WG-M2 |
| G5-M4 | `WorkflowEdge.handoffScore` typed as `number` but inferred edges use `0` — consider `number | null` to distinguish from real zero scores | P4 | WG-M4 |

