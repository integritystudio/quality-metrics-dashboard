import { group, mean } from 'd3-array';
import type { MultiAgentEvaluation, TraceSpan } from '../types.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowShape } from '../types/workflow-graph.js';
import { SCORE_CHIP_PRECISION } from './constants.js';
import { GENAI_AGENT_ATTRIBUTES } from './otel-attributes.js';
import { incrementIn } from './collections.js';

const ATTR_TOTAL_TOKENS = 'llm.usage.total_tokens';
const SPAN_NAME_TOOL_CALL = 'tool_call';
const SPAN_NAME_TOOL_PREFIX = 'tool:';
/**
 * Epsilon tolerance (nanoseconds) for near-concurrent span edge inference.
 * Spans whose end and start differ by less than this value are treated as
 * sequential. Set to 1 ms = 1_000_000 ns.
 */
const SPAN_SEQUENCE_EPSILON_NS = 1_000_000;
const NS_TO_MS = 1_000_000;

/** Spans grouped by an attribute's value; spans without the attribute are left out. */
function groupByAttribute(spans: TraceSpan[], attribute: string): Map<string, TraceSpan[]> {
  const keyOf = (span: TraceSpan) => span.attributes?.[attribute] as string | undefined;
  return group(spans.filter(span => keyOf(span) != null), span => keyOf(span) as string);
}

function buildEdgeLabel(primaryLabel: string, latencyMs: number | null): string {
  const parts = [primaryLabel];
  if (latencyMs !== null) parts.push(`${latencyMs}ms`);
  return parts.join(' · ');
}

export function buildWorkflowGraph(
  evaluation: MultiAgentEvaluation | null,
  spans: TraceSpan[],
): WorkflowGraph {
  // Defensive: externally-sourced evaluation objects may have a partial shape.
  if (evaluation !== null && Array.isArray(evaluation.turns)) {
    return buildFromEvaluation(evaluation, spans);
  }
  return inferFromSpans(spans);
}

function buildFromEvaluation(evaluation: MultiAgentEvaluation, spans: TraceSpan[]): WorkflowGraph {
  const agentTurns = new Map<string, typeof evaluation.turns[number][]>();
  let droppedTurns = 0;
  // Root: agent with lowest turnIndex, lexicographic tiebreak
  let rootAgentName: string | null = null;
  let minTurnIndex = Infinity;

  for (const turn of evaluation.turns) {
    if (turn.agentName == null) {
      droppedTurns++;
      continue;
    }
    const existing = agentTurns.get(turn.agentName);
    if (existing) existing.push(turn);
    else agentTurns.set(turn.agentName, [turn]);

    if (
      turn.turnIndex < minTurnIndex ||
      (turn.turnIndex === minTurnIndex && turn.agentName < (rootAgentName ?? ''))
    ) {
      minTurnIndex = turn.turnIndex;
      rootAgentName = turn.agentName;
    }
  }

  const spansByAgent = groupByAttribute(spans, GENAI_AGENT_ATTRIBUTES.AGENT_NAME);

  // Per-agent span timing bounds used to compute handoff latency.
  const agentLastEndNs = new Map<string, number>();
  const agentFirstStartNs = new Map<string, number>();
  for (const [agentId, agentGroup] of spansByAgent) {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of agentGroup) {
      const start = Number(s.startTimeUnixNano);
      if (start < minStart) minStart = start;
      const end = s.endTimeUnixNano != null ? Number(s.endTimeUnixNano) : start;
      if (end > maxEnd) maxEnd = end;
    }
    if (Number.isFinite(minStart)) agentFirstStartNs.set(agentId, minStart);
    if (Number.isFinite(maxEnd)) agentLastEndNs.set(agentId, maxEnd);
  }

  const nodes: WorkflowNode[] = [];
  for (const [agentName, turns] of agentTurns) {
    const evaluationScore = mean(turns, t => t.relevance) ?? null;

    let toolCallCount = 0;
    let tokenSum = 0;
    let tokenCount = 0;
    let durationMs = 0;
    for (const s of spansByAgent.get(agentName) ?? []) {
      if (s.name === SPAN_NAME_TOOL_CALL) toolCallCount++;
      const v = s.attributes?.[ATTR_TOTAL_TOKENS];
      if (typeof v === 'number' && Number.isFinite(v)) {
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

  // Deduplicate edges, guard NaN scores
  const seenEdges = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const h of evaluation.handoffs) {
    const key = `${h.sourceAgent}->${h.targetAgent}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const score = Number.isFinite(h.score) ? h.score : 0;

    // Compute handoff latency: time from source agent's last span end to target's first span start.
    // Use >= to include zero-latency handoffs (target starts exactly when source ends).
    const sourceEnd = agentLastEndNs.get(h.sourceAgent);
    const targetStart = agentFirstStartNs.get(h.targetAgent);
    const gapNs = sourceEnd !== undefined && targetStart !== undefined ? targetStart - sourceEnd : null;
    const latencyMs = gapNs !== null && gapNs >= 0 && Number.isFinite(gapNs)
      ? Math.round(gapNs / NS_TO_MS)
      : null;

    edges.push({
      id: key,
      source: h.sourceAgent,
      target: h.targetAgent,
      handoffScore: score,
      contextPreserved: h.contextPreserved,
      latencyMs,
      label: buildEdgeLabel(score.toFixed(SCORE_CHIP_PRECISION), latencyMs),
    });
  }

  return { nodes, edges, rootNodeId: rootAgentName, workflowShape: classifyShape(nodes, edges), droppedTurns };
}

function inferFromSpans(spans: TraceSpan[]): WorkflowGraph {
  const agentSpans = groupByAttribute(spans, GENAI_AGENT_ATTRIBUTES.AGENT_ID);

  if (agentSpans.size === 0) {
    return { nodes: [], edges: [], rootNodeId: null, workflowShape: 'single_agent', droppedTurns: 0 };
  }

  const nodes: WorkflowNode[] = [];
  const agentTimings: { id: string; minStart: number; maxEnd: number }[] = [];

  for (const [agentId, agentGroup] of agentSpans) {
    let toolCallCount = 0;
    let tokenSum = 0;
    let tokenCount = 0;
    let durationMs = 0;
    let hasError = false;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of agentGroup) {
      if (s.name.startsWith(SPAN_NAME_TOOL_PREFIX)) toolCallCount++;
      const tv = s.attributes?.[ATTR_TOTAL_TOKENS];
      if (typeof tv === 'number' && Number.isFinite(tv)) { tokenSum += tv; tokenCount++; }
      durationMs += s.durationMs ?? 0;
      if (s.status?.code === 'ERROR') hasError = true;
      const start = Number(s.startTimeUnixNano);
      if (start < minStart) minStart = start;
      const end = s.endTimeUnixNano != null ? Number(s.endTimeUnixNano) : start;
      if (end > maxEnd) maxEnd = end;
    }
    nodes.push({
      id: agentId,
      label: agentId,
      evaluationScore: null,
      toolCallCount,
      totalTokens: tokenCount > 0 ? tokenSum : null,
      durationMs,
      turnCount: agentGroup.length,
      hasError,
    });
    agentTimings.push({ id: agentId, minStart, maxEnd });
  }

  agentTimings.sort((a, b) => a.minStart - b.minStart);

  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < agentTimings.length - 1; i++) {
    const curr = agentTimings[i];
    const next = agentTimings[i + 1];
    if (!curr || !next) continue;
    // Use epsilon tolerance to catch near-concurrent spans that a strict <= would miss
    if (curr.maxEnd <= next.minStart + SPAN_SEQUENCE_EPSILON_NS) {
      const key = `${curr.id}->${next.id}`;
      const gapNs = next.minStart - curr.maxEnd;
      const latencyMs = gapNs >= 0 && Number.isFinite(gapNs) ? Math.round(gapNs / NS_TO_MS) : null;
      edges.push({
        id: key,
        source: curr.id,
        target: next.id,
        // null distinguishes inferred edges (no evaluation data) from a real handoff score of 0
        handoffScore: null,
        contextPreserved: false,
        latencyMs,
        label: buildEdgeLabel('inferred', latencyMs),
      });
    }
  }

  const rootNodeId = agentTimings[0]?.id ?? null;
  return { nodes, edges, rootNodeId, workflowShape: classifyShape(nodes, edges), droppedTurns: 0 };
}

function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  // DFS-based cycle detection — correctly handles 3+ node cycles (e.g. A→B→C→A).
  // Skips self-loops: single-node self-references are not classified as cyclic.
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
  const state = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) state.set(n.id, UNVISITED);

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
  if (edges.length === 0) return 'single_agent'; // disconnected agents

  // Check cyclic using DFS — detects both pairwise (A↔B) and multi-node (A→B→C→A) cycles
  if (hasCycle(nodes, edges)) return 'cyclic';

  const outDegree = new Map<string, number>();
  for (const e of edges) {
    incrementIn(outDegree, e.source);
  }
  for (const count of outDegree.values()) {
    if (count > 1) return 'branching';
  }

  return 'linear';
}

/**
 * The root-to-leaf chain with the largest summed `durationMs`, root first; empty when the
 * graph has no root. A node whose search never re-entered a node on the stack has the same
 * best chain from every caller, so it is computed once: an acyclic graph costs O(V + E)
 * however many paths it holds. A node that did re-enter one sits on a cycle and is searched
 * again per caller, which keeps the chain the longest one that repeats no node.
 */
export function criticalPath(graph: WorkflowGraph): string[] {
  const root = graph.rootNodeId;
  if (root === null) return [];

  const outEdges = group(graph.edges, e => e.source);
  const durationOf = new Map(graph.nodes.map(n => [n.id, n.durationMs]));
  const settled = new Map<string, { cost: number; path: string[] }>();
  const onStack = new Set<string>();

  function search(nodeId: string): { cost: number; path: string[]; reenteredStack: boolean } {
    const known = settled.get(nodeId);
    if (known) return { ...known, reenteredStack: false };
    if (onStack.has(nodeId)) return { cost: 0, path: [], reenteredStack: true };
    onStack.add(nodeId);
    let bestTail: string[] = [];
    let bestTailCost = 0;
    let reenteredStack = false;
    for (const { target } of outEdges.get(nodeId) ?? []) {
      const tail = search(target);
      reenteredStack ||= tail.reenteredStack;
      if (tail.cost > bestTailCost) {
        bestTailCost = tail.cost;
        bestTail = tail.path;
      }
    }
    onStack.delete(nodeId);
    const result = { cost: (durationOf.get(nodeId) ?? 0) + bestTailCost, path: [nodeId, ...bestTail] };
    if (!reenteredStack) settled.set(nodeId, result);
    return { ...result, reenteredStack };
  }

  return search(root).path;
}
