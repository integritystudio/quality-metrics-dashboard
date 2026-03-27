import { describe, it, expect } from 'vitest';
import { buildWorkflowGraph } from '../lib/workflow-graph.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { TraceSpan } from '../types.js';
import { makeHandoff, makeTurn, makeEvaluation, makeSpan } from './workflow-fixtures.js';

// 1. 3-agent linear workflow

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

  const spans: TraceSpan[] = [];

  it('produces 3 nodes', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.nodes).toHaveLength(3);
  });

  it('produces 2 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.edges).toHaveLength(2);
  });

  it('shape is linear', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.workflowShape).toBe('linear');
  });

  it('rootNodeId is planner', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.rootNodeId).toBe('planner');
  });
});

// 2. Single-agent session

describe('buildWorkflowGraph — single-agent session', () => {
  const evaluation = makeEvaluation({
    handoffs: [],
    turns: [makeTurn({ turnIndex: 0, agentName: 'solo' })],
    totalTurns: 1,
  });

  const spans: TraceSpan[] = [];

  it('produces 1 node', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.nodes).toHaveLength(1);
  });

  it('produces 0 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.edges).toHaveLength(0);
  });

  it('shape is single_agent', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.workflowShape).toBe('single_agent');
  });
});

// 3. Cyclic workflow: A → B → A

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

  const spans: TraceSpan[] = [];

  it('shape is cyclic', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.workflowShape).toBe('cyclic');
  });

  it('has an edge from agentA to agentB', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeDefined();
  });

  it('has an edge from agentB back to agentA', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentB' && e.target === 'agentA');
    expect(edge).toBeDefined();
  });
});

// 3b. 3-node cyclic workflow: A → B → C → A (WG-M1)

describe('buildWorkflowGraph — 3-node cyclic workflow A→B→C→A', () => {
  const evaluation = makeEvaluation({
    handoffs: [
      makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentB', score: 0.9 }),
      makeHandoff({ sourceAgent: 'agentB', targetAgent: 'agentC', score: 0.8 }),
      makeHandoff({ sourceAgent: 'agentC', targetAgent: 'agentA', score: 0.7 }),
    ],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'agentA' }),
      makeTurn({ turnIndex: 1, agentName: 'agentB' }),
      makeTurn({ turnIndex: 2, agentName: 'agentC' }),
    ],
    totalTurns: 3,
  });

  const spans: TraceSpan[] = [];

  it('shape is cyclic for 3-node cycle', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.workflowShape).toBe('cyclic');
  });

  it('produces 3 nodes', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.nodes).toHaveLength(3);
  });
});

// 4. Branching workflow: A → B and A → C

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

  const spans: TraceSpan[] = [];

  it('shape is branching', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.workflowShape).toBe('branching');
  });
});

// 5. Node data binding from turns

describe('buildWorkflowGraph — node data binding', () => {
  const evaluation = makeEvaluation({
    handoffs: [],
    turns: [
      makeTurn({ turnIndex: 0, agentName: 'worker', relevance: 0.65, taskProgress: 0.7, hasError: true }),
    ],
    totalTurns: 1,
  });

  const spans: TraceSpan[] = [
    makeSpan({ attributes: { 'gen_ai.agent.name': 'worker', 'llm.usage.total_tokens': 512 }, durationMs: 2500 }),
    makeSpan({ spanId: 'span-2', name: 'tool_call', attributes: { 'gen_ai.agent.name': 'worker' } }),
  ];

  it('node evaluationScore reflects turn relevance', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.evaluationScore).toBeCloseTo(0.65, 5);
  });

  it('node hasError is true when any turn has an error', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.hasError).toBe(true);
  });

  it('node turnCount matches turn count for that agent', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.turnCount).toBe(1);
  });

  it('node label matches agent name', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const node = graph.nodes.find(n => n.id === 'worker');
    expect(node?.label).toBe('worker');
  });
});

// 6. Edge data binding from handoffs

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

  const spans: TraceSpan[] = [];

  it('edge handoffScore matches handoff score', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.handoffScore).toBeCloseTo(0.72, 5);
  });

  it('edge contextPreserved is false when handoff contextPreserved is false', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.contextPreserved).toBe(false);
  });

  it('edge label contains formatted score', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    // Label contains the score; no latency suffix when spans provide no timing data
    expect(edge?.label).toBe('0.72');
  });

  it('edge latencyMs is null when no span timing data', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.latencyMs).toBeNull();
  });

  it('edge latencyMs is computed from span timing when spans are provided', () => {
    // agentA ends at 2_000_000 ns, agentB starts at 7_000_000 ns → gap = 5_000_000 ns = 5 ms
    const spansWithTiming: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { 'gen_ai.agent.name': 'agentA' }, startTimeUnixNano: 1_000_000, endTimeUnixNano: 2_000_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { 'gen_ai.agent.name': 'agentB' }, startTimeUnixNano: 7_000_000, endTimeUnixNano: 9_000_000, durationMs: 2 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spansWithTiming);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge?.latencyMs).toBe(5);
    expect(edge?.label).toBe('0.72 · 5ms');
  });

  it('edge id is non-empty string', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const edge = graph.edges[0];
    expect(typeof edge?.id).toBe('string');
    expect(edge?.id.length).toBeGreaterThan(0);
  });
});

// 7. Empty / null evaluation

describe('buildWorkflowGraph — null evaluation', () => {
  const spans: TraceSpan[] = [];


  it('returns 0 nodes', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.nodes).toHaveLength(0);
  });

  it('returns 0 edges', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.edges).toHaveLength(0);
  });

  it('rootNodeId is null', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.rootNodeId).toBeNull();
  });

  it('workflowShape is single_agent for empty/null input', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.workflowShape).toBe('single_agent');
  });
});

// 8. Root node is the first agent in the workflow

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

  const spans: TraceSpan[] = [];

  it('rootNodeId is orchestrator (the first agent)', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    expect(graph.rootNodeId).toBe('orchestrator');
  });

  it('rootNodeId corresponds to an existing node id', () => {
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, spans);
    const rootNode = graph.nodes.find(n => n.id === graph.rootNodeId);
    expect(rootNode).toBeDefined();
  });
});

// 8b. droppedTurns counter

describe('buildWorkflowGraph — droppedTurns counter', () => {
  it('counts turns where agentName is undefined', () => {
    const evaluation = makeEvaluation({
      turns: [
        makeTurn({ turnIndex: 0, agentName: 'agentA' }),
        { turnIndex: 1, agentName: undefined, relevance: 0, taskProgress: 0, hasError: false },
        { turnIndex: 2, agentName: undefined, relevance: 0, taskProgress: 0, hasError: false },
      ],
      totalTurns: 3,
    });
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, []);
    expect(graph.droppedTurns).toBe(2);
  });

  it('returns droppedTurns 0 when all turns have agentName', () => {
    const evaluation = makeEvaluation({
      turns: [
        makeTurn({ turnIndex: 0, agentName: 'agentA' }),
        makeTurn({ turnIndex: 1, agentName: 'agentB' }),
      ],
      handoffs: [makeHandoff({ sourceAgent: 'agentA', targetAgent: 'agentB' })],
      totalTurns: 2,
    });
    const graph: WorkflowGraph = buildWorkflowGraph(evaluation, []);
    expect(graph.droppedTurns).toBe(0);
  });

  it('returns droppedTurns 0 for span-inferred graphs (no evaluation)', () => {
    const spans = [
      makeSpan({ spanId: 's1', attributes: { 'gen_ai.agent.id': 'agentA' } }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.droppedTurns).toBe(0);
  });
});

// 9. Span-inference fallback (evaluation === null, spans carry gen_ai.agent.id)

const ATTR_AGENT_ID = 'gen_ai.agent.id';

describe('buildWorkflowGraph — span-inference fallback', () => {
  it('infers 2 nodes from spans when evaluation is null', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 3_000, endTimeUnixNano: 4_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.nodes).toHaveLength(2);
  });

  it('infers sequential edge when agent A spans end before agent B spans start', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 3_000, endTimeUnixNano: 4_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeDefined();
  });

  it('sets rootNodeId to the agent with the earliest span start time', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 500, endTimeUnixNano: 900, durationMs: 0.4 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.rootNodeId).toBe('agentA');
  });

  it('sets node hasError to true when any span for that agent has status.code === 2', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, status: { code: 2 }, startTimeUnixNano: 1_000, endTimeUnixNano: 2_000, durationMs: 1 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    const node = graph.nodes.find(n => n.id === 'agentA');
    expect(node?.hasError).toBe(true);
  });

  it('returns empty graph when evaluation is null and no spans have gen_ai.agent.id', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { 'some.other.attr': 'value' } }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('infers edge between near-concurrent spans within epsilon tolerance (WG-M2)', () => {
    // agentA ends at 2_000_000 ns, agentB starts at 2_500_000 ns — gap is 500_000 ns < 1_000_000 ns epsilon
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000_000, endTimeUnixNano: 2_000_000, durationMs: 1 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 2_500_000, endTimeUnixNano: 4_000_000, durationMs: 1.5 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeDefined();
  });

  it('does not infer edge when spans overlap by more than epsilon', () => {
    // agentA ends at 3_000_000 ns, agentB starts at 1_500_000 ns — truly concurrent, gap > epsilon
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000_000, endTimeUnixNano: 3_000_000, durationMs: 2 }),
      makeSpan({ spanId: 's2', attributes: { [ATTR_AGENT_ID]: 'agentB' }, startTimeUnixNano: 1_500_000, endTimeUnixNano: 4_000_000, durationMs: 2.5 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    const edge = graph.edges.find(e => e.source === 'agentA' && e.target === 'agentB');
    expect(edge).toBeUndefined();
  });

  it('counts tool calls from span names starting with "tool:"', () => {
    const spans: TraceSpan[] = [
      makeSpan({ spanId: 's1', name: 'tool:search', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_000, endTimeUnixNano: 1_500, durationMs: 0.5 }),
      makeSpan({ spanId: 's2', name: 'tool:write', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 1_500, endTimeUnixNano: 2_000, durationMs: 0.5 }),
      makeSpan({ spanId: 's3', name: 'agent_turn', attributes: { [ATTR_AGENT_ID]: 'agentA' }, startTimeUnixNano: 500, endTimeUnixNano: 1_000, durationMs: 0.5 }),
    ];
    const graph: WorkflowGraph = buildWorkflowGraph(null, spans);
    const node = graph.nodes.find(n => n.id === 'agentA');
    expect(node?.toolCallCount).toBe(2);
  });
});
