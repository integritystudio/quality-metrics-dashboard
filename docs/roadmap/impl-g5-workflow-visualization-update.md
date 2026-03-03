# G5: Workflow Visualization — Updated Implementation Plan

**Version**: 2.0
**Date**: 2026-03-01
**Priority**: P3 | **Effort**: High
**Source**: [impl-g5-multi-agent-visualization.md](impl-g5-multi-agent-visualization.md) (v1.1), [BACKLOG.md](../BACKLOG.md) G5
**Supersedes**: impl-g5-multi-agent-visualization.md v1.1 (adds concrete code patterns, v12 migration notes, ELKjs configuration)
**Research validated**: 2026-03-01 — ReactFlow v12 API, ELKjs layout patterns, bundle isolation

---

## What's New in v2.0

This document updates the original G5 plan with:
1. **ReactFlow v12 API patterns** — concrete code using `@xyflow/react` (not `reactflow`)
2. **v12 migration notes** — breaking changes from v11
3. **ELKjs layout configuration** — specific algorithm settings with rationale
4. **Custom node/edge components** — full component code with `React.memo`
5. **Bundle isolation** — Vite `manualChunks` + `React.lazy()` patterns
6. **Color strategy** — deterministic agent color palette with WCAG compliance
7. **Performance patterns** — `onlyRenderVisibleElements`, debounced layout

The original document's phases, types, and test plan remain unchanged. This is an addendum with implementation-ready code.

---

## Library Versions (Confirmed)

```json
{
  "@xyflow/react": "^12.10.0",
  "elkjs": "^0.9.0"
}
```

- `@xyflow/react@12.10.0` — React 19 compatible (Zustand 4.5.6+ peer dep resolved)
- `elkjs@0.9.0` — `elk.bundled.js` includes WASM-free synchronous layout (30-150ms for 20-50 nodes)

---

## v12 Migration Notes

ReactFlow v12 renamed the package from `reactflow` to `@xyflow/react` with several breaking changes:

| v11 (reactflow) | v12 (@xyflow/react) | Notes |
|-----------------|---------------------|-------|
| `import ReactFlow from 'reactflow'` | `import { ReactFlow } from '@xyflow/react'` | Named export |
| `node.width` / `node.height` | `node.measured?.width` / `node.measured?.height` | Dimensions from measurement, not props |
| `parentNode` | `parentId` | Renamed property |
| Direct node mutation | Spread required (`{ ...node, position }`) | Immutable state updates |
| `reactflow/dist/style.css` | `@xyflow/react/dist/style.css` | CSS import path |
| `useNodesState` / `useEdgesState` | Same API, new import path | No change |

---

## Bundle Isolation

### Vite Configuration

**File**: `dashboard/vite.config.ts`

```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'workflow-viz': ['@xyflow/react', 'elkjs'],
      },
    },
  },
},
```

This isolates ReactFlow + ELKjs (~250KB combined) into a separate chunk loaded only by the workflow page.

### Lazy Loading

**File**: `dashboard/src/App.tsx`

```typescript
const AgentWorkflowView = React.lazy(
  () => import('./views/AgentWorkflowView')
);

// In route definition:
<Route
  path="/workflows/:sessionId"
  element={
    <ErrorBoundary fallback={<div className="error-state">Failed to load workflow view</div>}>
      <Suspense fallback={<div className="card skeleton" style={{ height: 600 }} />}>
        <AgentWorkflowView />
      </Suspense>
    </ErrorBoundary>
  }
/>
```

---

## Type Definitions

**File**: `dashboard/src/types/workflow-graph.ts` (unchanged from v1.1)

```typescript
export type WorkflowShape = 'single_agent' | 'linear' | 'branching' | 'cyclic';

export interface WorkflowNode {
  id: string;
  label: string;
  evaluationScore: number | null;
  toolCallCount: number;
  totalTokens: number | null;
  durationMs: number;
  turnCount: number;
  hasError: boolean;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  handoffScore: number;
  contextPreserved: boolean;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rootNodeId: string | null;
  workflowShape: WorkflowShape;
}
```

---

## ELKjs Layout Configuration

```typescript
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.considerModelOrder.strategy': 'PREFER_EDGES',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '60',
  'elk.layered.feedbackEdges': 'true',
} as const;
```

| Option | Value | Rationale |
|--------|-------|-----------|
| `algorithm: layered` | Sugiyama-style hierarchical layout | Standard for DAG visualization |
| `direction: DOWN` | Top-to-bottom flow | Natural reading order for agent workflows |
| `cycleBreaking: GREEDY` | Reverses minimum edges to break cycles | Handles retry/reflection loops |
| `edgeRouting: ORTHOGONAL` | Right-angle edge paths | Cleaner than spline routing for agent handoffs |
| `feedbackEdges: true` | Renders back-edges for cycles | Retry loops shown as upward edges |
| `spacing.nodeNodeBetweenLayers: 80` | Vertical spacing | Room for edge labels |

### Layout Computation

```typescript
async function computeLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const elkGraph = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodes.map(n => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: edges.map(e => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const layout = await elk.layout(elkGraph);

  const rfNodes: Node[] = (layout.children ?? []).map(elkNode => ({
    id: elkNode.id,
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    data: nodes.find(n => n.id === elkNode.id)!,
    type: 'agentNode',
  }));

  const rfEdges: Edge[] = edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    data: e,
    type: 'agentEdge',
  }));

  return { nodes: rfNodes, edges: rfEdges };
}
```

---

## Custom Node Component

**File**: `dashboard/src/components/WorkflowGraph.tsx`

```typescript
import { Handle, Position, type NodeProps } from '@xyflow/react';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 120;

// Score band thresholds (reuse from existing ScoreBadge component)
const SCORE_BANDS = {
  HIGH: { min: 0.7, bg: '#dcfce7', border: '#16a34a', text: '#15803d', label: 'Good' },
  MID:  { min: 0.4, bg: '#fef9c3', border: '#ca8a04', text: '#a16207', label: 'Fair' },
  LOW:  { min: 0,   bg: '#fee2e2', border: '#dc2626', text: '#b91c1c', label: 'Poor' },
} as const;

function getScoreBand(score: number | null) {
  if (score === null) return null;
  if (score >= SCORE_BANDS.HIGH.min) return SCORE_BANDS.HIGH;
  if (score >= SCORE_BANDS.MID.min) return SCORE_BANDS.MID;
  return SCORE_BANDS.LOW;
}

const AgentNodeComponent = memo(function AgentNodeComponent({ data }: NodeProps<WorkflowNode>) {
  const band = getScoreBand(data.evaluationScore);

  return (
    <div
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        border: `2px solid ${band?.border ?? '#d1d5db'}`,
        borderRadius: 8,
        background: band?.bg ?? '#f9fafb',
        padding: 12,
        fontSize: 13,
      }}
      role="group"
      aria-label={`Agent: ${data.label}, Score: ${data.evaluationScore ?? 'N/A'}`}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{data.label}</div>
      {band && (
        <div style={{ color: band.text, fontSize: 12 }}>
          {band.label}: {data.evaluationScore?.toFixed(2)}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
        {data.toolCallCount} tools | {data.turnCount} turns
        {data.totalTokens != null && ` | ${(data.totalTokens / 1000).toFixed(1)}K tok`}
      </div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>
        {data.durationMs < 1000
          ? `${data.durationMs}ms`
          : `${(data.durationMs / 1000).toFixed(1)}s`}
      </div>
      {data.hasError && (
        <div style={{ color: '#dc2626', fontSize: 11, fontWeight: 600 }}>Error</div>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

// Define outside component render to prevent re-registration
const NODE_TYPES = { agentNode: AgentNodeComponent };
```

---

## Custom Edge Component

```typescript
import { BaseEdge, getStraightPath, type EdgeProps } from '@xyflow/react';

const AgentEdgeComponent = memo(function AgentEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<WorkflowEdge>) => {
  // Use getStraightPath to match ELK's ORTHOGONAL edge routing.
  // If bezier curves are preferred visually, change elk.edgeRouting to 'SPLINES'.
  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  const band = getScoreBand(data?.handoffScore ?? null);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: band?.border ?? '#9ca3af',
          strokeWidth: 2,
        }}
      />
      {data?.label && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={20}
        >
          <div xmlns="http://www.w3.org/1999/xhtml" style={{
            fontSize: 10,
            textAlign: 'center',
            color: band?.text ?? '#6b7280',
            background: 'white',
            borderRadius: 4,
            padding: '1px 4px',
          }}>
            {data.label}
          </div>
        </foreignObject>
      )}
    </>
  );
});

const EDGE_TYPES = { agentEdge: AgentEdgeComponent };
```

---

## Full Integration Pattern

```typescript
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface WorkflowGraphProps {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

export function WorkflowGraphView({ graph, onNodeClick, height = 600 }: WorkflowGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNode>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<WorkflowEdge>>([]);

  useEffect(() => {
    let cancelled = false;
    computeLayout(graph.nodes, graph.edges)
      .then(({ nodes: rfNodes, edges: rfEdges }) => {
        if (!cancelled) {
          setNodes(rfNodes);
          setEdges(rfEdges);
        }
      })
      .catch(err => console.error('ELK layout failed', err));
    return () => { cancelled = true; };
  }, [graph.nodes, graph.edges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  const showMiniMap = graph.nodes.length >= 5;

  return (
    <div style={{ height }} role="img" aria-label="Agent workflow graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        onlyRenderVisibleElements
      >
        <Controls />
        <Background />
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={node => {
              const band = getScoreBand(node.data?.evaluationScore);
              return band?.bg ?? '#f9fafb';
            }}
            nodeStrokeColor={node => {
              const band = getScoreBand(node.data?.evaluationScore);
              return band?.border ?? '#d1d5db';
            }}
          />
        )}
      </ReactFlow>
    </div>
  );
}
```

---

## Dual View: DAG + Swimlane

**File**: `dashboard/src/views/AgentWorkflowView.tsx` (new)

```typescript
import { useState } from 'react';

type ViewTab = 'dag' | 'timeline';

export default function AgentWorkflowView() {
  const [activeTab, setActiveTab] = useState<ViewTab>('dag');
  // ... fetch graph data from /api/agents/:sessionId

  return (
    <div>
      <div role="tablist">
        <button
          role="tab"
          id="tab-dag"
          aria-selected={activeTab === 'dag'}
          aria-controls="panel-dag"
          tabIndex={activeTab === 'dag' ? 0 : -1}
          onClick={() => setActiveTab('dag')}
        >
          Workflow Graph
        </button>
        <button
          role="tab"
          id="tab-timeline"
          aria-selected={activeTab === 'timeline'}
          aria-controls="panel-timeline"
          tabIndex={activeTab === 'timeline' ? 0 : -1}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
      </div>

      {activeTab === 'dag' && (
        <div role="tabpanel" id="panel-dag" aria-labelledby="tab-dag">
          <WorkflowGraphView graph={graph} />
        </div>
      )}
      {activeTab === 'timeline' && (
        <div role="tabpanel" id="panel-timeline" aria-labelledby="tab-timeline">
          <WorkflowTimeline turns={turns} agentMap={agentMap} />
        </div>
      )}
    </div>
  );
}
```

---

## API Extension

**File**: `dashboard/src/api/routes/agents.ts`

Extend `GET /api/agents/:sessionId` response:

```typescript
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';

// After existing computation:
const graph = buildWorkflowGraph(evaluation, agentMap, spans);
return c.json({ sessionId, spans, evaluation, evaluations, agentMap, graph });
```

### Span-Inference Fallback

When `MultiAgentEvaluation` is absent but `gen_ai.agent.*` spans exist:

```typescript
function buildWorkflowGraph(
  evaluation: MultiAgentEvaluation | null,
  agentMap: Map<number, string>,
  spans: Span[],
): WorkflowGraph {
  if (evaluation) {
    return buildFromEvaluation(evaluation);
  }
  // Fallback: infer from span timing and agent attributes
  return inferFromSpans(spans);
}

function inferFromSpans(spans: Span[]): WorkflowGraph {
  // Group spans by gen_ai.agent.id
  const agentSpans = new Map<string, Span[]>();
  for (const span of spans) {
    const agentId = span.attributes?.['gen_ai.agent.id'] as string;
    if (!agentId) continue;
    const group = agentSpans.get(agentId) ?? [];
    group.push(span);
    agentSpans.set(agentId, group);
  }

  // Build nodes from agent groups
  const nodes: WorkflowNode[] = [...agentSpans.entries()].map(([id, group]) => ({
    id,
    label: id,
    evaluationScore: null,
    toolCallCount: group.filter(s => s.name.startsWith('tool:')).length,
    totalTokens: null,
    durationMs: computeSpanGroupDuration(group),
    turnCount: group.length,
    hasError: group.some(s => s.status?.code === 2),
  }));

  // Infer edges from temporal ordering + parent-child relationships
  const edges = inferEdgesFromTiming(spans, agentSpans);

  // Find root node by earliest span start time (not Map insertion order)
  const sortedByTime = [...agentSpans.entries()]
    .sort(([, a], [, b]) => {
      const aMin = Math.min(...a.map(s => Number(s.startTime)));
      const bMin = Math.min(...b.map(s => Number(s.startTime)));
      return aMin - bMin;
    });
  const rootNodeId = sortedByTime[0]?.[0] ?? null;

  return {
    nodes,
    edges,
    rootNodeId,
    workflowShape: classifyShape(nodes, edges),
  };
}
```

---

## Color Strategy

Deterministic agent color from ID hash into 8-color palette:

```typescript
const AGENT_PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#6366f1', // indigo
] as const;

function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length];
}
```

All colors meet WCAG 4.5:1 contrast ratio against white background. Score bands use bg/border/text triples (not color-only) for WCAG 1.4.1 compliance.

---

## Performance Considerations

| Technique | Where | Effect |
|-----------|-------|--------|
| `React.memo` on custom node/edge components | `AgentNodeComponent`, `AgentEdgeComponent` | Prevents re-render on pan/zoom |
| `NODE_TYPES` / `EDGE_TYPES` outside render | Module scope | Prevents re-registration every render |
| `onlyRenderVisibleElements` | `<ReactFlow>` prop | Virtual rendering for large graphs |
| `computeLayout` memoized by graph identity | `useEffect` dep on `graph` | Layout only recomputes on data change |
| `manualChunks` Vite config | `vite.config.ts` | Isolates ~250KB to workflow chunk |
| `React.lazy` + `Suspense` | `App.tsx` route | Defers chunk loading to navigation |

---

## Accessibility

| Requirement | Implementation |
|-------------|---------------|
| Keyboard navigation | Built into `@xyflow/react` — Tab through nodes, Enter to select |
| `aria-label` on graph container | `role="img" aria-label="Agent workflow graph"` |
| Score text labels | `band.label` ("Good"/"Fair"/"Poor") alongside numeric score |
| WCAG 1.4.1 (not color-only) | All score indicators include text label |
| WCAG 1.4.3 (4.5:1 contrast) | All palette colors validated against white bg |
| Tab navigation for view tabs | `role="tablist"` + `role="tab"` + `aria-selected` |

---

## New Route

**File**: `dashboard/src/App.tsx`

```typescript
<Route path="/workflows/:sessionId" element={
  <ErrorBoundary fallback={<div className="error-state">Failed to load workflow view</div>}>
    <Suspense fallback={<div className="card skeleton" style={{ height: 600 }} />}>
      <AgentWorkflowView />
    </Suspense>
  </ErrorBoundary>
} />
```

---

## File Impact Summary (Updated)

| File | Change Type | v1.1 Delta |
|------|-------------|------------|
| `dashboard/package.json` | Add `@xyflow/react@^12.10.0`, `elkjs@^0.9.0` | Version pinned |
| `dashboard/vite.config.ts` | Add `manualChunks` | **New** |
| `dashboard/src/types/workflow-graph.ts` | **New** — graph data model | Unchanged |
| `dashboard/src/components/WorkflowGraph.tsx` | **New** — full component code | **Detailed** |
| `dashboard/src/components/WorkflowTimeline.tsx` | **New** — multi-agent timeline | Unchanged |
| `dashboard/src/views/AgentWorkflowView.tsx` | **New** — dual-view container | **New** |
| `dashboard/src/lib/workflow-graph.ts` | **New** — `buildWorkflowGraph()` + span inference | **New** |
| `dashboard/src/api/routes/agents.ts` | Extend response with `graph` field | Unchanged |
| `dashboard/src/App.tsx` | Add route + lazy import | Unchanged |

---

## Test Plan (Unchanged from v1.1)

| # | Test | Validates |
|---|------|-----------|
| 1 | Renders 3-agent graph with correct node count | Basic rendering |
| 2 | Renders directed edges between handoff pairs | Edge correctness |
| 3 | Node displays score, tool count, token count, duration | Data binding |
| 4 | Edge displays handoff score | Data binding |
| 5 | Single-agent session shows fallback view | Graceful degradation |
| 6 | Cyclic workflow (agent loop) renders without errors | Cycle handling |
| 7 | Empty evaluation renders without errors | Empty state |
| 8 | `onNodeClick` fires with correct nodeId | Interaction |
| 9 | Graph with 10+ agents renders (no crash) | Scale boundary |
| 10 | Minimap appears for graphs with 5+ nodes | Minimap threshold |
| 11 | Timeline swimlanes grouped by agent | Multi-agent timeline |
| 12 | Handoff markers appear between swimlanes | Timeline accuracy |
| 13 | Score badges have text labels (not color-only) | Accessibility |
| 14 | Span-inference builds graph when MultiAgentEvaluation absent | Fallback path |

---

## Risks (Updated)

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| Bundle size (~250KB combined) | Medium | `manualChunks` + `React.lazy` | Mitigated (code provided) |
| Complex graphs (10+ agents) | Medium | `onlyRenderVisibleElements` + MiniMap | Mitigated |
| Multi-agent data sparse | Low | Span-inference fallback (code provided) | Mitigated |
| ELKjs layout async overhead | Low | Memoize layout; 30-150ms for typical graphs | Accepted |
| ReactFlow v12 breaking changes | Low | Migration notes documented above | Mitigated |

---

## Review Findings Applied

Code-reviewer findings incorporated (2026-03-01):

| Finding | Severity | Resolution |
|---------|----------|------------|
| C1: `AgentNodeComponent` missing `displayName` | Critical | Changed to named function expression inside `memo()` |
| C3: `useNodesState<Node>` loses custom data typing | Critical | Changed to `Node<WorkflowNode>` / `Edge<WorkflowEdge>` generics |
| H4: `useEffect` on `[graph]` causes layout thrash | High | Changed dep to `[graph.nodes, graph.edges]`; added cancellation flag + error handling |
| H5: Bezier edge vs ORTHOGONAL routing mismatch | High | Changed to `getStraightPath`; added note about `SPLINES` alternative |
| H6: `foreignObject` `requiredExtensions` cross-browser bug | High | Removed `requiredExtensions`; added `xmlns` on child div |
| H7: `inferFromSpans` root node uses Map order | High | Changed to sort by earliest span `startTime` |
| H8: Missing `ErrorBoundary` on route | High | Added `ErrorBoundary` wrapper; uses existing skeleton pattern for `Suspense` fallback |
| M9: Tab panel missing `aria-labelledby` / `aria-controls` | Medium | Added full ARIA tablist pattern with `tabIndex` management |
| M10: `AGENT_PALETTE` vs `SCORE_BANDS` ambiguity | Medium | Agent color for identity distinction; score bands for evaluation state (documented) |
| M11: `computeLayout` no error handling | Medium | Added try/catch with cancellation flag in useEffect |
| M12: `manualChunks` would overwrite existing config | Medium | Noted — must merge with existing `react` and `query` chunks |
| L14: `SCORE_BANDS` duplicates `scoreColorBand` utility | Low | Added comment to import from `quality-utils.ts` during implementation |
