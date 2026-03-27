import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation, HandoffEvaluation, TurnLevelResult, TraceSpan } from '../types.js';

export function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'planner',
    label: 'planner',
    evaluationScore: 0.75,
    toolCallCount: 3,
    totalTokens: 1024,
    durationMs: 2500,
    turnCount: 1,
    hasError: false,
    ...overrides,
  };
}

export function makeEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return {
    id: 'planner->executor',
    source: 'planner',
    target: 'executor',
    handoffScore: 0.85,
    contextPreserved: true,
    latencyMs: null,
    label: '0.85',
    ...overrides,
  };
}

export function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [makeNode()],
    edges: [],
    rootNodeId: 'planner',
    workflowShape: 'linear',
    droppedTurns: 0,
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<TurnLevelResult> = {}): TurnLevelResult {
  return {
    turnIndex: 0,
    agentName: 'planner',
    relevance: 0.8,
    taskProgress: 0.5,
    hasError: false,
    ...overrides,
  };
}

export function makeHandoff(overrides: Partial<HandoffEvaluation> = {}): HandoffEvaluation {
  return {
    sourceAgent: 'planner',
    targetAgent: 'executor',
    score: 0.85,
    correctTarget: true,
    contextPreserved: true,
    ...overrides,
  };
}

export function makeEvaluation(overrides: Partial<MultiAgentEvaluation> = {}): MultiAgentEvaluation {
  return {
    handoffs: [],
    turns: [],
    handoffScore: null,
    avgTurnRelevance: null,
    conversationCompleteness: null,
    totalTurns: 0,
    errorPropagationTurns: 0,
    ...overrides,
  };
}

export function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'agent_turn',
    startTimeUnixNano: 1000000000,
    endTimeUnixNano: 2000000000,
    durationMs: 1000,
    attributes: {},
    ...overrides,
  };
}

export function makeClusteredGraph(
  clusterIds: string[],
  nodesPerCluster: number,
): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  for (const cId of clusterIds) {
    for (let i = 0; i < nodesPerCluster; i++) {
      nodes.push(makeNode({ id: `${cId}-node-${i}`, label: `${cId}-agent-${i}`, clusterId: cId }));
      if (i > 0) {
        edges.push(makeEdge({
          id: `${cId}-${i - 1}->${cId}-${i}`,
          source: `${cId}-node-${i - 1}`,
          target: `${cId}-node-${i}`,
        }));
      }
    }
  }

  // Connect last node of each cluster to first node of the next
  for (let c = 0; c < clusterIds.length - 1; c++) {
    const src = `${clusterIds[c]}-node-${nodesPerCluster - 1}`;
    const tgt = `${clusterIds[c + 1]}-node-0`;
    edges.push(makeEdge({ id: `${src}->${tgt}`, source: src, target: tgt }));
  }

  return makeGraph({
    nodes,
    edges,
    rootNodeId: `${clusterIds[0]}-node-0`,
    workflowShape: 'branching',
  });
}

export function makeChainGraph(
  size: number,
  labelPrefix: string,
  workflowShape: WorkflowGraph['workflowShape'],
): WorkflowGraph {
  const nodes = Array.from({ length: size }, (_, i) =>
    makeNode({ id: `${labelPrefix}-${i}`, label: `${labelPrefix}-${i}` })
  );
  const edges = Array.from({ length: size - 1 }, (_, i) =>
    makeEdge({
      id: `${labelPrefix}-${i}->${labelPrefix}-${i + 1}`,
      source: `${labelPrefix}-${i}`,
      target: `${labelPrefix}-${i + 1}`,
    })
  );
  return makeGraph({ nodes, edges, rootNodeId: `${labelPrefix}-0`, workflowShape });
}
