/**
 * /api/metrics/:name and /api/trends/:name in the Worker (production). They
 * serve the `metric:<name>:<period>` and `trend:<name>:<period>` keys
 * scripts/sync-to-kv.ts writes with the dev routes' projections. The metric
 * route once read a bare `metric:<name>` whatever period the page asked for,
 * and the trend route's empty answer carried `points`, which the page never
 * reads (DASHBOARD-AGGREGATE-DUAL-IMPL).
 */

import { describe, it, expect } from 'vitest';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { BYPASS_BINDINGS, BYPASS_HEADERS, BYPASS_ORG_ID, makeCtx, makeWorkerEnv } from './support/worker-env.js';

function makeEnv(kv = new MemoryKv()) {
  return makeWorkerEnv({ DASHBOARD: kv, ...BYPASS_BINDINGS, ORG_SCOPING_ENABLED: 'true' });
}

const DETAIL_PAYLOAD = { name: 'relevance', displayName: 'Relevance', status: 'healthy', sampleCount: 2, dynamics: { velocity: 0.1 } };
const MONTH_DETAIL_PAYLOAD = { ...DETAIL_PAYLOAD, sampleCount: 30 };
const BARE_DETAIL_PAYLOAD = { ...DETAIL_PAYLOAD, sampleCount: 99 };
const TREND_PAYLOAD = { metric: 'relevance', period: '7d', bucketCount: 10, totalEvaluations: 2, overallPercentiles: null, trendData: [], narrowed: false };
const BARE_TREND_PAYLOAD = { ...TREND_PAYLOAD, totalEvaluations: 99 };

/** The session's org holds a week and a month; the pre-tenancy bare keys hold other values. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    [`org:${BYPASS_ORG_ID}:metric:relevance:7d`]: DETAIL_PAYLOAD,
    [`org:${BYPASS_ORG_ID}:metric:relevance:30d`]: MONTH_DETAIL_PAYLOAD,
    'metric:relevance:7d': BARE_DETAIL_PAYLOAD,
    [`org:${BYPASS_ORG_ID}:trend:relevance:7d`]: TREND_PAYLOAD,
    'trend:relevance:7d': BARE_TREND_PAYLOAD,
  });
}

describe('GET /api/metrics/:name', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    const res = await app.request('/api/metrics/relevance?period=7d', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(DETAIL_PAYLOAD);
  });

  it('defaults to the month, as the page does', async () => {
    const res = await app.request('/api/metrics/relevance', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(await res.json()).toEqual(MONTH_DETAIL_PAYLOAD);
  });

  it('answers the no_data envelope when the key is absent', async () => {
    const res = await app.request('/api/metrics/relevance?period=24h', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ name: 'relevance', status: 'no_data', sampleCount: 0 });
  });

  it('rejects a period the sync never writes', async () => {
    const res = await app.request('/api/metrics/relevance?period=99d', { headers: BYPASS_HEADERS }, makeEnv(), makeCtx());

    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});

describe('GET /api/trends/:name', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    const res = await app.request('/api/trends/relevance?period=7d', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(TREND_PAYLOAD);
  });

  it('answers the empty series the page reads when the key is absent', async () => {
    const res = await app.request('/api/trends/relevance?period=24h', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({
      metric: 'relevance', period: '24h', bucketCount: 0, totalEvaluations: 0, overallPercentiles: null, trendData: [], narrowed: false,
    });
  });
});
