import { memo, useCallback, useEffect } from 'react';
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 220;
const NODE_HEIGHT = 120;
const MINIMAP_THRESHOLD = 5;

const SCORE_BANDS = {
  HIGH: { min: 0.7, label: 'Good', bg: '#dcfce7', border: '#16a34a', text: '#15803d' },
  MID: { min: 0.4, label: 'Fair', bg: '#fef9c3', border: '#ca8a04', text: '#a16207' },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getScoreBand(score: number | null) {
  if (score === null) return null;
  if (score >= SCORE_BANDS.HIGH.min) return SCORE_BANDS.HIGH;
  if (score >= SCORE_BANDS.MID.min) return SCORE_BANDS.MID;
  return SCORE_BANDS.LOW;
}

const elk = new ELK();

async function computeLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const elkGraph = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodes.map(n => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(elkGraph);

  const rfNodes: Node[] = (layout.children ?? []).map(elkNode => ({
    id: elkNode.id,
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    data: nodes.find(n => n.id === elkNode.id)! as unknown as Record<string, unknown>,
    type: 'agentNode',
  }));

  const rfEdges: Edge[] = edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    data: e as unknown as Record<string, unknown>,
    type: 'agentEdge',
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

const AgentNodeComponent = memo(function AgentNodeComponent({ data }: NodeProps) {
  const d = data as unknown as WorkflowNode;
  const band = getScoreBand(d.evaluationScore);

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
      aria-label={`Agent: ${d.label}, Score: ${d.evaluationScore ?? 'N/A'}`}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.label}</div>
      {band && (
        <div style={{ color: band.text, fontSize: 12 }}>
          <span>{band.label}</span>: {d.evaluationScore?.toFixed(2)}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
        <span>{d.toolCallCount} tools</span> | <span>{d.turnCount} turns</span>
        {d.totalTokens != null && <span> | {(d.totalTokens / 1000).toFixed(1)}K tok</span>}
      </div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>
        {d.durationMs < 1000
          ? `${d.durationMs}ms`
          : `${(d.durationMs / 1000).toFixed(1)}s`}
      </div>
      {d.hasError && (
        <div style={{ color: '#dc2626', fontSize: 11, fontWeight: 600 }}>Error</div>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const NODE_TYPES = { agentNode: AgentNodeComponent };
const EDGE_TYPES = {};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface WorkflowGraphProps {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

export function WorkflowGraphView({ graph, onNodeClick, height = 600 }: WorkflowGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (graph.nodes.length === 0) return;
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
  }, [graph.nodes, graph.edges, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  // Single-agent fallback
  if (graph.workflowShape === 'single_agent' && graph.nodes.length <= 1) {
    const node = graph.nodes[0];
    return (
      <div style={{ height }} role="img" aria-label="Agent workflow graph">
        <div style={{ padding: 24, textAlign: 'center' }}>
          {node ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{node.label}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 8 }}>
                {node.turnCount} turns | {node.toolCallCount} tools
              </div>
            </>
          ) : (
            <div style={{ color: '#9ca3af' }}>No agent data</div>
          )}
        </div>
      </div>
    );
  }

  const showMiniMap = graph.nodes.length >= MINIMAP_THRESHOLD;

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
      >
        <Controls />
        <Background />
        {showMiniMap && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}
