export type WorkflowShape = 'single_agent' | 'linear' | 'branching' | 'cyclic';

export interface WorkflowNode {
  id: string;
  label: string;
  evaluationScore: number | null;
  toolCallCount: number;
  totalTokens: number | null;
  /**
   * Sum of durationMs for all spans attributed to this agent.
   * NOTE: Nested spans are counted independently, so parent spans that
   * encompass child spans cause double-counting of wall time. Treat as a
   * relative indicator of agent work, not an accurate wall-clock duration.
   */
  durationMs: number;
  turnCount: number;
  hasError: boolean;
  /**
   * Optional cluster identifier. Nodes sharing a clusterId can be collapsed
   * into a single group node in the graph view. Undefined means the node
   * belongs to no cluster.
   */
  clusterId?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** null for inferred edges (no evaluation data); real zero score is a valid low score. */
  handoffScore: number | null;
  contextPreserved: boolean;
  /**
   * Time in milliseconds between the last span of the source agent and the first span of
   * the target agent. null when timing data is unavailable (evaluation-path builds).
   */
  latencyMs: number | null;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rootNodeId: string | null;
  workflowShape: WorkflowShape;
  /** Count of turns dropped because agentName was undefined/null. */
  droppedTurns: number;
}
