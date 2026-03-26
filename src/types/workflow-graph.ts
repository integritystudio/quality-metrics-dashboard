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
  /** null for inferred edges (no evaluation data); real zero score is a valid low score. */
  handoffScore: number | null;
  contextPreserved: boolean;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rootNodeId: string | null;
  workflowShape: WorkflowShape;
  /** Count of turns dropped because agentName was undefined/null (WG-5 observability). */
  droppedTurns: number;
}
