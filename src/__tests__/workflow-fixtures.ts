import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../types/workflow-graph.js';

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
    label: 'score: 0.85',
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
