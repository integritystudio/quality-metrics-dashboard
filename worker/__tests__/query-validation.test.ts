/**
 * Query-string validation on the data routes: each bad field answers 400 with its own error
 * string (the frontend shows it), defaults pick the KV key, a repeated key reads its first
 * value, and an empty ?role= means no role.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../index.js';

const BAD_REQUEST = 400;
const OK = 200;

const mockKV = {
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn(),
};
const mockAssets = { fetch: vi.fn() };

// ALLOW_TEST_BYPASS requires the production markers to be absent.
const env = {
  DASHBOARD: mockKV,
  ASSETS: mockAssets,
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  AUTH0_DOMAIN: 'test.us.auth0.com',
  AUTH0_AUDIENCE: 'https://test.api.dev',
  ALLOW_TEST_BYPASS: 'true',
  HOME_ORG_ID: '',
  STAFF_USER_IDS: '[]',
};

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function get(path: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { Authorization: 'Bearer test-token' } }, env, makeCtx()));
}

function kvKeysRead(): unknown[] {
  return mockKV.get.mock.calls.map(([key]: unknown[]) => key);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKV.get.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 201 })));
});

describe('400 with the failing field\'s error', () => {
  it.each([
    ['/api/trends/m?period=1y', 'Invalid period. Must be 24h, 7d, or 30d.'],
    ['/api/dashboard?period=', 'Invalid period. Must be 24h, 7d, or 30d.'],
    ['/api/dashboard?role=ceo', 'Invalid role. Must be executive, operator, or auditor.'],
    ['/api/metrics/m/evaluations?limit=0', 'Invalid pagination params. limit must be 1–200, offset must be >= 0.'],
    ['/api/metrics/m/evaluations?offset=-1', 'Invalid pagination params. limit must be 1–200, offset must be >= 0.'],
    ['/api/metrics/m/evaluations?sortBy=random', 'Invalid sortBy. Must be timestamp_desc, score_asc, or score_desc.'],
    ['/api/coverage?inputKey=spanId', 'Invalid inputKey. Must be traceId or sessionId.'],
  ])('%s', async (path, error) => {
    const res = await get(path);
    expect(res.status).toBe(BAD_REQUEST);
    expect(await res.json()).toEqual({ error });
  });

  it('reports period before the fields after it', async () => {
    const res = await get('/api/metrics/m/evaluations?period=1y&sortBy=random');
    expect(await res.json()).toEqual({ error: 'Invalid period. Must be 24h, 7d, or 30d.' });
  });
});

describe('accepted queries', () => {
  it('defaults period to 7d, and to 30d on /api/correlations', async () => {
    await get('/api/pipeline');
    await get('/api/correlations');
    expect(kvKeysRead()).toEqual(['pipeline:7d', 'correlations:30d']);
  });

  it('reads the first value of a repeated key', async () => {
    await get('/api/trends/m?period=24h&period=bogus');
    expect(kvKeysRead()).toEqual(['trend:m:24h']);
  });

  it('treats an empty role as no role', async () => {
    const res = await get('/api/dashboard?role=');
    expect(res.status).not.toBe(BAD_REQUEST);
    expect(kvKeysRead()).toEqual(['dashboard:7d']);
  });

  it('pages, sorts and filters metric evaluations', async () => {
    mockKV.get.mockResolvedValue({
      rows: [{ score: 3, label: 'pass' }, { score: 1, label: 'pass' }, { score: 2, label: 'fail' }],
    });
    const res = await get('/api/metrics/m/evaluations?period=30d&sortBy=score_asc&scoreLabel=pass&limit=1&offset=1');
    expect(res.status).toBe(OK);
    expect(await res.json()).toEqual({ rows: [{ score: 3, label: 'pass' }], total: 2, limit: 1, offset: 1, hasMore: false });
    expect(kvKeysRead()).toEqual(['metric:evaluations:m:30d']);
  });
});
