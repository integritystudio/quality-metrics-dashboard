/**
 * /api/metrics/:name and /api/trends/:name in the Worker (production). They
 * serve the `metric:<name>:<period>` and `trend:<name>:<period>` keys
 * scripts/sync-to-kv.ts writes with the dev routes' projections. The metric
 * route once read a bare `metric:<name>` whatever period the page asked for,
 * and the trend route's empty answer carried `points`, which the page never
 * reads (DASHBOARD-AGGREGATE-DUAL-IMPL).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../index.js';

const BYPASS_ORG = 'a0000000-0000-4000-8000-000000000001';

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
};

const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })) };

function makeEnv() {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: 'test.us.auth0.com',
    AUTH0_AUDIENCE: 'https://test.api.dev',
    ALLOW_TEST_BYPASS: 'true',
    HOME_ORG_ID: '',
    STAFF_USER_IDS: '[]',
    ORG_SCOPING_ENABLED: 'true',
  };
}

const headers = { Authorization: 'Bearer test-token' };

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function stubKv(store: Record<string, unknown>) {
  mockKV.get.mockImplementation((key: string) => Promise.resolve(store[key] ?? null));
}

const DETAIL_PAYLOAD = { name: 'relevance', displayName: 'Relevance', status: 'healthy', sampleCount: 2, dynamics: { velocity: 0.1 } };
const TREND_PAYLOAD = { metric: 'relevance', period: '7d', bucketCount: 10, totalEvaluations: 2, overallPercentiles: null, trendData: [], narrowed: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/metrics/:name', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    stubKv({ [`org:${BYPASS_ORG}:metric:relevance:7d`]: DETAIL_PAYLOAD });

    const res = await app.request('/api/metrics/relevance?period=7d', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAIL_PAYLOAD);
    expect(mockKV.get).toHaveBeenCalledWith(`org:${BYPASS_ORG}:metric:relevance:7d`, 'json');
  });

  it('defaults to the month, as the page does', async () => {
    stubKv({});

    await app.request('/api/metrics/relevance', { headers }, makeEnv(), makeCtx());

    expect(mockKV.get).toHaveBeenCalledWith(`org:${BYPASS_ORG}:metric:relevance:30d`, 'json');
  });

  it('answers the no_data envelope when the key is absent', async () => {
    stubKv({});

    const res = await app.request('/api/metrics/relevance?period=24h', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'relevance', status: 'no_data', sampleCount: 0 });
  });

  it('rejects a period the sync never writes', async () => {
    const res = await app.request('/api/metrics/relevance?period=99d', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(400);
  });
});

describe('GET /api/trends/:name', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    stubKv({ [`org:${BYPASS_ORG}:trend:relevance:7d`]: TREND_PAYLOAD });

    const res = await app.request('/api/trends/relevance?period=7d', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TREND_PAYLOAD);
  });

  it('answers the empty series the page reads when the key is absent', async () => {
    stubKv({});

    const res = await app.request('/api/trends/relevance?period=24h', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      metric: 'relevance', period: '24h', bucketCount: 0, totalEvaluations: 0, overallPercentiles: null, trendData: [], narrowed: false,
    });
  });
});
