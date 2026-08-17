/**
 * API route tests: /api/sessions/:sessionId.
 *
 * This is the most complex route — it builds 17+ response fields from
 * spans, logs, and evaluations. Tests verify the response contract shape
 * rather than every derived field.
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

import { sessionRoutes } from '../api/routes/sessions.js';
import { queryTraces } from '../api/parent/query-traces.js';
import { computeMultiAgentEvaluation } from '../api/parent/quality-multi-agent.js';
import { loadEvaluationsBySessionId, loadLogsBySessionId } from '../api/data-loader.js';
import type { SessionDetailResponse } from './support/api-responses.js';
import type { MultiAgentEvaluation } from '../types.js';
import { makeEvaluation } from './support/fixtures.js';

beforeEach(vi.clearAllMocks);

/**
 * Typed off `loadLogsBySessionId`'s own return type, not `LogRecord`: the loader
 * projects logs down to five fields and renders `timestamp` as an ISO string,
 * where `LogRecord.timestamp` is epoch-nanos `bigint`. `spanId` and
 * `severityNumber` do not survive the projection.
 */
function makeLog(overrides: Partial<LoadedLog> = {}): LoadedLog {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    severity: 'INFO',
    body: 'log body',
    traceId: undefined,
    attributes: undefined,
    ...overrides,
  };
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


type QueriedSpan = Awaited<ReturnType<typeof queryTraces>>['traces'][number];
type LoadedLog = Awaited<ReturnType<typeof loadLogsBySessionId>>[number];

/**
 * Nanos are `bigint` and `status.code` is an OTLP enum name — this fixture
 * previously used plain numbers for both, held up by `as any`.
 */
function makeSpan(name = 'hook:builtin-post-tool', attrs: Record<string, unknown> = {}): QueriedSpan {
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name,
    kind: 'INTERNAL',
    startTimeUnixNano: 1737000000_000_000_000n,
    endTimeUnixNano: 1737000001_000_000_000n,
    durationMs: 1000,
    status: { code: 'OK' },
    attributes: {
      'session.id': 'sess-abc',
      'builtin.tool': 'Read',
      ...attrs,
    },
  };
}


describe('GET /sessions/:sessionId', () => {
  beforeEach(() => {
    vi.mocked(queryTraces).mockResolvedValue({ count: 0, traces: [] });
    vi.mocked(loadLogsBySessionId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsBySessionId).mockResolvedValue([]);
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue(MOCK_MULTI_AGENT);
  });

  it('returns 200 with sessionId in response', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    expect(res.status).toBe(200);
    const body = await res.json() as SessionDetailResponse;
    expect(body).toHaveProperty('sessionId', 'sess-abc');
  });

  it('returns dataSources summary', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body).toHaveProperty('dataSources');
    const ds = body.dataSources as Record<string, unknown>;
    expect(ds).toHaveProperty('traces');
    expect(ds).toHaveProperty('logs');
    expect(ds).toHaveProperty('evaluations');
    expect(ds).toHaveProperty('total');
  });

  it('returns token totals and tool usage', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body).toHaveProperty('tokenTotals');
    expect(body).toHaveProperty('toolUsage');
  });

  it('returns error and agent sections', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body).toHaveProperty('errors');
    expect(body).toHaveProperty('agentActivity');
  });

  it('returns evaluation and log summaries', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body).toHaveProperty('evaluationBreakdown');
    expect(body).toHaveProperty('logSummary');
    expect(body).toHaveProperty('evaluations');
  });

  it('strips sensitive fields from logSummary.logs', async () => {
    vi.mocked(loadLogsBySessionId).mockResolvedValue([makeLog({
      body: 'secret content',
      traceId: 'trace-1',
      attributes: { 'user.token': 'abc123' },
    })]);
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('logSummary');
    const log = body.logSummary.logs[0];
    expect(log).not.toHaveProperty('body');
    expect(log).not.toHaveProperty('attributes');
    expect(log).not.toHaveProperty('extractedFields');
    expect(log).toHaveProperty('severity', 'INFO');
    expect(log).toHaveProperty('timestamp', '2026-01-01T00:00:00.000Z');
    expect(log).toHaveProperty('traceId', 'trace-1');
  });

  it('builds tool usage from span attributes', async () => {
    const toolAttrs = { 'integritystudio.hook.type': 'builtin', 'integritystudio.hook.trigger': 'PostToolUse' };
    const spans = [
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }),
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }),
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Write' }),
    ];
    vi.mocked(queryTraces).mockResolvedValue({ count: spans.length, traces: spans });

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body.toolUsage.Read).toBe(2);
    expect(body.toolUsage.Write).toBe(1);
  });

  it('computes dataSources total from all sources', async () => {
    const spans = [makeSpan()];
    vi.mocked(queryTraces).mockResolvedValue({ count: spans.length, traces: spans });
    vi.mocked(loadLogsBySessionId).mockResolvedValue([makeLog()]);
    vi.mocked(loadEvaluationsBySessionId).mockResolvedValue([makeEvaluation()]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body.dataSources.total).toBe(3); // 1 span + 1 log + 1 eval
  });

  it('returns 500 when queryTraces throws', async () => {
    vi.mocked(queryTraces).mockRejectedValue(new Error('JSONL error'));
    const res = await sessionRoutes.request('/sessions/sess-abc');
    expect(res.status).toBe(500);
  });
});
