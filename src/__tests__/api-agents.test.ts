/**
 * API route tests: /api/agents and /api/agents/:sessionId.
 * Approach A — Node routes with mocked data-loader and dist dependencies.
 *
 * Mock return values use `as any` since the dist types (TraceSpan, EvaluationResult,
 * MultiAgentEvaluation) are complex and come from virtual modules via parentDistStub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-multi-agent.js', () => ({
  computeMultiAgentEvaluation: vi.fn(),
}));

vi.mock('../../../dist/lib/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: (err: unknown) => String(err),
}));

vi.mock('../../../dist/tools/query-traces.js', () => ({
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
import { queryTraces } from '../../../dist/tools/query-traces.js';
import { computeMultiAgentEvaluation } from '../../../dist/lib/quality-multi-agent.js';
import { loadEvaluationsByTraceIds, loadTracesBySessionId } from '../api/data-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(traceId = 'trace-001', spanId = 'span-001', agentName = 'general-purpose', attrs: Record<string, unknown> = {}) {
  return {
    traceId,
    spanId,
    name: 'hook:agent-post-tool',
    startTimeUnixNano: 1737000000_000_000_000,
    status: { code: 0 },
    attributes: {
      'gen_ai.agent.name': agentName,
      'agent.has_error': false,
      'agent.has_rate_limit': false,
      'agent.output_size': 500,
      'agent.source_type': 'active',
      'session.id': 'sess-001',
      ...attrs,
    },
  };
}

function makeMockQueryResult(spans: ReturnType<typeof makeSpan>[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { traces: spans } as any;
}

function makeMockEval(traceId = 'trace-001') {
  return {
    evaluationName: 'relevance',
    scoreValue: 0.9,
    traceId,
    timestamp: '2026-01-15T12:00:00.000Z',
    evaluatorType: 'seed',
    scoreLabel: 'relevant',
    explanation: '',
    evaluator: 'seed',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// /agents route
// ---------------------------------------------------------------------------

describe('GET /agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult());
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([]);
  });

  it('returns 400 for invalid period', async () => {
    const res = await agentRoutes.request('/agents?period=99d');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with empty agents array when no spans', async () => {
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: unknown[]; period: string };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(0);
    expect(body.period).toBe('7d');
  });

  it('returns period, startDate, endDate in response', async () => {
    const res = await agentRoutes.request('/agents?period=7d');
    const body = await res.json() as Record<string, unknown>;
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
    const body = await res.json() as { agents: Array<{ agentName: string; invocations: number }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agentName).toBe('general-purpose');
    expect(body.agents[0].invocations).toBe(2);
  });

  it('computes errorRate correctly', async () => {
    const spans = [
      makeSpan('trace-001', 'span-001', 'general-purpose', { 'agent.has_error': true }),
      makeSpan('trace-002', 'span-002', 'general-purpose', { 'agent.has_error': false }),
    ];
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult(spans));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = await res.json() as { agents: Array<{ errorRate: number }> };
    expect(body.agents[0].errorRate).toBeCloseTo(0.5, 3);
  });

  it('agent record has required fields', async () => {
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult([makeSpan()]));

    const res = await agentRoutes.request('/agents?period=7d');
    const body = await res.json() as { agents: Array<Record<string, unknown>> };
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
    const body = await res.json() as { agents: Array<{ agentName: string; invocations: number }> };
    expect(body.agents[0].agentName).toBe('busy-agent');
    expect(body.agents[0].invocations).toBe(2);
    expect(body.agents[1].invocations).toBe(1);
  });

  it('joins evaluation scores to agents via traceId', async () => {
    vi.mocked(queryTraces).mockResolvedValue(makeMockQueryResult([makeSpan('trace-eval-001')]));
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([makeMockEval('trace-eval-001')]);

    const res = await agentRoutes.request('/agents?period=7d');
    const body = await res.json() as { agents: Array<{ evalSummary: Record<string, { avg: number; count: number }> }> };
    expect(body.agents[0].evalSummary).toHaveProperty('relevance');
    expect(body.agents[0].evalSummary.relevance.avg).toBeCloseTo(0.9, 3);
    expect(body.agents[0].evalSummary.relevance.count).toBe(1);
  });

  it('returns 500 when queryTraces throws', async () => {
    vi.mocked(queryTraces).mockRejectedValue(new Error('JSONL read error'));
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /agents/:sessionId route
// ---------------------------------------------------------------------------

describe('GET /agents/:sessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTracesBySessionId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsByTraceIds).mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue({ overallScore: 1, agentScores: {}, trajectory: [] } as any);
  });

  it('returns 200 with sessionId, spans, evaluation, evaluations', async () => {
    const res = await agentRoutes.request('/agents/sess-abc');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('sessionId', 'sess-abc');
    expect(body).toHaveProperty('spans');
    expect(body).toHaveProperty('evaluation');
    expect(body).toHaveProperty('evaluations');
    expect(body).toHaveProperty('agentMap');
  });

  it('returns spans from data-loader', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()] as any);

    const res = await agentRoutes.request('/agents/sess-abc');
    const body = await res.json() as { spans: unknown[] };
    expect(body.spans).toHaveLength(1);
  });

  it('calls computeMultiAgentEvaluation with step scores', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadTracesBySessionId).mockResolvedValue([makeSpan()] as any);

    await agentRoutes.request('/agents/sess-abc');
    expect(vi.mocked(computeMultiAgentEvaluation)).toHaveBeenCalled();
  });

  it('returns 500 when loadTracesBySessionId throws', async () => {
    vi.mocked(loadTracesBySessionId).mockRejectedValue(new Error('session not found'));
    const res = await agentRoutes.request('/agents/sess-abc');
    expect(res.status).toBe(500);
  });
});
