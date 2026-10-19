/**
 * Parity test: loadEvaluationsByMetric respects startDate (PARITY-EVAL-WINDOW-GAP).
 *
 * The main api-dashboard.test.ts fixture server runs without `dateWindow`, so
 * it ignores the startDate/endDate params the data-loader sends. Dropping
 * startDate from loadEvaluationsByMetric would pass all those tests. This file
 * uses `dateWindow: true` and places one evaluation outside the requested
 * window to prove the parameter is forwarded.
 *
 * Runs in its own module so `data-loader`'s backend singleton starts fresh
 * (no cached URL from the non-windowed fixture).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFixtureServer, evalToWire, type FixtureServer } from './support/fixture-server.js';
import { dashboardRoutes } from '../api/routes/dashboard.js';
import type { DashboardResponse } from './support/api-responses.js';
import { makeEvaluation, recentEvalNanos } from './support/fixtures.js';
import { TIME_MS } from '../lib/constants.js';
import { HttpStatus } from '../lib/http-constants.js';

const NANOS_PER_MS = 1_000_000n;
const STALE_EVAL_AGE_DAYS = 90;
const STALE_EVAL_AGE_MS = STALE_EVAL_AGE_DAYS * TIME_MS.DAY;

/** Epoch nanoseconds 90 days before now — safely outside any 7-day window. */
function staleEvalNanos(): bigint {
  return BigInt(Date.now() - STALE_EVAL_AGE_MS) * NANOS_PER_MS;
}

const EVIDENCE_EVALUATOR_TYPE = 'llm';
const RECENT_SCORE = 0.9;
const AVG_SCORE_DIGITS = 3;

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer({ dateWindow: true });
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

describe('GET /dashboard — startDate window parity', () => {
  it('excludes evaluations outside the requested period when dateWindow filtering is active', async () => {
    const recentEval = makeEvaluation({
      evaluationName: 'relevance',
      scoreValue: RECENT_SCORE,
      timestamp: recentEvalNanos(),
      evaluatorType: EVIDENCE_EVALUATOR_TYPE,
    });
    const staleEval = makeEvaluation({
      evaluationName: 'relevance',
      scoreValue: 0.1,
      timestamp: staleEvalNanos(),
      evaluatorType: EVIDENCE_EVALUATOR_TYPE,
    });

    fixture.setEvals([evalToWire(recentEval, 1), evalToWire(staleEval, 2)]);

    const res = await dashboardRoutes.request('/dashboard?period=7d');
    expect(res.status).toBe(HttpStatus.Ok);
    const body = await res.json() as DashboardResponse;

    const relevance = body.metrics.find((m) => m.name === 'relevance');
    // Only the recent eval falls inside the 7-day window; the stale one is
    // excluded by the fixture server's dateWindow filter. sampleCount = 1
    // proves startDate reached the server. Without it both evals would be
    // returned and avg would mix 0.9 and 0.1.
    expect(relevance?.sampleCount).toBe(1);
    expect(relevance?.values.avg).toBeCloseTo(RECENT_SCORE, AVG_SCORE_DIGITS);
  });
});
