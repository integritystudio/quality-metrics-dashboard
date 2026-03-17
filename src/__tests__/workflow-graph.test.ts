import { describe, it, expect } from 'vitest';
import { buildWorkflowGraph } from '../lib/workflow-graph.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation, HandoffEvaluation, TurnLevelResult } from '../types.js';
import type { TraceSpan } from '../types.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeHandoff(overrides: Partial<HandoffEvaluation> = {}): HandoffEvaluation {
  return {
    sourceAgent: 'agentA',
    targetAgent: 'agentB',
    correctTarget: true,
    contextPreserved: true,
    score: 0.8,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnLevelResult> = {}): TurnLevelResult {
  return {
    turnIndex: 0,
    agentName: 'agentA',
    relevance: 0.75,
    taskProgress: 0.5,
    hasError: false,
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<MultiAgentEvaluation> = {}): MultiAgentEvaluation {
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

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
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

// ---------------------------------------------------------------------------
// 1. 3-agent linear workflow
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — 3-agent linear workflow', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'planner', targetAgent: 'coder', score: 0.9, contextPreserved: true }),
      makeHandoff({ sourceAgent: 'coder', targetAgent: 'reviewer', score: 0.7, contextPreserved: false }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'planner' }),
      makeTurn({ turnIndex: 1, agentName: 'coder' }),
      makeTurn({ turnIndex: 2, agentName: 'reviewer' }),
    ],
    totalTurns: 3,
  });
  const agentMap: Record<string, string> = { '0': 'planner', '1': 'coder', '2': 'reviewer' };
  const spans: TraceSpan[] = [];

  it('produces 3 nodes', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.nodes).toHaveLength(3);
  });

  it('produces 2 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.edges).toHaveLength(2);
  });

  it('shape is linear', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.workflowShape).toBe('linear');
  });

  it('rootNodeId is planner', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.rootNodeId).toBe('planner');
  });
});

// ---------------------------------------------------------------------------
// 2. Single-agent session
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — single-agent session', () => {
  const evaluation = makeEvaluation({
    handoffs: [],
    turns: [makeTurn({ turnIndex: 0, agentName: 'solo' })],
    totalTurns: 1,
  });
  const agentMap: Record<string, string> = { '0': 'solo' };
  const spans: TraceSpan[] = [];

  it('produces 1 node', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.nodes).toHaveLength(1);
  });

  it('produces 0 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.edges).toHaveLength(0);
  });

  it('shape is single_agent', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.workflowShape).toBe('single_agent');
  });
});

// ---------------------------------------------------------------------------
// 3. Cyclic workflow: A → B → A
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — cyclic workflow', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentB', score: 0.85 }),
      makeHandoff({ sourceAgent: 'agentB', targetAgent: 'agentA', score: 0.75 }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'agentA' }),
      makeTurn({ turnIndex: 1, agentName: 'agentB' }),
      makeTurn({ turnIndex: 2, agentName: 'agentA' }),
    ],
    totalTurns: 3,
  });
  const agentMap: Record<string, string> = { '0': 'agentA', '1': 'agentB' };
  const spans: TraceSpan[] = [];

  it('shape is cyclic', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.workflowShape).toBe('cyclic');
  });

  it('has an edge from agentA to agentB', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeDefined();
  });

  it('has an edge from agentB back to agentA', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges.find(e => e.source === 'agentB' && e.target === 'agentA');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Branching workflow: A → B and A → C
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — branching workflow', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentB', score: 0.9 }),
      makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentC', score: 0.8 }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'agentA' }),
      makeTurn({ turnIndex: 1, agentName: 'agentB' }),
      makeTurn({ turnIndex: 2, agentName: 'agentC' }),
    ],
    totalTurns: 3,
  });
  const agentMap: Record<string, string> = { '0': 'agentA', '1': 'agentB', '2': 'agentC' };
  const spans: TraceSpan[] = [];

  it('shape is branching', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.workflowShape).toBe('branching');
  });
});

// ---------------------------------------------------------------------------
// 5. Node data binding from turns
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — node data binding', () => {
  const evaluation = makeEvaluation({
    handoffs: [],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'worker', relevance: 0.65, taskProgress: 0.7, hasError: true }),
    ],
    totalTurns: 1,
  });
  const agentMap: Record<string, string> = { '0': 'worker' };
  const spans: TraceSpan[] = [
    makeSpan({ attributes: { 'gen_ai.agent.name': 'worker', 'llm.usage.total_tokens': 512 }, durationMs: 2500 }),
    makeSpan({ spanId: 'span-2', name: 'tool_call', attributes: { 'gen_ai.agent.name': 'worker' } }),
  ];

  it('node evaluationScore reflects turn relevance', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.evaluationScore).toBeCloseTo(0.65, 5);
  });

  it('node hasError is true when any turn has an error', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.hasError).toBe(true);
  });

  it('node turnCount matches turn count for that agent', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.turnCount).toBe(1);
  });

  it('node label matches agent name', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.label).toBe('worker');
  });
});

// ---------------------------------------------------------------------------
// 6. Edge data binding from handoffs
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — edge data binding', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentB', score: 0.72, contextPreserved: false }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'agentA' }),
      makeTurn({ turnIndex: 1, agentName: 'agentB' }),
    ],
    totalTurns: 2,
  });
  const agentMap: Record<string, string> = { '0': 'agentA', '1': 'agentB' };
  const spans: TraceSpan[] = [];

  it('edge handoffScore matches handoff score', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.handoffScore).toBeCloseTo(0.72, 5);
  });

  it('edge contextPreserved is false when handoff contextPreserved is false', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.contextPreserved).toBe(false);
  });

  it('edge label is formatted as "score: X.XX"', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.label).toBe('score: 0.72');
  });

  it('edge id is non-empty string', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const edge = graph.edges[0];
    expect(typeof edge?.id).toBe('string');
    expect(edge?.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Empty / null evaluation
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — null evaluation', () => {
  const spans: TraceSpan[] = [];
  const agentMap: Record<string, string> = {};

  it('returns 0 nodes', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, agentMap, spans);
    expect(graph.nodes).toHaveLength(0);
  });

  it('returns 0 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, agentMap, spans);
    expect(graph.edges).toHaveLength(0);
  });

  it('rootNodeId is null', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, agentMap, spans);
    expect(graph.rootNodeId).toBeNull();
  });

  it('workflowShape is single_agent for empty/null input', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, agentMap, spans);
    expect(graph.workflowShape).toBe('single_agent');
  });
});

// ---------------------------------------------------------------------------
// 8. Root node is the first agent in the workflow
// ---------------------------------------------------------------------------

describe('buildWorkflowGraph — root node identification', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'orchestrator', targetAgent: 'executor', score: 0.88 }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'orchestrator' }),
      makeTurn({ turnIndex: 1, agentName: 'executor' }),
    ],
    totalTurns: 2,
  });
  const agentMap: Record<string, string> = { '0': 'orchestrator', '1': 'executor' };
  const spans: TraceSpan[] = [];

  it('rootNodeId is orchestrator (the first agent)', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    expect(graph.rootNodeId).toBe('orchestrator');
  });

  it('rootNodeId corresponds to an existing node id', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, agentMap, spans);
    const rootNode = graph.nodes.find(n => n.id === graph.rootNodeId);
    expect(rootNode).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Span-inference fallback (evaluation === null, spans carry gen_ai.agent.id)
// ---------------------------------------------------------------------------

const ATTR_AGENT_ID = 'gen_ai.agent.id';

describe('buildWorkflowGraph — span-inference fallback', () => {
  it('infers 2 nodes from spans when evaluation is null', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 3_000, endTimeUnixNano: 4_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    expect(graph.nodes).toHaveLength(2);
  });

  it('infers sequential edge when agent A spans end before agent B spans start', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 3_000, endTimeUnixNano: 4_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeDefined();
  });

  it('sets rootNodeId to the agent with the earliest span start time', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 500, endTimeUnixNano: 900, durationMs: 0.4 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    expect(graph.rootNodeId).toBe('agentA');
  });

  it('sets node hasError to true when any span for that agent has status.code === 2', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, status: { code: 2 }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    const node = graph.nodes.find(n => n.id === 'agentA');
    expect(node?.hasError).toBe(true);
  });

  it('returns empty graph when evaluation is null and no spans have gen_ai.agent.id', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { 'some.other.attr': 'value' } }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('counts tool calls from span names starting with "tool:"', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', name: 'tool:search', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 1_500, durationMs: 0.5 }),
      makeSpan({ spanId: 's2', name: 'tool:write', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_500, endTimeUnixNano: 2_000, durationMs: 0.5 }),
      makeSpan({ spanId: 's3', name: 'agent_turn', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 500, endTimeUnixNano: 1_000, durationMs: 0.5 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, {}, spans);
    const node = graph.nodes.find(n => n.id === 'agentA');
    expect(node?.toolCallCount).toBe(2);
  });
});
