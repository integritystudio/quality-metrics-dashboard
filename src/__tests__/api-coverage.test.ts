/**
 * API route tests: /api/coverage.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run,
 * and the parent's computeCoverageMatrix builds the grid from what they load.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { coverageRoutes } from '../api/routes/coverage.js';
import type { CoverageResponse, ErrorResponse } from './support/api-responses.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

const JUDGE_EVALUATOR_TYPE = 'llm';
/** Rule-based per-span evaluations, which the route drops from the coverage universe. */
const RULE_EVALUATOR_TYPE = 'rule';

/** relevance judged on two traces, coherence on one, plus a rule eval the route must drop. */
function serveCoverageEvals(): void {
  fixture.setEvals([
    { evaluationName: 'relevance', traceId: 'trace-1', sessionId: 'sess-1', evaluatorType: JUDGE_EVALUATOR_TYPE },
    { evaluationName: 'relevance', traceId: 'trace-2', sessionId: 'sess-1', evaluatorType: JUDGE_EVALUATOR_TYPE },
    { evaluationName: 'coherence', traceId: 'trace-1', sessionId: 'sess-1', evaluatorType: JUDGE_EVALUATOR_TYPE },
    { evaluationName: 'tool_correctness', traceId: 'trace-3', sessionId: 'sess-2', evaluatorType: RULE_EVALUATOR_TYPE },
  ].map((e, i) => evalToWire(e, i + 1)));
}

beforeEach(() => {
  fixture.reset();
  serveCoverageEvals();
});

describe('GET /coverage', () => {

  it('rejects invalid period with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=99d');
    expect(res.status).toBe(400);
  });

  it('rejects invalid inputKey with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=invalid');
    expect(res.status).toBe(400);
    const body = await res.json() as ErrorResponse;
    expect(body.error).toContain('inputKey');
  });

  it('returns the columnar matrix the Worker also serves', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d');

    expect(res.status).toBe(200);
    const body = await res.json() as CoverageResponse;
    expect(body.period).toBe('7d');
    expect([...body.metrics].sort()).toEqual(['coherence', 'relevance']);
    expect([...body.inputs].sort()).toEqual(['trace-1', 'trace-2']);
    expect(body.counts).toHaveLength(body.metrics.length);
    for (const row of body.counts) expect(row).toHaveLength(body.inputs.length);
    // 3 of the 4 metric x input cells are evaluated.
    expect(body.overallCoveragePercent).toBe(75);
  });

  it('drops rule-based evaluations from the coverage universe', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d');
    const body = await res.json() as CoverageResponse;
    expect(body.metrics).not.toContain('tool_correctness');
    expect(body.inputs).not.toContain('trace-3');
  });

  it('keys inputs by session with inputKey=sessionId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=sessionId');
    const body = await res.json() as CoverageResponse;
    expect(body.inputs).toEqual(['sess-1']);
  });

  it('does not ship the dense cell list that breached the KV value limit', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d');

    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('cells');
    expect(body).not.toHaveProperty('gaps');
  });

  it('accepts inputKey=traceId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=traceId');
    expect(res.status).toBe(200);
  });

  it('accepts inputKey=sessionId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=sessionId');
    expect(res.status).toBe(200);
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await coverageRoutes.request('/coverage?period=7d');
    expect(res.status).toBe(500);
  });
});
