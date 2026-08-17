/**
 * API route tests: /api/agents and /api/agents/:sessionId.
 * Approach A — Node routes with mocked data-loader and parent-boundary modules.
 *
 * Fixtures are typed against the real parent types (via `../types.js`, which is
 * type-only and so erased — safe under `parentDistStub` in standalone CI), which
 * makes them drift-detecting rather than merely plausible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/quality-multi-agent.js', () => ({
  computeMultiAgentEvaluation: vi.fn(),
}));

vi.mock('../api/parent/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: (err: unknown) => String(err),
}));

vi.mock('../api/parent/query-traces.js', () => ({
  queryTraces: vi.fn(),
}));

vi.mock('../lib/workflow-graph.js', () => ({
  buildWorkflowGraph: vi.fn(),
}));

vi.mock('../api/data-loader.js', () => ({
  loadEvaluationsByMetric: vi.fn(),
  loadEvaluationsForMetric: vi.fn(),
  loadEvaluationsByTraceId: vi.fn(),
  loadEvaluationsByTraceIds: vi.fn(),
  loadTracesByTraceId: vi.fn(),
  loadTracesBySessionId: vi.fn(),
  loadLogsByTraceId: vi.fn(),
  loadLogsBySessionId: vi.fn(),
  loadVerifications: vi.fn(),
  loadEvaluationsBySessionId: vi.fn(),
  checkHealth: vi.fn(),
}));

import { agentRoutes } from '../api/routes/agents.js';
import { queryTraces } from '../api/parent/query-traces.js';
import { computeMultiAgentEvaluation } from '../api/parent/quality-multi-agent.js';
import { loadEvaluationsByTraceIds, loadTracesBySessionId } from '../api/data-loader.js';
import { buildWorkflowGraph } from '../lib/workflow-graph.js';
import type { AgentDetailResponse, AgentListResponse, ErrorResponse } from './support/api-responses.js';
import type { EvaluationResult, MultiAgentEvaluation } from '../types.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import { EVAL_NANOS, makeEvaluation } from './support/fixtures.js';


/**
 * `queryTraces` decodes OTLP `fixed64` timestamps to `bigint` (parent
 * `numericNanosToEpochNanos` codec), so fixtures must too — a plain number here
 * hides BigInt serialization failures in routes that return raw spans.
 */
/** The loader's own projection — see the same pattern in `api-traces.test.ts`. */
type LoadedSpan = Awaited<ReturnType<typeof loadTracesBySessionId>>[number];

function makeSpan(traceId = 'trace-001', spanId = 'span-001', agentName = 'general-purpose', attrs: Record<string, unknown> = {}): LoadedSpan {
  return {
    traceId,
    spanId,
    name: 'hook:agent-post-tool',
    kind: 'INTERNAL',
    startTimeUnixNano: 1737000000_000_000_000n,
    endTimeUnixNano: 1737000001_000_000_000n,
    durationMs: 1000,
    // `status.code` is an OTLP enum name, not the numeric `0` this used to pass.
    status: { code: 'OK' },
    attributes: {
      'gen_ai.agent.name': agentName,
      'integritystudio.agent.has_error': false,
      'integritystudio.agent.has_rate_limit': false,
      'integritystudio.agent.output_size': 500,
      'integritystudio.agent.source_type': 'active',
      'session.id': 'sess-001',
      ...attrs,
    },
  };
}

function makeMockQueryResult(spans: LoadedSpan[] = []): Awaited<ReturnType<typeof queryTraces>> {
  return { count: spans.length, traces: spans };
}

const MOCK_MULTI_AGENT: MultiAgentEvaluation = {
  handoffs: [],
  turns: [],
  handoffScore: null,
  avgTurnRelevance: null,
  conversationCompleteness: null,
  totalTurns: 0,
  errorPropagationTurns: 0,
};

const MOCK_GRAPH: WorkflowGraph = {
  nodes: [],
  edges: [],
  rootNodeId: null,
  workflowShape: 'single_agent',
  droppedTurns: 0,
};

function makeMockEval(traceId = 'trace-001'): EvaluationResult {
  return makeEvaluation({ traceId, scoreValue: 0.9, explanation: '', timestamp: EVAL_NANOS });
}


describe('GET /agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult());
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([]);
  });

  it('returns 400 for invalid period', async () => {
    const res = await agentRoutes.request('/agents?period=99d');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with empty agents array when no spans', async () => {
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentListResponse;
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(0);
    expect(body.period).toBe('7d');
  });

  it('returns period, startDate, endDate in response', async () => {
    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body).toHaveProperty('period', '7d');
    expect(body).toHaveProperty('startDate');
    expect(body).toHaveProperty('endDate');
  });

  it('aggregates spans into agent records', async () => {
    const spans = [
      makeSpan('trace-001', 'span-001', 'general-purpose', { 'session.id': 'sess-001' }),
      makeSpan('trace-002', 'span-002', 'general-purpose', { 'session.id': 'sess-002' }),
    ];
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult(spans));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.agentName).toBe('general-purpose');
    expect(body.agents[0]!.invocations).toBe(2);
  });

  it('computes errorRate correctly', async () => {
    const spans = [
      makeSpan('trace-001', 'span-001', 'general-purpose', { 'integritystudio.agent.has_error': true }),
      makeSpan('trace-002', 'span-002', 'general-purpose', { 'integritystudio.agent.has_error': false }),
    ];
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult(spans));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents[0]!.errorRate).toBeCloseTo(0.5, 3);
  });

  it('agent record has required fields', async () => {
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult([makeSpan()]));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    const agent = body.agents[0];
    expect(agent).toHaveProperty('agentName');
    expect(agent).toHaveProperty('invocations');
    expect(agent).toHaveProperty('errors');
    expect(agent).toHaveProperty('errorRate');
    expect(agent).toHaveProperty('sessionCount');
    expect(agent).toHaveProperty('dailyCounts');
    expect(agent).toHaveProperty('sourceTypes');
    expect(agent).toHaveProperty('evalSummary');
  });

  it('sorts agents by invocations descending', async () => {
    const spans = [
      makeSpan('trace-r', 'span-r', 'rare-agent'),
      makeSpan('trace-b1', 'span-b1', 'busy-agent'),
      makeSpan('trace-b2', 'span-b2', 'busy-agent'),
    ];
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult(spans));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents[0]!.agentName).toBe('busy-agent');
    expect(body.agents[0]!.invocations).toBe(2);
    expect(body.agents[1]!.invocations).toBe(1);
  });

  it('joins evaluation scores to agents via traceId', async () => {
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult([makeSpan('trace-eval-001')]));
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([makeMockEval('trace-eval-001')]);

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents[0]!.evalSummary).toHaveProperty('relevance');
    expect(body.agents[0]!.evalSummary.relevance!.avg).toBeCloseTo(0.9, 3);
    expect(body.agents[0]!.evalSummary.relevance!.count).toBe(1);
  });

  it('returns 500 when queryTraces throws', async () => {
    vi.mocked(queryTraces).mockRejectedValue(new Error('JSONL read error'));
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(500);
  });
});


describe('GET /agents/:sessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTracesBySessionId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue(MOCK_MULTI_AGENT);
    vi.mocked(buildWorkflowGraph).mockReturnValue(MOCK_GRAPH);
  });

  it('returns 200 with sessionId, spans, evaluation, evaluations', async () => {
    const res = await agentRoutes.request('/agents/sess-abc');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDetailResponse;
    expect(body).toHaveProperty('sessionId', 'sess-abc');
    expect(body).toHaveProperty('spans');
    expect(body).toHaveProperty('evaluation');
    expect(body).toHaveProperty('evaluations');
    expect(body).toHaveProperty('agentMap');
  });

  it('returns spans from data-loader', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()]);

    const res = await agentRoutes.request('/agents/sess-abc');
    const body = (await res.json()) as AgentDetailResponse;
    expect(body.spans).toHaveLength(1);
  });

  it('serializes bigint nanosecond timestamps instead of throwing', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()]);

    const res = await agentRoutes.request('/agents/sess-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { spans: { startTimeUnixNano: string }[] };
    expect(body.spans[0]!.startTimeUnixNano).toBe('1737000000000000000');
  });

  it('calls computeMultiAgentEvaluation with step scores', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()]);

    await agentRoutes.request('/agents/sess-abc');
    expect(vi.mocked(computeMultiAgentEvaluation)).toHaveBeenCalled();
  });

  it('returns 500 when loadTracesBySessionId throws', async () => {
    vi.mocked(loadTracesBySessionId).mockRejectedValue(new Error('session not found'));
    const res = await agentRoutes.request('/agents/sess-abc');
    expect(res.status).toBe(500);
  });

  it('returns graph field from buildWorkflowGraph', async () => {
    const mockGraph: WorkflowGraph = {
      ...MOCK_GRAPH,
      nodes: [{
        id: 'a',
        label: 'general-purpose',
        evaluationScore: null,
        toolCallCount: 0,
        totalTokens: null,
        durationMs: 0,
        turnCount: 1,
        hasError: false,
      }],
      rootNodeId: 'a',
    };
    vi.mocked(buildWorkflowGraph).mockReturnValue(mockGraph);

    const res = await agentRoutes.request('/agents/sess-abc');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDetailResponse;
    expect(body).toHaveProperty('graph');
    expect(body.graph).toEqual(mockGraph);
  });
});
