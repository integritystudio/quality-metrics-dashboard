import type { MultiAgentEvaluation, TraceSpan } from '../types.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowShape } from '../types/workflow-graph.js';

const ATTR_AGENT_NAME = 'gen_ai.agent.name';
const ATTR_AGENT_ID = 'gen_ai.agent.id';
const ATTR_TOTAL_TOKENS = 'llm.usage.total_tokens';
const SPAN_STATUS_ERROR = 2;

export function buildWorkflowGraph(
  evaluation: MultiAgentEvaluation | null,
  spans: TraceSpan[],
): WorkflowGraph {
  if (evaluation !== null) {
    return buildFromEvaluation(evaluation, spans);
  }
  return inferFromSpans(spans);
}

function buildFromEvaluation(evaluation: MultiAgentEvaluation, spans: TraceSpan[]): WorkflowGraph {
  const agentTurns = new Map<string, typeof evaluation.turns[number][]>();
  for (const turn of evaluation.turns) {
    if (turn.agentName == null) continue;
    const existing = agentTurns.get(turn.agentName) ?? [];
    existing.push(turn);
    agentTurns.set(turn.agentName, existing);
  }

  // Root: agent with lowest turnIndex, lexicographic tiebreak (WG-7)
  let rootAgentName: string | null = null;
  let minTurnIndex = Infinity;
  for (const turn of evaluation.turns) {
    if (turn.agentName == null) continue;
    if (
      turn.turnIndex < minTurnIndex ||
      (turn.turnIndex === minTurnIndex && turn.agentName < (rootAgentName ?? ''))
    ) {
      minTurnIndex = turn.turnIndex;
      rootAgentName = turn.agentName;
    }
  }

  const nodes: WorkflowNode[] = [];
  for (const [agentName, turns] of agentTurns) {
    const relevances = turns.map(t => t.relevance).filter((r): r is number => r != null);
    const evaluationScore = relevances.length > 0
      ? relevances.reduce((a, b) => a + b, 0) / relevances.length
      : null;

    const agentSpans = spans.filter(s => s.attributes?.[ATTR_AGENT_NAME] === agentName);
    const toolCallCount = agentSpans.filter(s => s.name === 'tool_call').length;
    const tokenValues = agentSpans
      .map(s => s.attributes?.[ATTR_TOTAL_TOKENS])
      .filter((v): v is number => typeof v === 'number' && isFinite(v));
    const totalTokens = tokenValues.length > 0 ? tokenValues.reduce((a, b) => a + b, 0) : null;
    const durationMs = agentSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

    nodes.push({
      id: agentName,
      label: agentName,
      evaluationScore,
      toolCallCount,
      totalTokens,
      durationMs,
      turnCount: turns.length,
      hasError: turns.some(t => t.hasError),
    });
  }

  // Deduplicate edges (WG-1, WG-3), guard NaN scores (WG-8)
  const seenEdges = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const h of evaluation.handoffs) {
    const key = `${h.sourceAgent}->${h.targetAgent}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const score = isFinite(h.score) ? h.score : 0;
    edges.push({
      id: key,
      source: h.sourceAgent,
      target: h.targetAgent,
      handoffScore: score,
      contextPreserved: h.contextPreserved,
      label: `score: ${score.toFixed(2)}`,
    });
  }

  return { nodes, edges, rootNodeId: rootAgentName, workflowShape: classifyShape(nodes, edges) };
}

function inferFromSpans(spans: TraceSpan[]): WorkflowGraph {
  const agentSpans = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const agentId = span.attributes?.[ATTR_AGENT_ID] as string | undefined;
    if (!agentId) continue;
    const group = agentSpans.get(agentId) ?? [];
    group.push(span);
    agentSpans.set(agentId, group);
  }

  if (agentSpans.size === 0) {
    return { nodes: [], edges: [], rootNodeId: null, workflowShape: 'single_agent' };
  }

  const nodes: WorkflowNode[] = [];
  for (const [agentId, group] of agentSpans) {
    const toolCallCount = group.filter(s => s.name.startsWith('tool:')).length;
    const tokenValues = group
      .map(s => s.attributes?.[ATTR_TOTAL_TOKENS])
      .filter((v): v is number => typeof v === 'number' && isFinite(v));
    const totalTokens = tokenValues.length > 0 ? tokenValues.reduce((a, b) => a + b, 0) : null;
    const durationMs = group.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

    nodes.push({
      id: agentId,
      label: agentId,
      evaluationScore: null,
      toolCallCount,
      totalTokens,
      durationMs,
      turnCount: group.length,
      hasError: group.some(s => s.status?.code === SPAN_STATUS_ERROR),
    });
  }

  // Infer edges from temporal ordering
  const agentTimings = [...agentSpans.entries()].map(([id, group]) => ({
    id,
    minStart: Math.min(...group.map(s => s.startTimeUnixNano)),
    maxEnd: Math.max(...group.map(s => s.endTimeUnixNano ?? s.startTimeUnixNano)),
  })).sort((a, b) => a.minStart - b.minStart);

  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < agentTimings.length - 1; i++) {
    const curr = agentTimings[i];
    const next = agentTimings[i + 1];
    if (curr.maxEnd <= next.minStart) {
      const key = `${curr.id}->${next.id}`;
      edges.push({
        id: key,
        source: curr.id,
        target: next.id,
        handoffScore: 0,
        contextPreserved: false,
        label: 'inferred',
      });
    }
  }

  const rootNodeId = agentTimings[0]?.id ?? null;
  return { nodes, edges, rootNodeId, workflowShape: classifyShape(nodes, edges) };
}

function classifyShape(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowShape {
  if (nodes.length <= 1) return 'single_agent';
  if (edges.length === 0) return 'single_agent'; // WG-6: disconnected agents

  // Check cyclic: skip self-loops (WG-2)
  const edgeSet = new Set(edges.map(e => `${e.source}->${e.target}`));
  for (const e of edges) {
    if (e.source === e.target) continue;
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
