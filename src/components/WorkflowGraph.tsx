import React, { memo, useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../types/workflow-graph.js';
import { fmtDuration } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 120;
/** Show MiniMap only when there are enough nodes to benefit from an overview. */
const MINIMAP_THRESHOLD = 5;
/**
 * CR-PERF-2: Maximum nodes passed to ELK layout.
 * Graphs with 100+ agents would block the main thread during synchronous ELK layout.
 * Graphs exceeding this limit are rendered in a degraded list fallback instead.
 */
const MAX_ELK_NODES = 50;

const WORKFLOW_SCORE_HIGH_MIN = 0.7;
const WORKFLOW_SCORE_MID_MIN = 0.4;

const SCORE_BANDS = {
  HIGH: { min: WORKFLOW_SCORE_HIGH_MIN, label: 'Good', bg: '#dcfce7', border: '#16a34a', text: '#15803d' },
  MID: { min: WORKFLOW_SCORE_MID_MIN, label: 'Fair', bg: '#fef9c3', border: '#ca8a04', text: '#a16207' },
  LOW: { min: 0, label: 'Poor', bg: '#fee2e2', border: '#dc2626', text: '#b91c1c' },
} as const;

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '60',
  'elk.layered.feedbackEdges': 'true',
} as const;

function getScoreBand(score: number | null) {
  if (score === null) return null;
  if (score >= SCORE_BANDS.HIGH.min) return SCORE_BANDS.HIGH;
  if (score >= SCORE_BANDS.MID.min) return SCORE_BANDS.MID;
  return SCORE_BANDS.LOW;
}

const elk = new ELK();

/**
 * Type guard for WorkflowNode.
 * CR-TS-4: replaces `data as unknown as WorkflowNode` double-cast in AgentNodeComponent.
 * Validates the minimum fields needed for rendering; avoids silent mismatches if ReactFlow
 * passes unexpected data to a node component.
 */
function isWorkflowNode(value: unknown): value is WorkflowNode {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['label'] === 'string' &&
    typeof v['toolCallCount'] === 'number' &&
    typeof v['turnCount'] === 'number' &&
    typeof v['durationMs'] === 'number' &&
    typeof v['hasError'] === 'boolean'
  );
}

function buildNodeDataMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map(n => [n.id, n]));
}

async function computeLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodeDataMap = buildNodeDataMap(nodes);

  const elkGraph = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodes.map(n => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(elkGraph);

  const rfNodes: Node[] = (layout.children ?? [])
    .filter(elkNode => nodeDataMap.has(elkNode.id))
    .map(elkNode => ({
      id: elkNode.id,
      position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
      data: nodeDataMap.get(elkNode.id) as unknown as Record<string, unknown>,
      type: 'agentNode',
    }));

  const rfEdges: Edge[] = edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

const AgentNodeComponent = memo(function AgentNodeComponent({ data }: NodeProps) {
  if (!isWorkflowNode(data)) return null;
  const d = data;
  const band = getScoreBand(d.evaluationScore);

  return (
    <div
      className="workflow-node"
      style={{
        // Score-band colors are data-driven and cannot be expressed as static classes
        '--workflow-node-border': band?.border ?? '#d1d5db',
        '--workflow-node-bg': band?.bg ?? '#f9fafb',
        '--workflow-node-score-color': band?.text ?? 'inherit',
      } as React.CSSProperties}
      role="group"
      aria-label={`Agent: ${d.label}, Score: ${d.evaluationScore ?? 'N/A'}`}
    >
      <div className="workflow-node__label">{d.label}</div>
      {band && (
        <div className="workflow-node__score">
          <span>{band.label}</span>: {d.evaluationScore?.toFixed(SCORE_CHIP_PRECISION)}
        </div>
      )}
      <div className="workflow-node__meta">
        <span>{d.toolCallCount} tools</span> | <span>{d.turnCount} turns</span>
        {d.totalTokens != null && <span> | {(d.totalTokens / 1000).toFixed(1)}K tok</span>}
      </div>
      <div className="workflow-node__duration">
        {fmtDuration(d.durationMs)}
      </div>
      {d.hasError && <div className="workflow-node__error">Error</div>}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const NODE_TYPES = { agentNode: AgentNodeComponent };

interface WorkflowGraphProps {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

export function WorkflowGraphView({ graph, onNodeClick, height = 600 }: WorkflowGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  useEffect(() => {
    if (graph.nodes.length === 0) return;
    let cancelled = false;
    computeLayout(graph.nodes, graph.edges)
      .then(({ nodes: rfNodes, edges: rfEdges }) => {
        if (!cancelled) {
          setLayoutError(null);
          setNodes(rfNodes);
          setEdges(rfEdges);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setLayoutError(err instanceof Error ? err.message : 'Layout computation failed');
        }
      });
    return () => { cancelled = true; };
    // CR-PERF-3: setNodes/setEdges are stable refs from useNodesState/useEdgesState but
    // were in the dep array, causing unnecessary ELK re-runs each render cycle.
    // Omitted here — layout should only recompute when graph data actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, graph.edges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  // Large-graph fallback: skip ELK layout to avoid blocking the main thread (CR-PERF-2)
  if (graph.nodes.length > MAX_ELK_NODES) {
    return (
      <div className="workflow-graph-container" style={{ '--graph-height': `${height}px` } as React.CSSProperties} role="img" aria-label="Agent workflow graph">
        <div className="workflow-oversize text-secondary text-xs">
          <div className="workflow-oversize__heading">
            Graph too large to render ({graph.nodes.length} agents)
          </div>
          <div className="workflow-oversize__note text-muted">
            ELK layout is skipped for graphs with more than {MAX_ELK_NODES} nodes.
          </div>
          <ul className="workflow-oversize__list">
            {graph.nodes.map(n => (
              <li key={n.id} className="mono-xs mb-1">
                {n.label} — {n.turnCount} turns, {n.toolCallCount} tools
                {n.hasError && <span className="text-warning"> (error)</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (graph.workflowShape === 'single_agent' && graph.nodes.length <= 1) {
    const node = graph.nodes[0];
    return (
      <div className="workflow-graph-container" style={{ '--graph-height': `${height}px` } as React.CSSProperties} role="img" aria-label="Agent workflow graph">
        <div className="workflow-fallback">
          {node ? (
            <>
              <div className="workflow-fallback__title">{node.label}</div>
              <div className="workflow-fallback__subtitle">
                {node.turnCount} turns | {node.toolCallCount} tools
              </div>
            </>
          ) : (
            <div className="workflow-fallback__empty">No agent data</div>
          )}
        </div>
      </div>
    );
  }

  if (layoutError) {
    return (
      <div className="workflow-graph-container" style={{ '--graph-height': `${height}px` } as React.CSSProperties} role="img" aria-label="Agent workflow graph">
        <div className="error-state workflow-fallback">
          Failed to compute workflow layout: {layoutError}
        </div>
      </div>
    );
  }

  const showMiniMap = graph.nodes.length >= MINIMAP_THRESHOLD;

  return (
    <div className="workflow-graph-container" style={{ '--graph-height': `${height}px` } as React.CSSProperties} role="img" aria-label="Agent workflow graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={NODE_TYPES}
        fitView
      >
        <Controls />
        <Background />
        {showMiniMap && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}
