/**
 * API route tests: /api/sessions/:sessionId.
 *
 * Approach C — fixture HTTP server. The real queryTraces (Zod validation),
 * data-loader, and CloudBackend run end-to-end. computeMultiAgentEvaluation
 * stays mocked (pure computation over loaded spans — no HTTP path).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire, spanToWire, logToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-multi-agent.js', () => ({
  computeMultiAgentEvaluation: vi.fn(),
}));

import { sessionRoutes } from '../api/routes/sessions.js';
import { computeMultiAgentEvaluation } from '../api/parent/quality-multi-agent.js';
import type { SessionDetailResponse } from './support/api-responses.js';
import type { MultiAgentEvaluation } from '../types.js';
import { makeEvaluation } from './support/fixtures.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

const MOCK_MULTI_AGENT: MultiAgentEvaluation = {
  handoffs: [],
  turns: [],
  handoffScore: null,
  avgTurnRelevance: null,
  conversationCompleteness: null,
  totalTurns: 0,
  errorPropagationTurns: 0,
};

function makeSessionSpanWire(name = 'hook:builtin-post-tool', attrs: Record<string, unknown> = {}) {
  return spanToWire({
    traceId: 'trace-001',
    spanId: 'span-001',
    name,
    kind: 'INTERNAL',
    startTimeUnixNano: 1737000000_000_000_000n,
    endTimeUnixNano: 1737000001_000_000_000n,
    attributes: {
      'session.id': 'sess-abc',
      'builtin.tool': 'Read',
      ...attrs,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  vi.mocked(computeMultiAgentEvaluation).mockReturnValue(MOCK_MULTI_AGENT);
});

describe('GET /sessions/:sessionId', () => {
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
    fixture.setLogs([logToWire({
      timestamp: '2026-01-01T00:00:00.000Z',
      severity: 'INFO',
      body: 'secret content',
      traceId: 'trace-1',
      // session.id must be set so the client-side sessionId filter in queryLogs passes.
      attributes: { 'user.token': 'abc123', 'session.id': 'sess-abc' },
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
    fixture.setTraces([
      makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }),
      { ...makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Read' }), span_id: 'span-002', trace_id: 'trace-002' },
      { ...makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Write' }), span_id: 'span-003', trace_id: 'trace-003' },
    ]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body.toolUsage.Read).toBe(2);
    expect(body.toolUsage.Write).toBe(1);
  });

  it('computes dataSources total from all sources', async () => {
    fixture.setTraces([makeSessionSpanWire()]);
    // session.id must be in attributes so the client-side sessionId filter passes.
    fixture.setLogs([logToWire({ timestamp: '2026-01-01T00:00:00.000Z', attributes: { 'session.id': 'sess-abc' } })]);
    fixture.setEvals([evalToWire(makeEvaluation({ sessionId: 'sess-abc' }))]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;
    expect(body.dataSources.total).toBe(3); // 1 span + 1 log + 1 eval
  });

  it('returns 500 when queryTraces throws', async () => {
    fixture.failPath('/v1/traces');
    const res = await sessionRoutes.request('/sessions/sess-abc');
    expect(res.status).toBe(500);
  });
});
