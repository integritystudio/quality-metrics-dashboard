import { mean, rollup } from 'd3-array';
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

/**
 * Spans grouped by a string attribute's value; spans without a string value are left out.
 * `gen_ai.agent.id` and `gen_ai.agent.name` are typed `string` by the GenAI semantic conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/#gen-ai-agent-id
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/#gen-ai-agent-name
 */
function groupByAttribute(spans: TraceSpan[], attribute: string): Map<string, TraceSpan[]> {
  const keyed = spans.flatMap(span => {
    const value = span.attributes?.[attribute];
    return typeof value === 'string' ? [{ value, span }] : [];
  });
  return rollup(keyed, entries => entries.map(entry => entry.span), entry => entry.value);
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

type EvaluationTurn = MultiAgentEvaluation['turns'][number];
type AgentTiming = { id: string; minStart: number; maxEnd: number };

/** Total tokens across the spans that report them, or null when none does. */
function totalTokensOf(spans: TraceSpan[]): number | null {
  let tokenSum = 0;
  let tokenCount = 0;
  for (const s of spans) {
    const v = s.attributes?.[ATTR_TOTAL_TOKENS];
    if (typeof v === 'number' && Number.isFinite(v)) {
      tokenSum += v;
      tokenCount++;
    }
  }
  return tokenCount > 0 ? tokenSum : null;
}

/** A span group's first start and last end, in nanoseconds. A span with no end counts as instant. */
function spanBoundsNs(spans: TraceSpan[]): { minStart: number; maxEnd: number } {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const s of spans) {
    const start = Number(s.startTimeUnixNano);
    if (start < minStart) minStart = start;
    const end = s.endTimeUnixNano != null ? Number(s.endTimeUnixNano) : start;
    if (end > maxEnd) maxEnd = end;
  }
  return { minStart, maxEnd };
}

/**
 * Turns per agent, the count of turns with no agent to attribute them to, and the
 * root: the agent holding the lowest turnIndex, broken lexicographically.
 */
function groupTurnsByAgent(turns: EvaluationTurn[]): {
  agentTurns: Map<string, EvaluationTurn[]>;
  droppedTurns: number;
  rootAgentName: string | null;
} {
  const agentTurns = new Map<string, EvaluationTurn[]>();
  let droppedTurns = 0;
  let rootAgentName: string | null = null;
  let minTurnIndex = Infinity;

  for (const turn of turns) {
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

  return { agentTurns, droppedTurns, rootAgentName };
}

/** Per-agent span timing bounds, used to compute handoff latency. */
function agentSpanBounds(spansByAgent: Map<string, TraceSpan[]>): {
  firstStartNs: Map<string, number>;
  lastEndNs: Map<string, number>;
} {
  const firstStartNs = new Map<string, number>();
  const lastEndNs = new Map<string, number>();
  for (const [agentId, agentGroup] of spansByAgent) {
    const { minStart, maxEnd } = spanBoundsNs(agentGroup);
    if (Number.isFinite(minStart)) firstStartNs.set(agentId, minStart);
    if (Number.isFinite(maxEnd)) lastEndNs.set(agentId, maxEnd);
  }
  return { firstStartNs, lastEndNs };
}

/**
 * Time from the source agent's last span end to the target's first span start.
 * Zero-latency handoffs count — the target may start exactly when the source ends —
 * but a negative or non-finite gap means the two did not hand over in sequence.
 */
function handoffLatencyMs(sourceEnd: number | undefined, targetStart: number | undefined): number | null {
  if (sourceEnd === undefined || targetStart === undefined) return null;
  const gapNs = targetStart - sourceEnd;
  if (gapNs < 0 || !Number.isFinite(gapNs)) return null;
  return Math.round(gapNs / NS_TO_MS);
}

function evaluationNodes(
  agentTurns: Map<string, EvaluationTurn[]>,
  spansByAgent: Map<string, TraceSpan[]>,
): WorkflowNode[] {
  const nodes: WorkflowNode[] = [];
  for (const [agentName, turns] of agentTurns) {
    const agentGroup = spansByAgent.get(agentName) ?? [];
    let toolCallCount = 0;
    let durationMs = 0;
    for (const s of agentGroup) {
      if (s.name === SPAN_NAME_TOOL_CALL) toolCallCount++;
      durationMs += s.durationMs ?? 0;
    }

    nodes.push({
      id: agentName,
      label: agentName,
      evaluationScore: mean(turns, t => t.relevance) ?? null,
      toolCallCount,
      totalTokens: totalTokensOf(agentGroup),
      durationMs,
      turnCount: turns.length,
      hasError: turns.some(t => t.hasError),
    });
  }
  return nodes;
}

/** One edge per source→target pair, first occurrence winning, with NaN scores guarded. */
function evaluationEdges(
  handoffs: MultiAgentEvaluation['handoffs'],
  bounds: ReturnType<typeof agentSpanBounds>,
): WorkflowEdge[] {
  const seenEdges = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const h of handoffs) {
    const key = `${h.sourceAgent}->${h.targetAgent}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const score = Number.isFinite(h.score) ? h.score : 0;
    const latencyMs = handoffLatencyMs(bounds.lastEndNs.get(h.sourceAgent), bounds.firstStartNs.get(h.targetAgent));

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
  return edges;
}

function buildFromEvaluation(evaluation: MultiAgentEvaluation, spans: TraceSpan[]): WorkflowGraph {
  const { agentTurns, droppedTurns, rootAgentName } = groupTurnsByAgent(evaluation.turns);
  const spansByAgent = groupByAttribute(spans, GENAI_AGENT_ATTRIBUTES.AGENT_NAME);
  const nodes = evaluationNodes(agentTurns, spansByAgent);
  const edges = evaluationEdges(evaluation.handoffs, agentSpanBounds(spansByAgent));
  return { nodes, edges, rootNodeId: rootAgentName, workflowShape: classifyShape(nodes, edges), droppedTurns };
}

/** A node built from spans alone: no evaluation, so no score. */
function inferredNode(agentId: string, agentGroup: TraceSpan[]): WorkflowNode {
  let toolCallCount = 0;
  let durationMs = 0;
  let hasError = false;
  for (const s of agentGroup) {
    if (s.name.startsWith(SPAN_NAME_TOOL_PREFIX)) toolCallCount++;
    durationMs += s.durationMs ?? 0;
    if (s.status?.code === 'ERROR') hasError = true;
  }
  return {
    id: agentId,
    label: agentId,
    evaluationScore: null,
    toolCallCount,
    totalTokens: totalTokensOf(agentGroup),
    durationMs,
    turnCount: agentGroup.length,
    hasError,
  };
}

/** An edge between each consecutive pair of agents whose spans did not overlap. */
function inferredEdges(agentTimings: AgentTiming[]): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < agentTimings.length - 1; i++) {
    const curr = agentTimings[i];
    const next = agentTimings[i + 1];
    if (!curr || !next) continue;
    // Use epsilon tolerance to catch near-concurrent spans that a strict <= would miss
    if (curr.maxEnd > next.minStart + SPAN_SEQUENCE_EPSILON_NS) continue;
    const latencyMs = handoffLatencyMs(curr.maxEnd, next.minStart);
    edges.push({
      id: `${curr.id}->${next.id}`,
      source: curr.id,
      target: next.id,
      // null distinguishes inferred edges (no evaluation data) from a real handoff score of 0
      handoffScore: null,
      contextPreserved: false,
      latencyMs,
      label: buildEdgeLabel('inferred', latencyMs),
    });
  }
  return edges;
}

function inferFromSpans(spans: TraceSpan[]): WorkflowGraph {
  const agentSpans = groupByAttribute(spans, GENAI_AGENT_ATTRIBUTES.AGENT_ID);

  if (agentSpans.size === 0) {
    return { nodes: [], edges: [], rootNodeId: null, workflowShape: 'single_agent', droppedTurns: 0 };
  }

  const nodes: WorkflowNode[] = [];
  const agentTimings: AgentTiming[] = [];
  for (const [agentId, agentGroup] of agentSpans) {
    nodes.push(inferredNode(agentId, agentGroup));
    agentTimings.push({ id: agentId, ...spanBoundsNs(agentGroup) });
  }

  agentTimings.sort((a, b) => a.minStart - b.minStart);

  const edges = inferredEdges(agentTimings);
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
