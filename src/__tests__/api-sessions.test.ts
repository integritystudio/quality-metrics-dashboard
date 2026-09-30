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

  // Regression: the hooks renamed builtin.* on 2026-09-18 and this route kept
  // reading the legacy keys, so post-rename sessions showed every tool as
  // 'unknown'. CloudBackend canonicalizes both eras; the route reads canonical.
  it('builds tool usage from post-rename canonical keys and legacy keys alike', async () => {
    const toolAttrs = { 'integritystudio.hook.type': 'builtin', 'integritystudio.hook.trigger': 'PostToolUse' };
    fixture.setTraces([
      makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': undefined, 'gen_ai.tool.name': 'Bash' }),
      { ...makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': undefined, 'gen_ai.tool.name': 'Bash' }), span_id: 'span-002', trace_id: 'trace-002' },
      { ...makeSessionSpanWire('hook:builtin-post-tool', { ...toolAttrs, 'builtin.tool': 'Bash' }), span_id: 'span-003', trace_id: 'trace-003' },
    ]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;

    expect(body.toolUsage).toEqual({ Bash: 3 });
  });

  it('reports a failed tool call from post-rename canonical keys', async () => {
    fixture.setTraces([
      makeSessionSpanWire('hook:builtin-post-tool', {
        'builtin.tool': undefined,
        'gen_ai.tool.name': 'Edit',
        'integritystudio.tool.has_error': true,
        'integritystudio.tool.error_type': 'file_not_read',
        'file.path': '/repo/src/a.ts',
      }),
    ]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;

    expect(body.errors.byCategory).toEqual({ 'Edit -> file_not_read': 1 });
    expect(body.errors.details).toEqual([
      { spanName: 'hook:builtin-post-tool', tool: 'Edit', errorType: 'file_not_read', filePath: '/repo/src/a.ts' },
    ]);
    expect(body.fileAccess).toEqual([{ path: '/repo/src/a.ts', count: 1 }]);
  });

  // Regression: the hooks renamed `agent-post-tool` to `agent.operation.finalize`
  // on 2026-08-13 and this route kept matching the old hook name, so every
  // session reported no agent activity. The name is copied from a real span.
  it('builds agent activity from the finalize hook spans', async () => {
    const finalize = {
      'builtin.tool': undefined,
      'integritystudio.hook.name': 'agent.operation.finalize',
      'gen_ai.agent.name': 'Explore',
      'integritystudio.agent.output_size': 300,
    };
    fixture.setTraces([
      makeSessionSpanWire('hook:agent.operation.finalize', finalize),
      { ...makeSessionSpanWire('hook:agent.operation.finalize', { ...finalize, 'integritystudio.agent.has_error': true }), span_id: 'span-002' },
    ]);

    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;

    expect(body.agentActivity).toEqual([
      { agentName: 'Explore', invocations: 2, errors: 1, hasRateLimit: false, avgOutputSize: 300 },
    ]);
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

// On 2026-09-29 the hooks moved these unprefixed keys under `integritystudio.`.
// CloudBackend rewrites a legacy key only once the alias table has a row for
// it, so the route asks for the new key and falls back to the old one. Every
// case serves one session under one spelling and expects the same body. Hook
// names are copied from real spans.
describe('GET /sessions/:sessionId across the integritystudio.* key rename', () => {
  const VENDOR_PREFIX = 'integritystudio.';
  const DECOY_OFFSET = 1000;
  const SESSION_START = { 'project.name': 'env-settings', 'context.message_count': 4, 'context.estimated_tokens': 9000, 'tasks.active': 2 };
  const TOKEN_METRICS = { 'tokens.messages': 12, 'tokens.input': 100, 'tokens.output': 50, 'tokens.cache_read': 7, 'tokens.cache_creation': 3, 'tokens.model': 'claude-opus-5' };
  const MCP_POST_TOOL = { 'mcp.tool': 'get_me' };
  const ALERT_EVALUATION = { 'alerts.triggered_count': 3 };

  type Attributes = Record<string, unknown>;
  const withPrefix = (attrs: Attributes): Attributes =>
    Object.fromEntries(Object.entries(attrs).map(([key, value]) => [`${VENDOR_PREFIX}${key}`, value]));
  const unprefixed = (attrs: Attributes): Attributes => attrs;
  /** The unprefixed keys holding values no reader should surface when the prefixed key is present. */
  const staleUnprefixed = (attrs: Attributes): Attributes =>
    Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, typeof value === 'number' ? value + DECOY_OFFSET : `stale-${String(value)}`]));

  function hookSpanWire(hookName: string, spanId: string, attributes: Attributes) {
    return {
      ...makeSessionSpanWire(`hook:${hookName}`, { 'builtin.tool': undefined, 'integritystudio.hook.name': hookName, ...attributes }),
      span_id: spanId,
    };
  }

  function serveSession(write: (attrs: Attributes) => Attributes) {
    fixture.setTraces([
      hookSpanWire('session-start', 'span-start', write(SESSION_START)),
      hookSpanWire('token-metrics-extraction', 'span-tokens', write(TOKEN_METRICS)),
      hookSpanWire('mcp-post-tool', 'span-mcp', { 'integritystudio.hook.type': 'mcp', 'integritystudio.hook.trigger': 'PostToolUse', ...write(MCP_POST_TOOL) }),
      hookSpanWire('telemetry-alert-evaluation', 'span-alert', write(ALERT_EVALUATION)),
    ]);
  }

  async function expectSessionRead() {
    const res = await sessionRoutes.request('/sessions/sess-abc');
    const body = await res.json() as SessionDetailResponse;

    expect(res.status).toBe(200);
    expect(body.sessionInfo).toMatchObject({
      projectName: 'env-settings',
      initialMessageCount: 4,
      initialContextTokens: 9000,
      finalMessageCount: 4,
      taskCount: 2,
    });
    expect(body.tokenProgression).toEqual([
      { messages: 12, inputTokens: 100, outputTokens: 50, cacheRead: 7, cacheCreation: 3, model: 'claude-opus-5' },
    ]);
    expect(body.mcpUsage).toEqual({ get_me: 1 });
    expect(body.alertSummary).toMatchObject({ totalFired: 3 });
  }

  it.each([
    ['post-rename integritystudio.*', withPrefix],
    ['pre-rename unprefixed', unprefixed],
  ])('reads %s keys', async (_era, write) => {
    serveSession(write);

    await expectSessionRead();
  });

  it('prefers the integritystudio.* key when a span carries both', async () => {
    serveSession(attrs => ({ ...staleUnprefixed(attrs), ...withPrefix(attrs) }));

    await expectSessionRead();
  });
});
