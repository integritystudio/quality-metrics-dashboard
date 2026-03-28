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
const CLUSTER_NODE_WIDTH = 240;
const CLUSTER_NODE_HEIGHT = 90;
/** Show MiniMap only when there are enough nodes to benefit from an overview. */
const MINIMAP_THRESHOLD = 5;
/**
 * Maximum nodes passed to ELK layout.
 * Graphs with 100+ agents would block the main thread during synchronous ELK layout.
 * Graphs exceeding this limit are rendered in a degraded list fallback instead.
 */
const MAX_ELK_NODES = 50;

const WORKFLOW_SCORE_HIGH_MIN = 0.7;
const WORKFLOW_SCORE_MID_MIN = 0.4;

const SCORE_BANDS = {
  HIGH: { min: WORKFLOW_SCORE_HIGH_MIN, label: 'Good', className: 'workflow-node--score-high' },
  MID: { min: WORKFLOW_SCORE_MID_MIN, label: 'Fair', className: 'workflow-node--score-mid' },
  LOW: { min: 0, label: 'Poor', className: 'workflow-node--score-low' },
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
 * Replaces `data as unknown as WorkflowNode` double-cast in AgentNodeComponent.
 * Validates the minimum fields needed for rendering; avoids silent mismatches if ReactFlow
 * passes unexpected data to a node component.
 */
interface WorkflowNodeWithMeta extends WorkflowNode {
  /** True when this node is not in the active filter selection. */
  dimmed?: boolean;
  /** True when this node is on the highlighted critical path. */
  critical?: boolean;
}

/** Data shape for a collapsed cluster node. */
interface ClusterNodeData {
  clusterId: string;
  clusterLabel: string;
  memberCount: number;
  hasError: boolean;
  avgScore: number | null;
}

function isWorkflowNode(value: unknown): value is WorkflowNodeWithMeta {
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

function isClusterNodeData(value: unknown): value is ClusterNodeData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['clusterId'] === 'string' &&
    typeof v['clusterLabel'] === 'string' &&
    typeof v['memberCount'] === 'number' &&
    typeof v['hasError'] === 'boolean'
  );
}

function buildNodeDataMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map(n => [n.id, n]));
}

const CLUSTER_NODE_PREFIX = '__cluster__';

function clusterNodeId(clusterId: string): string {
  return `${CLUSTER_NODE_PREFIX}${clusterId}`;
}

function isClusterNodeId(id: string): boolean {
  return id.startsWith(CLUSTER_NODE_PREFIX);
}

/**
 * Collapses nodes belonging to collapsed clusters into single synthetic nodes.
 * External edges that connect to/from cluster members are rerouted to the cluster node.
 * Intra-cluster edges are dropped.
 */
export function applyClusterCollapse(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  collapsedClusters: ReadonlySet<string>,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  if (collapsedClusters.size === 0) return { nodes, edges };

  // Build map from node id → clusterId for collapsed clusters only
  const nodeClusterMap = new Map<string, string>();
  for (const n of nodes) {
    if (n.clusterId && collapsedClusters.has(n.clusterId)) {
      nodeClusterMap.set(n.id, n.clusterId);
    }
  }

  // Build synthetic cluster nodes
  const nodeDataMap = buildNodeDataMap(nodes);
  const clusterMembers = new Map<string, WorkflowNode[]>();
  for (const [nodeId, cId] of nodeClusterMap) {
    const existing = clusterMembers.get(cId) ?? [];
    const node = nodeDataMap.get(nodeId);
    if (node) existing.push(node);
    clusterMembers.set(cId, existing);
  }

  const syntheticNodes: WorkflowNode[] = [];
  for (const [cId, members] of clusterMembers) {
    const scores = members.map(m => m.evaluationScore).filter((s): s is number => s !== null);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    syntheticNodes.push({
      id: clusterNodeId(cId),
      label: `[Cluster] ${cId}`,
      evaluationScore: avgScore,
      toolCallCount: members.reduce((s, m) => s + m.toolCallCount, 0),
      totalTokens: members.reduce((s, m) => s + (m.totalTokens ?? 0), 0),
      durationMs: members.reduce((s, m) => s + m.durationMs, 0),
      turnCount: members.reduce((s, m) => s + m.turnCount, 0),
      hasError: members.some(m => m.hasError),
      clusterId: cId,
      clusterMemberCount: members.length,
    });
  }

  const outNodes = [
    ...nodes.filter(n => !nodeClusterMap.has(n.id)),
    ...syntheticNodes,
  ];

  // Reroute edges: replace collapsed-cluster member ids with their cluster node id
  const resolveId = (id: string): string => {
    const cId = nodeClusterMap.get(id);
    return cId ? clusterNodeId(cId) : id;
  };

  const seenEdgeKeys = new Set<string>();
  const outEdges: WorkflowEdge[] = [];
  for (const e of edges) {
    const src = resolveId(e.source);
    const tgt = resolveId(e.target);
    if (src === tgt) continue; // intra-cluster: drop
    const key = `${src}->${tgt}`;
    if (seenEdgeKeys.has(key)) continue; // dedup rerouted edges
    seenEdgeKeys.add(key);
    outEdges.push({ ...e, id: key, source: src, target: tgt });
  }

  return { nodes: outNodes, edges: outEdges };
}

/**
 * Returns all distinct clusterIds present in a node list.
 */
export function extractClusterIds(nodes: WorkflowNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.clusterId) seen.add(n.clusterId);
  }
  return [...seen].sort();
}

async function computeLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  selectedAgents?: ReadonlySet<string>,
  criticalPath?: ReadonlySet<string>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodeDataMap = buildNodeDataMap(nodes);

  const elkGraph = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodes.map(n => {
      const isCluster = isClusterNodeId(n.id);
      return {
        id: n.id,
        width: isCluster ? CLUSTER_NODE_WIDTH : NODE_WIDTH,
        height: isCluster ? CLUSTER_NODE_HEIGHT : NODE_HEIGHT,
      };
    }),
    edges: edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(elkGraph);

  const rfNodes: Node[] = (layout.children ?? [])
    .filter(elkNode => nodeDataMap.has(elkNode.id))
    .map(elkNode => {
      const workflowNode = nodeDataMap.get(elkNode.id)!;
      const dimmed = selectedAgents != null && !selectedAgents.has(elkNode.id);
      const critical = criticalPath != null && criticalPath.has(elkNode.id);
      const isCluster = isClusterNodeId(elkNode.id);

      if (isCluster) {
        const avgScore = workflowNode.evaluationScore;
        const data: ClusterNodeData = {
          clusterId: workflowNode.clusterId ?? elkNode.id,
          clusterLabel: workflowNode.clusterId ?? elkNode.id,
          memberCount: workflowNode.clusterMemberCount ?? 0,
          hasError: workflowNode.hasError,
          avgScore,
        };
        return {
          id: elkNode.id,
          position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
          data: data as unknown as Record<string, unknown>,
          type: 'clusterNode',
        };
      }

      return {
        id: elkNode.id,
        position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
        data: { ...workflowNode, dimmed, critical } as unknown as Record<string, unknown>,
        type: 'agentNode',
      };
    });

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

  const nodeClass = [
    'workflow-node',
    band?.className,
    d.dimmed && 'workflow-node--dimmed',
    d.critical && 'workflow-node--critical',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={nodeClass}
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

const ClusterNodeComponent = memo(function ClusterNodeComponent({ data }: NodeProps) {
  if (!isClusterNodeData(data)) return null;
  const d = data;
  const band = getScoreBand(d.avgScore);

  const nodeClass = [
    'workflow-cluster-node',
    band?.className,
    d.hasError && 'workflow-cluster-node--error',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={nodeClass}
      role="group"
      aria-label={`Cluster: ${d.clusterLabel}, ${d.memberCount} agents`}
    >
      <div className="workflow-cluster-node__label">{d.clusterLabel}</div>
      <div className="workflow-cluster-node__meta">
        {d.memberCount} agents
        {d.avgScore !== null && (
          <span> · avg {d.avgScore.toFixed(SCORE_CHIP_PRECISION)}</span>
        )}
      </div>
      {d.hasError && <div className="workflow-node__error">Error</div>}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const NODE_TYPES = { agentNode: AgentNodeComponent, clusterNode: ClusterNodeComponent };

interface WorkflowGraphProps {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
  /** When provided, nodes not in this set are rendered dimmed (topology preserved). */
  selectedAgents?: ReadonlySet<string>;
  /** When provided, nodes in this set are highlighted as the critical path. */
  criticalPath?: ReadonlySet<string>;
  /** Forwarded ref applied to the graph container div, used for PNG export. */
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function WorkflowGraphView({ graph, onNodeClick, height = 600, selectedAgents, criticalPath, containerRef }: WorkflowGraphProps) {
  const containerStyle = { '--workflow-graph-height': `${height}px` } as React.CSSProperties;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [collapsedClusters, setCollapsedClusters] = useState<ReadonlySet<string>>(new Set());

  const clusterIds = extractClusterIds(graph.nodes);

  const toggleCluster = useCallback((clusterId: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (graph.nodes.length === 0) return;
    let cancelled = false;
    const { nodes: visibleNodes, edges: visibleEdges } = applyClusterCollapse(
      graph.nodes,
      graph.edges,
      collapsedClusters,
    );
    computeLayout(visibleNodes, visibleEdges, selectedAgents, criticalPath)
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
    // setNodes/setEdges are stable refs from useNodesState/useEdgesState but
    // were in the dep array, causing unnecessary ELK re-runs each render cycle.
    // Omitted here — layout should only recompute when graph data or filter actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, graph.edges, selectedAgents, criticalPath, collapsedClusters]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  // Large-graph fallback: skip ELK layout to avoid blocking the main thread
  if (graph.nodes.length > MAX_ELK_NODES) {
    return (
      <div ref={containerRef} className="workflow-graph-container" style={containerStyle} role="img" aria-label="Agent workflow graph">
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
      <div ref={containerRef} className="workflow-graph-container" style={containerStyle} role="img" aria-label="Agent workflow graph">
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
      <div ref={containerRef} className="workflow-graph-container" style={containerStyle} role="img" aria-label="Agent workflow graph">
        <div className="error-state workflow-fallback">
          Failed to compute workflow layout: {layoutError}
        </div>
      </div>
    );
  }

  const showMiniMap = graph.nodes.length >= MINIMAP_THRESHOLD;

  return (
    <div ref={containerRef} className="workflow-graph-container" style={containerStyle} role="img" aria-label="Agent workflow graph">
      {clusterIds.length > 0 && (
        <div className="workflow-cluster-controls" role="group" aria-label="Cluster toggles">
          {clusterIds.map(cId => (
            <button
              key={cId}
              type="button"
              className={`workflow-cluster-toggle${collapsedClusters.has(cId) ? ' workflow-cluster-toggle--collapsed' : ''}`}
              onClick={() => toggleCluster(cId)}
              aria-pressed={collapsedClusters.has(cId)}
            >
              {collapsedClusters.has(cId) ? '▶' : '▼'} {cId}
            </button>
          ))}
        </div>
      )}
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
