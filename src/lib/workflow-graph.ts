import type { MultiAgentEvaluation, TraceSpan } from '../types.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowShape } from '../types/workflow-graph.js';
import { SCORE_CHIP_PRECISION, OTEL_STATUS_ERROR_CODE } from './constants.js';

const ATTR_AGENT_NAME = 'gen_ai.agent.name';
const ATTR_AGENT_ID = 'gen_ai.agent.id';
const ATTR_TOTAL_TOKENS = 'llm.usage.total_tokens';
/**
 * Epsilon tolerance (nanoseconds) for near-concurrent span edge inference.
 * Spans whose end and start differ by less than this value are treated as
 * sequential (WG-M2). Set to 1 ms = 1_000_000 ns.
 */
const SPAN_SEQUENCE_EPSILON_NS = 1_000_000;

export function buildWorkflowGraph(
  evaluation: MultiAgentEvaluation | null,
  spans: TraceSpan[],
): WorkflowGraph {
  // CR-TS-5: guard against null/missing turns array before delegating to buildFromEvaluation.
  // computeMultiAgentEvaluation always sets turns, but defensive check prevents a throw
  // if the caller passes a partial or externally-sourced evaluation object.
  if (evaluation !== null && Array.isArray(evaluation.turns)) {
    return buildFromEvaluation(evaluation, spans);
  }
  return inferFromSpans(spans);
}

function buildFromEvaluation(evaluation: MultiAgentEvaluation, spans: TraceSpan[]): WorkflowGraph {
  const agentTurns = new Map<string, typeof evaluation.turns[number][]>();
  let droppedTurns = 0;
  // Root: agent with lowest turnIndex, lexicographic tiebreak (WG-7)
  let rootAgentName: string | null = null;
  let minTurnIndex = Infinity;

  for (const turn of evaluation.turns) {
    if (turn.agentName == null) {
      droppedTurns++;
      continue;
    }
    const existing = agentTurns.get(turn.agentName) ?? [];
    existing.push(turn);
    agentTurns.set(turn.agentName, existing);

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

    let toolCallCount = 0;
    let tokenSum = 0;
    let tokenCount = 0;
    let durationMs = 0;
    for (const s of spans) {
      if (s.attributes?.[ATTR_AGENT_NAME] !== agentName) continue;
      if (s.name === 'tool_call') toolCallCount++;
      const v = s.attributes?.[ATTR_TOTAL_TOKENS];
      if (typeof v === 'number' && isFinite(v)) {
        tokenSum += v;
        tokenCount++;
      }
      durationMs += s.durationMs ?? 0;
    }
    const totalTokens = tokenCount > 0 ? tokenSum : null;

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
      label: `score: ${score.toFixed(SCORE_CHIP_PRECISION)}`,
    });
  }

  return { nodes, edges, rootNodeId: rootAgentName, workflowShape: classifyShape(nodes, edges), droppedTurns };
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
    return { nodes: [], edges: [], rootNodeId: null, workflowShape: 'single_agent', droppedTurns: 0 };
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
      hasError: group.some(s => s.status?.code === OTEL_STATUS_ERROR_CODE),
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
    // Use epsilon tolerance to catch near-concurrent spans that a strict <= would miss (WG-M2)
    if (curr.maxEnd <= next.minStart + SPAN_SEQUENCE_EPSILON_NS) {
      const key = `${curr.id}->${next.id}`;
      edges.push({
        id: key,
        source: curr.id,
        target: next.id,
        // null distinguishes inferred edges (no evaluation data) from a real handoff score of 0
        handoffScore: null,
        contextPreserved: false,
        label: 'inferred',
      });
    }
  }

  const rootNodeId = agentTimings[0]?.id ?? null;
  return { nodes, edges, rootNodeId, workflowShape: classifyShape(nodes, edges), droppedTurns: 0 };
}

function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  // DFS-based cycle detection — correctly handles 3+ node cycles (e.g. A→B→C→A).
  // Skips self-loops (WG-2): single-node self-references are not classified as cyclic.
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (e.source !== e.target) {
      adjacency.get(e.source)?.push(e.target);
    }
  }

  const UNVISITED = 0;
  const IN_STACK = 1;
  const DONE = 2;
  const state = new Map<string, 0 | 1 | 2>(nodes.map(n => [n.id, UNVISITED]));

  function dfs(nodeId: string): boolean {
    state.set(nodeId, IN_STACK);
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const neighborState = state.get(neighbor) ?? UNVISITED;
      if (neighborState === IN_STACK) return true;
      if (neighborState === UNVISITED && dfs(neighbor)) return true;
    }
    state.set(nodeId, DONE);
    return false;
  }

  for (const n of nodes) {
    if (state.get(n.id) === UNVISITED && dfs(n.id)) return true;
  }
  return false;
}

function classifyShape(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowShape {
  if (nodes.length <= 1) return 'single_agent';
  if (edges.length === 0) return 'single_agent'; // WG-6: disconnected agents

  // Check cyclic using DFS — detects both pairwise (A↔B) and multi-node (A→B→C→A) cycles
  if (hasCycle(nodes, edges)) return 'cyclic';

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
