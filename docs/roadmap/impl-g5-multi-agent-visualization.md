# G5: Multi-Agent Workflow Visualization — Implementation Plan

**Version**: 1.1
**Date**: 2026-02-27
**Priority**: P3 | **Effort**: High
**Source**: [known-gaps.md](../../../docs/roadmap/known-gaps.md) G5, white paper S7.3
**Competitive bar**: Arize Phoenix auto-flowcharts (June 2025), Langfuse Agent Graphs (GA Nov 2025)
**Research validated**: 2026-02-27 — cross-platform comparison (Phoenix, Datadog, LangSmith, Langfuse) + library evaluation

---

## Design Decision

Build interactive graph and timeline views for multi-agent workflows. Validated against four industry platforms:

| Platform | Visualization | Key pattern |
|----------|--------------|-------------|
| **Arize Phoenix** (June 2025) | Auto-flowchart in Agents tab; graph abstracted over spans | Agent/tool/component as logical nodes, not raw spans |
| **Datadog** (June 2025+) | "Execution flow chart" with embedded metrics per node | Latency + tokens + eval scores inline on each node |
| **Langfuse** (GA Nov 2025) | Agent Graphs inferred from OTel timing/nesting | No explicit graph metadata required — inferred from spans |
| **LangSmith** | Span tree (production) + LangGraph Studio (static graph + execution overlay) | Separates static architecture view from dynamic execution trace |

The toolkit has the data layer; the gap is visualization. Langfuse's inference-from-spans approach is the most robust fallback when explicit `MultiAgentEvaluation` data is sparse.

---

## Current State

### Data layer (complete)

| Component | Location | Purpose |
|-----------|----------|---------|
| `MultiAgentEvaluation` | `src/lib/quality/quality-multi-agent.ts:69` | Handoff scores, turn-level results, error propagation |
| `HandoffEvaluation` | `src/lib/quality/quality-multi-agent.ts:32` | Source → target agent, correctTarget, contextPreserved, score |
| `TurnLevelResult` | `src/lib/quality/quality-multi-agent.ts:51` | Per-turn relevance, task progress, error flag |
| `computeMultiAgentEvaluation()` | `src/lib/quality/quality-multi-agent.ts:191` | Builds full evaluation from stepScores + agentMap |
| `computePipelineView()` | `src/lib/quality/quality-visualization.ts:65` | 4-stage funnel: ingested → scored → evaluated → alerted |
| `computeCoverageHeatmap()` | `src/lib/quality/quality-visualization.ts:183` | Metric × input coverage matrix |
| `analyzeTrajectory()` | `src/lib/agent-judge/agent-judge-verification.ts:406` | Tool call count, efficiency ratio, redundancy |
| `verifyToolCall()` | `src/lib/agent-judge/agent-judge-verification.ts:203` | Weighted tool verification (selection 40%, args 30%, result 30%) |
| `ProceduralJudge` | `src/lib/agent-judge/agent-judge-classes.ts:116` | Stage-based evaluation pipeline |
| `ReactiveJudge` | `src/lib/agent-judge/agent-judge-classes.ts:235` | Event-driven specialist routing |

### Dashboard infrastructure (partial)

Existing multi-agent components:

| Component | File | Current scope |
|-----------|------|---------------|
| `TurnTimeline.tsx` | `dashboard/src/components/` | Timeline of turns — no DAG |
| `HandoffCard.tsx` | `dashboard/src/components/` | Single handoff display |
| `SpanTree.tsx` | `dashboard/src/components/` | Nested span tree — not a DAG layout |

Existing API route:

`GET /api/agents/:sessionId` — returns `{ sessionId, spans, evaluation: MultiAgentEvaluation, evaluations, agentMap }`. Already computes the data needed for visualization.

Current dashboard dependencies: `recharts@^3.7`, `d3-scale@^4`, `d3-scale-chromatic@^3` — no graph layout library.

### Not implemented

- DAG visualization (agents as nodes, handoffs as directed edges)
- Interactive flowchart view (Phoenix-style)
- Node drill-down to agent-level detail
- Zoom/pan for complex graphs
- Single-agent graceful fallback in DAG view

---

## Library Decision: RESOLVED

**Decision**: `@xyflow/react` (ReactFlow v12) + ELKjs for layout.

React 19 compatibility confirmed October 2025. dagre is deprecated (2015 codebase). d3-dag is in light maintenance (maintainer recommends ReactFlow for interactive use cases).

| Criterion | @xyflow/react v12 | d3-dag v1.1+ | dagre | ELKjs |
|-----------|-------------------|-------------|-------|-------|
| **License** | MIT | Apache 2.0 | MIT | EPL 2.0 |
| **Bundle size (min+gz)** | ~150KB | ~30KB | ~30KB | ~100KB |
| **React 19** | Confirmed (Oct 2025) | No React dep | No React dep | No React dep |
| **Layout** | dagre (deprecated), ELK (plugin), custom | Sugiyama, Coffman-Graham | Sugiyama | Layered, force, orthogonal, stress, tree |
| **Interactivity** | Full: drag, zoom, pan, select, minimap | None | None | None |
| **Handles cycles** | Yes | No (DAG-only by definition) | Yes | Yes |
| **Maintenance** | Active (35.4K stars, release Feb 19 2026) | Light maintenance (1.5K stars) | Deprecated | Active (Eclipse/KIELER, 2.4K stars) |

**Dependencies to add** (lazy-loaded):

```json
"@xyflow/react": "^12.0.0",
"elkjs": "^0.9.0"
```

**Remaining spike** (before Phase 3): Measure bundle size delta with `npx vite-bundle-visualizer` to confirm lazy-loading eliminates impact on other pages. React 19 compat verification is no longer needed.

---

## Implementation Plan

### Phase 1: Graph data model

**File**: `dashboard/src/types/workflow-graph.ts` (new)

Named `WorkflowGraph` (not `WorkflowDAG`) because real agent executions are frequently cyclic — retry loops, reflection steps, tool-call-then-verify patterns. Both Langfuse and Datadog explicitly handle cycles.

```typescript
export type WorkflowShape = 'single_agent' | 'linear' | 'branching' | 'cyclic';

export interface WorkflowNode {
  id: string;                    // agent name or ID
  label: string;                 // display name
  evaluationScore: number | null;
  toolCallCount: number;
  totalTokens: number | null;    // token usage per agent (Datadog standard)
  durationMs: number;
  turnCount: number;
  hasError: boolean;
}

export interface WorkflowEdge {
  id: string;                    // `${source}->${target}`
  source: string;                // source agent id
  target: string;                // target agent id
  handoffScore: number;
  contextPreserved: boolean;
  label?: string;                // e.g. "score: 0.85"
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rootNodeId: string | null;     // first agent
  workflowShape: WorkflowShape;  // replaces boolean isMultiAgent
}
```

Transformer function: `buildWorkflowGraph(evaluation: MultiAgentEvaluation, agentMap: Map<number, string>, spans: Span[]): WorkflowGraph`

Fallback: when `MultiAgentEvaluation` is absent but `gen_ai.agent.*` spans exist, infer the graph from span parent/child relationships and timing (Langfuse pattern).

### Phase 2: API extension

**File**: `dashboard/src/api/routes/agents.ts`

Extend `GET /api/agents/:sessionId` response to include `graph: WorkflowGraph`:

```typescript
// After existing computation:
const graph = buildWorkflowGraph(evaluation, agentMap, spans);
return c.json({ sessionId, spans, evaluation, evaluations, agentMap, graph });
```

No new routes needed — the existing endpoint already returns all required source data.

### Phase 3: Graph visualization component

**File**: `dashboard/src/components/WorkflowGraph.tsx` (new)

**Depends on**: Bundle size spike only (library decision resolved — ReactFlow + ELKjs)

Props:

```typescript
interface WorkflowGraphProps {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;  // drill-down to agent detail
  height?: number;
}
```

Layout via ELKjs (not the deprecated built-in dagre):

```typescript
import ELK from 'elkjs/lib/elk.bundled.js';
const elk = new ELK();
// elk.algorithm: 'layered', elk.direction: 'DOWN'
// ELKjs handles cycles gracefully via back-edge routing
```

Requirements:
- Render agents as custom ReactFlow nodes with: name, score badge, tool call count, token count, duration
- Render handoffs as directed edges with: score, context-preserved indicator
- Color-code nodes by score (green/yellow/red using existing `ScoreBadge` thresholds)
- Score indicators include text label (not color-only) for WCAG 1.4.1
- Color-code edges by handoff score
- Zoom/pan controls for graphs with 5+ nodes
- `<MiniMap />` component for graphs with 5+ nodes (built-in ReactFlow, zero effort)
- Hover tooltip with full evaluation details
- Click node → navigate to agent detail (existing route)
- Keyboard navigation: nodes focusable via Tab, operable via Enter
- Container has `role="img"` with `aria-label` describing the workflow
- Cyclic workflows (retry loops, reflection) render without layout errors

Single-agent fallback: When `graph.workflowShape === 'single_agent'`, show a simplified single-node view with the timeline below instead of a graph.

Span-inference fallback: When `MultiAgentEvaluation` is absent but `gen_ai.agent.*` spans exist, infer the graph from span parent/child relationships (Langfuse pattern).

### Phase 4: Enhanced timeline component

**File**: `dashboard/src/components/WorkflowTimeline.tsx` (new)

Extends existing `TurnTimeline.tsx` with multi-agent awareness:

- Horizontal timeline with swimlanes per agent
- Color-coded segments: active (blue), idle (gray), error (red)
- Parallel execution shown as overlapping swimlanes
- Handoff markers between swimlanes
- Click segment → expand to show turns in that agent's execution window

Data source: `TurnLevelResult[]` from `MultiAgentEvaluation.turns`, grouped by `agentName`.

### Phase 5: Dashboard integration

**Files**: `dashboard/src/pages/` or `dashboard/src/App.tsx`

| # | Task | Detail |
|---|------|--------|
| 1 | Add "Workflows" page/tab | New route: `/workflows/:sessionId` |
| 2 | Wire DAG + Timeline | Split view: DAG on top, timeline below |
| 3 | Session list with multi-agent indicator | Badge on session list items that have >1 agent |
| 4 | Navigation from DAG node click | `onNodeClick` → `/agents/:sessionId?agent=<name>` |
| 5 | Lazy-load graph library | Dynamic `import()` to avoid bundle size impact on non-workflow pages |

### Phase 6: Tests

**File**: `dashboard/src/__tests__/WorkflowGraph.test.tsx` (new)

| Test | Validates |
|------|-----------|
| Renders 3-agent graph with correct node count | Basic rendering |
| Renders directed edges between handoff pairs | Edge correctness |
| Node displays score, tool count, token count, duration | Data binding |
| Edge displays handoff score | Data binding |
| Single-agent session shows fallback view | Graceful degradation |
| Cyclic workflow (agent loop) renders without errors | Cycle handling |
| Empty evaluation renders without errors | Empty state |
| `onNodeClick` fires with correct nodeId | Interaction |
| Graph with 10+ agents renders (no crash) | Scale boundary |
| Minimap appears for graphs with 5+ nodes | Minimap threshold |
| Timeline swimlanes grouped by agent | Multi-agent timeline |
| Handoff markers appear between swimlanes | Timeline accuracy |
| Score badges have text labels (not color-only) | Accessibility |
| Span-inference builds graph when MultiAgentEvaluation absent | Fallback path |

---

## File Impact Summary

| File | Change Type |
|------|-------------|
| `dashboard/src/types/workflow-graph.ts` | **New** — graph data model |
| `dashboard/src/api/routes/agents.ts` | Extend response with `graph` field |
| `dashboard/src/components/WorkflowGraph.tsx` | **New** — graph visualization (ReactFlow + ELKjs) |
| `dashboard/src/components/WorkflowTimeline.tsx` | **New** — multi-agent timeline |
| `dashboard/src/pages/` or `App.tsx` | New route, navigation wiring |
| `dashboard/package.json` | Add `@xyflow/react@^12`, `elkjs@^0.9` |
| `dashboard/src/__tests__/WorkflowGraph.test.tsx` | **New** — test suite |

---

## Acceptance Criteria

- [x] Graph view renders agents as nodes and handoffs as directed edges
- [x] Each node shows: agent name, evaluation score, tool call count, token count, duration
- [x] Each edge shows: handoff score, context-preserved indicator
- [x] Cyclic workflows (agent loops, retries) render without layout errors
- [x] Timeline view shows parallel/sequential agent execution with swimlanes
- [x] Clicking a node navigates to agent-level metric detail
- [x] Single-agent sessions show simplified view (no graph, just timeline)
- [x] Span-inference fallback works when `MultiAgentEvaluation` is absent
- [x] Components render without errors on empty data
- [x] Minimap shown for graphs with 5+ nodes
- [x] Graph library lazy-loaded (no bundle size impact on other pages)
- [x] Graph container has `aria-label`; score indicators include text labels (not color-only)
- [ ] Interactive nodes are keyboard-focusable and operable via Enter

---

## Anti-Patterns to Avoid

| Anti-pattern | Source | Mitigation |
|-------------|--------|------------|
| Flame chart/span waterfall for multi-agent workflows | Datadog explicitly warns against this | Graph view abstracts logical agents, not raw spans; `SpanTree.tsx` remains separate |
| Using dagre as layout engine | Deprecated (2015 codebase, no maintainers) | Use ELKjs — documented migration path in ReactFlow ecosystem |
| Rendering every span as a node | Phoenix design principle: abstract to logical components | `buildWorkflowGraph()` aggregates at agent level, not span level |
| Requiring explicit graph metadata for visualization | Langfuse infers from OTel timing/nesting | Add span-inference fallback when `MultiAgentEvaluation` is absent |
| Color-only score indicators | WCAG 1.4.1 | Text labels on all score badges |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Graph library bundle size (~250KB combined) | Medium | Lazy-load via dynamic `import()`; measure with `vite-bundle-visualizer`; ReactFlow `onlyRenderVisibleElements` for perf |
| Complex graphs (10+ agents) become unreadable | Medium | Zoom/pan + minimap + collapse sub-workflows; limit initial render to top-level agents |
| Multi-agent data sparse in production | Low | Ship with mock data; span-inference fallback (Langfuse pattern) when explicit data absent |
| ELKjs layout computation is async and expensive | Low | Memoize layout result; recompute only on data change, not on pan/zoom |
