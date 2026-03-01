/**
 * API route tests: /api/sessions/:sessionId.
 *
 * This is the most complex route — it builds 17+ response fields from
 * spans, logs, and evaluations. Tests verify the response contract shape
 * rather than every derived field.
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

import { sessionRoutes } from '../api/routes/sessions.js';
import { queryTraces } from '../../../dist/tools/query-traces.js';
import { computeMultiAgentEvaluation } from '../../../dist/lib/quality-multi-agent.js';
import { loadEvaluationsBySessionId, loadLogsBySessionId } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(name = 'hook:builtin-post-tool', attrs: Record<string, unknown> = {}) {
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name,
    startTimeUnixNano: 1737000000_000_000_000,
    endTimeUnixNano: 1737000001_000_000_000,
    durationMs: 1000,
    status: { code: 0 },
    attributes: {
      'session.id': 'sess-abc',
      'builtin.tool': 'Read',
      ...attrs,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /sessions/:sessionId', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(queryTraces).mockResolvedValue({ traces: [] } as any);
    vi.mocked(loadLogsBySessionId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsBySessionId).mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeMultiAgentEvaluation).mockReturnValue({ overallScore: 1 } as any);
  });

  it('returns 200 with sessionId in response', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('sessionId', 'sess-abc');
  });

  it('returns dataSources summary', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('dataSources');
    const ds = body.dataSources as Record<string, unknown>;
    expect(ds).toHaveProperty('traces');
    expect(ds).toHaveProperty('logs');
    expect(ds).toHaveProperty('evaluations');
    expect(ds).toHaveProperty('total');
  });

  it('returns token totals and tool usage', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('tokenTotals');
    expect(body).toHaveProperty('toolUsage');
  });

  it('returns error and agent sections', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('errors');
    expect(body).toHaveProperty('agentActivity');
  });

  it('returns evaluation and log summaries', async () => {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('evaluationBreakdown');
    expect(body).toHaveProperty('logSummary');
    expect(body).toHaveProperty('evaluations');
  });

  it('builds tool usage from span attributes', async () => {
    const toolAttrs = { 'hook.type': 'builtin', 'hook.trigger': 'PostToolUse' };
    const spans = [
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }),
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }),
      makeSpan('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Write' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(queryTraces).mockResolvedValue({ traces: spans } as any);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as { toolUsage: Record<string, number> };
    expect(body.toolUsage.Read).toBe(2);
    expect(body.toolUsage.Write).toBe(1);
  });

  it('computes dataSources total from all sources', async () => {
    const spans = [makeSpan()];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(queryTraces).mockResolvedValue({ traces: spans } as any);
    vi.mocked(loadLogsBySessionId).mockResolvedValue([{ severity: 'INFO' }] as any);
    vi.mocked(loadEvaluationsBySessionId).mockResolvedValue([{ evaluationName: 'relevance' }] as any);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as { dataSources: { total: number } };
    expect(body.dataSources.total).toBe(3); // 1 span + 1 log + 1 eval
  });

  it('returns 500 when queryTraces throws', async () => {
    vi.mocked(queryTraces).mockRejectedValue(new Error('JSONL error'));
    const res = await sessionRoutes.request('/sessions/sess-abc');
    expect(res.status).toBe(500);
  });
});
