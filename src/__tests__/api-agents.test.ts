/**
 * API route tests: /api/agents and /api/agents/:sessionId.
 *
 * Approach C — fixture HTTP server. The real queryTraces (with Zod validation)
 * and real data-loader run end-to-end against a local stub server. A test run
 * with OBTOOL_API_URL unset fails loudly.
 *
 * This is the critical file for ROUTE-TESTS-MOCK-FREE: the /api/agents 500
 * that ran undetected for the lifetime of the route (until PR #6, 2026-09-14)
 * would have been caught here if the real queryTraces had been running.
 * `buildWorkflowGraph` is deliberately NOT mocked — see original header note.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire, spanToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-multi-agent.js', () => ({
  computeMultiAgentEvaluation: vi.fn(),
}));

import { agentRoutes } from '../api/routes/agents.js';
import { computeMultiAgentEvaluation } from '../api/parent/quality-multi-agent.js';
import type { AgentDetailResponse, AgentListResponse, ErrorResponse } from './support/api-responses.js';
import type { MultiAgentEvaluation } from '../types.js';
import { makeEvaluation, EVAL_NANOS } from './support/fixtures.js';

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

/** Build a wire-format span with agent-specific attributes. */
function makeAgentSpanWire(
  traceId = 'trace-001',
  spanId = 'span-001',
  agentName = 'general-purpose',
  attrs: Record<string, unknown> = {},
) {
  return spanToWire({
    traceId,
    spanId,
    name: 'hook:agent-post-tool',
    kind: 'INTERNAL',
    startTimeUnixNano: 1737000000_000_000_000n,
    endTimeUnixNano: 1737000001_000_000_000n,
    attributes: {
      // 'integritystudio.hook.name' is the attributeFilter key the agents route
      // uses. CloudBackend applies non-sessionId attributeFilter client-side, so
      // this must be present or the span is dropped after fetch.
      'integritystudio.hook.name': 'agent-post-tool',
      'gen_ai.agent.name': agentName,
      'integritystudio.agent.has_error': false,
      'integritystudio.agent.has_rate_limit': false,
      'integritystudio.agent.output_size': 500,
      'integritystudio.agent.source_type': 'active',
      'session.id': 'sess-001',
      ...attrs,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  vi.mocked(computeMultiAgentEvaluation).mockReturnValue(MOCK_MULTI_AGENT);
});

describe('GET /agents', () => {
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

  // Regression for the /api/agents 500: the route used to pass date-only
  // 'YYYY-MM-DD' bounds to queryTraces. queryTraces validates its string arm
  // as ISO datetime and threw ZodError on every request. A 200 here proves
  // the route sends ISO-datetime bounds (date-only would cause 500 from Zod).
  it('succeeds with valid date bounds — would 500 if date-only strings reached queryTraces', async () => {
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(200);
  });

  it('aggregates spans into agent records', async () => {
    fixture.setTraces([
      makeAgentSpanWire('trace-001', 'span-001', 'general-purpose'),
      makeAgentSpanWire('trace-002', 'span-002', 'general-purpose'),
    ]);

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.agentName).toBe('general-purpose');
    expect(body.agents[0]!.invocations).toBe(2);
  });

  it('computes errorRate correctly', async () => {
    fixture.setTraces([
      makeAgentSpanWire('trace-001', 'span-001', 'general-purpose', { 'integritystudio.agent.has_error': true }),
      makeAgentSpanWire('trace-002', 'span-002', 'general-purpose', { 'integritystudio.agent.has_error': false }),
    ]);

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents[0]!.errorRate).toBeCloseTo(0.5, 3);
  });

  it('agent record has required fields', async () => {
    fixture.setTraces([makeAgentSpanWire()]);

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
    fixture.setTraces([
      makeAgentSpanWire('trace-r', 'span-r', 'rare-agent'),
      makeAgentSpanWire('trace-b1', 'span-b1', 'busy-agent'),
      makeAgentSpanWire('trace-b2', 'span-b2', 'busy-agent'),
    ]);

    const res = await agentRoutes.request('/agents?period=7d');
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents[0]!.agentName).toBe('busy-agent');
    expect(body.agents[0]!.invocations).toBe(2);
    expect(body.agents[1]!.invocations).toBe(1);
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/traces');
    const res = await agentRoutes.request('/agents?period=7d');
    expect(res.status).toBe(500);
  });
});

describe('GET /agents/:sessionId', () => {
  it('returns 200 for a valid sessionId', async () => {
    fixture.setTraces([makeAgentSpanWire('trace-001', 'span-001', 'general-purpose', { 'session.id': 'sess-001' })]);
    fixture.setEvals([evalToWire(makeEvaluation({ traceId: 'trace-001', timestamp: EVAL_NANOS }))]);

    const res = await agentRoutes.request('/agents/sess-001');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDetailResponse;
    expect(body).toHaveProperty('sessionId', 'sess-001');
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/traces');
    const res = await agentRoutes.request('/agents/sess-001');
    expect(res.status).toBe(500);
  });
});
