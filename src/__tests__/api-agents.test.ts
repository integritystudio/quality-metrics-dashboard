/**
 * API route tests: /api/agents and /api/agents/:sessionId.
 * Approach A — Node routes with mocked data-loader and parent-boundary modules.
 *
 * Fixtures are typed against the real parent types (via `../types.js`, which is
 * type-only and so erased — safe under `parentDistStub` in standalone CI), which
 * makes them drift-detecting rather than merely plausible.
 *
 * `buildWorkflowGraph` is deliberately NOT mocked. It is a local module whose only
 * imports are types plus `constants.ts`/`quality-utils.ts`, so nothing in it reaches
 * `@parent` at runtime and the standalone-CI stub does not apply — the reason the
 * parent-boundary modules below must stay mocked does not extend to it. Mocking it
 * made the graph assertions tautological (return X, assert X) while the real
 * construction never ran.
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
import type { AgentDetailResponse, AgentListResponse, ErrorResponse } from './support/api-responses.js';
import type { EvaluationResult, MultiAgentEvaluation } from '../types.js';
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

  /**
   * Exercises the real `buildWorkflowGraph`. With turns present the evaluation path
   * runs, so nodes come from `evaluation.turns` and their metrics are joined from the
   * spans by `gen_ai.agent.name`.
   */
  it('builds graph nodes from the evaluation turns', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([
      makeSpan('trace-001', 'span-001', 'planner'),
      makeSpan('trace-001', 'span-002', 'writer'),
    ]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue({
      ...MOCK_MULTI_AGENT,
      totalTurns: 2,
      turns: [
        { turnIndex: 0, agentName: 'planner', relevance: 0.9, taskProgress: 0.5, hasError: false },
        { turnIndex: 1, agentName: 'writer', relevance: 0.7, taskProgress: 1, hasError: false },
      ],
    });

    const res = await agentRoutes.request('/agents/sess-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDetailResponse;
    expect(body.graph.nodes.map((n) => n.id).sort()).toEqual(['planner', 'writer']);
    // Root is the agent holding the lowest turnIndex, not merely the first seen.
    expect(body.graph.rootNodeId).toBe('planner');
    expect(body.graph.nodes.find((n) => n.id === 'planner')?.evaluationScore).toBeCloseTo(0.9, 3);
    expect(body.graph.droppedTurns).toBe(0);
  });

  /** A turn with no agent cannot become a node, and the graph reports that it lost one. */
  it('counts turns dropped for having no agent name', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue({
      ...MOCK_MULTI_AGENT,
      totalTurns: 2,
      turns: [
        { turnIndex: 0, agentName: 'planner', relevance: 0.9, taskProgress: 0.5, hasError: false },
        { turnIndex: 1, relevance: 0.4, taskProgress: 0, hasError: true },
      ],
    });

    const res = await agentRoutes.request('/agents/sess-abc');

    const body = (await res.json()) as AgentDetailResponse;
    expect(body.graph.nodes).toHaveLength(1);
    expect(body.graph.droppedTurns).toBe(1);
  });

  /**
   * With no evaluation the builder falls back to inferring the workflow from span
   * timings alone — a sequential pair yields an edge between them, which the mocked
   * version could never have shown.
   *
   * Note the two paths key on different attributes: the evaluation path joins spans by
   * `gen_ai.agent.name`, while inference groups by `gen_ai.agent.id`, so node identity
   * here is the agent *id*. Both are emitted by the hooks (`pre-tool.ts`,
   * `post-tool.ts`), but `gen_ai.agent.id` only when the invocation carries one — a
   * span without it contributes nothing to an inferred graph.
   */
  it('infers a sequential edge from span timings when there is no evaluation', async () => {
    const first = makeSpan('trace-001', 'span-001', 'planner', { 'gen_ai.agent.id': 'planner-1' });
    const second = makeSpan('trace-001', 'span-002', 'writer', { 'gen_ai.agent.id': 'writer-1' });
    second.startTimeUnixNano = first.endTimeUnixNano! + 5_000_000n;
    second.endTimeUnixNano = second.startTimeUnixNano + 1_000_000_000n;
    vi.mocked(loadTracesBySessionId).mockResolvedValue([first, second]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue(null as unknown as MultiAgentEvaluation);

    const res = await agentRoutes.request('/agents/sess-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDetailResponse;
    expect(body.graph.rootNodeId).toBe('planner-1');
    expect(body.graph.edges).toHaveLength(1);
    expect(body.graph.edges[0]).toMatchObject({ source: 'planner-1', target: 'writer-1' });
    // `null` marks an inferred edge, distinguishing it from a real handoff score of 0.
    expect(body.graph.edges[0]!.handoffScore).toBeNull();
  });

  /** A span with no `gen_ai.agent.id` cannot be grouped, so inference yields nothing. */
  it('returns an empty inferred graph when spans carry no agent id', async () => {
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue(null as unknown as MultiAgentEvaluation);

    const res = await agentRoutes.request('/agents/sess-abc');

    const body = (await res.json()) as AgentDetailResponse;
    expect(body.graph.nodes).toHaveLength(0);
    expect(body.graph.rootNodeId).toBeNull();
  });
});
