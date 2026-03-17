import type { MultiAgentEvaluation, TraceSpan } from '../types.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowShape } from '../types/workflow-graph.js';

const ATTR_AGENT_NAME = 'gen_ai.agent.name';
const ATTR_TOTAL_TOKENS = 'llm.usage.total_tokens';

export function buildWorkflowGraph(
  evaluation: MultiAgentEvaluation | null,
  _agentMap: Record<string, string>,
  spans: TraceSpan[],
): WorkflowGraph {
  if (evaluation === null) {
    return { nodes: [], edges: [], rootNodeId: null, workflowShape: 'single_agent' };
  }

  // Group turns by agentName
  const agentTurns = new Map<string, typeof evaluation.turns[number][]>();
  for (const turn of evaluation.turns) {
    if (turn.agentName == null) continue;
    const existing = agentTurns.get(turn.agentName) ?? [];
    existing.push(turn);
    agentTurns.set(turn.agentName, existing);
  }

  // Determine root: agent with the lowest turnIndex
  let rootAgentName: string | null = null;
  let minTurnIndex = Infinity;
  for (const turn of evaluation.turns) {
    if (turn.agentName == null) continue;
    if (turn.turnIndex < minTurnIndex) {
      minTurnIndex = turn.turnIndex;
      rootAgentName = turn.agentName;
    }
  }

  // Build nodes
  const nodes: WorkflowNode[] = [];
  for (const [agentName, turns] of agentTurns) {
    const relevances = turns.map(t => t.relevance).filter((r): r is number => r != null);
    const evaluationScore = relevances.length > 0
      ? relevances.reduce((a, b) => a + b, 0) / relevances.length
      : null;

    const hasError = turns.some(t => t.hasError);
    const turnCount = turns.length;

    // Aggregate from spans matching this agent
    const agentSpans = spans.filter(s => s.attributes?.[ATTR_AGENT_NAME] === agentName);
    const toolCallCount = agentSpans.filter(s => s.name === 'tool_call').length;
    const tokenValues = agentSpans
      .map(s => s.attributes?.[ATTR_TOTAL_TOKENS])
      .filter((v): v is number => typeof v === 'number');
    const totalTokens = tokenValues.length > 0 ? tokenValues.reduce((a, b) => a + b, 0) : null;
    const durationMs = agentSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

    nodes.push({
      id: agentName,
      label: agentName,
      evaluationScore,
      toolCallCount,
      totalTokens,
      durationMs,
      turnCount,
      hasError,
    });
  }

  // Build edges
  const edges: WorkflowEdge[] = evaluation.handoffs.map(h => ({
    id: `${h.sourceAgent}->${h.targetAgent}`,
    source: h.sourceAgent,
    target: h.targetAgent,
    handoffScore: h.score,
    contextPreserved: h.contextPreserved,
    label: `score: ${h.score.toFixed(2)}`,
  }));

  // Classify shape
  const workflowShape = classifyShape(nodes, edges);

  return { nodes, edges, rootNodeId: rootAgentName, workflowShape };
}

function classifyShape(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowShape {
  if (nodes.length <= 1) return 'single_agent';

  // Check cyclic: any edge where the reverse also exists
  const edgeSet = new Set(edges.map(e => `${e.source}->${e.target}`));
  for (const e of edges) {
    if (edgeSet.has(`${e.target}->${e.source}`)) return 'cyclic';
  }

  // Check branching: any source with >1 outgoing edge
  const outDegree = new Map<string, number>();
  for (const e of edges) {
    outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
  }
  for (const count of outDegree.values()) {
    if (count > 1) return 'branching';
  }

  return 'linear';
}
