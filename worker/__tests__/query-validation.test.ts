/**
 * Query-string validation on the data routes: each bad field answers 400 with its own error
 * string (the frontend shows it), defaults pick the KV key, a repeated key reads its first
 * value, and an empty ?role= means no role. Also: a handler that throws still answers in the
 * JSON error shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE } from './support/jwt.js';

const mockAssets = { fetch: vi.fn() };

function pipelinePayload(period: string) {
  return { period, stages: [{ name: `stage-${period}` }], totalEvaluations: 1 };
}

function correlationsPayload(period: string) {
  return { correlations: [{ period }], metrics: [] };
}

const TREND_24H = { metric: 'm', period: '24h', bucketCount: 1, totalEvaluations: 1, overallPercentiles: null, trendData: [], narrowed: false };
const DASHBOARD_7D = { overallStatus: 'healthy', metrics: [] };
const EVALUATIONS_30D = { rows: [{ score: 3, label: 'pass' }, { score: 1, label: 'pass' }, { score: 2, label: 'fail' }] };
const EVALUATIONS_7D = { rows: [{ score: 9, label: 'pass' }] };

/** Every period's key holds its own payload, so a response shows which key was read. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    'pipeline:24h': pipelinePayload('24h'),
    'pipeline:7d': pipelinePayload('7d'),
    'pipeline:30d': pipelinePayload('30d'),
    'correlations:7d': correlationsPayload('7d'),
    'correlations:30d': correlationsPayload('30d'),
    'trend:m:24h': TREND_24H,
    'dashboard:7d': DASHBOARD_7D,
    'metric:evaluations:m:30d': EVALUATIONS_30D,
    'metric:evaluations:m:7d': EVALUATIONS_7D,
  });
}

/** A KV binding whose every read fails with `err`. */
function failingKv(err: Error) {
  return { get: () => Promise.reject(err) };
}

// ALLOW_TEST_BYPASS requires the production markers to be absent.
function makeEnv(kv: unknown = syncedKv()) {
  return {
    DASHBOARD: kv,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
    ALLOW_TEST_BYPASS: 'true',
    HOME_ORG_ID: '',
    STAFF_USER_IDS: '[]',
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function get(path: string, env = makeEnv()): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { Authorization: 'Bearer test-token' } }, env, makeCtx()));
}

async function bodyOf(path: string): Promise<unknown> {
  return (await get(path)).json();
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: HttpStatus.Created })));
});

describe('400 with the failing field\'s error', () => {
  it.each([
    ['/api/trends/m?period=1y', 'Invalid period. Must be 24h, 7d, 30d, or 90d.'],
    ['/api/dashboard?period=', 'Invalid period. Must be 24h, 7d, 30d, or 90d.'],
    ['/api/dashboard?role=ceo', 'Invalid role. Must be executive, operator, or auditor.'],
    ['/api/metrics/m/evaluations?limit=0', 'Invalid pagination params. limit must be 1–200, offset must be >= 0.'],
    ['/api/metrics/m/evaluations?offset=-1', 'Invalid pagination params. limit must be 1–200, offset must be >= 0.'],
    ['/api/metrics/m/evaluations?sortBy=random', 'Invalid sortBy. Must be timestamp_desc, score_asc, or score_desc.'],
    ['/api/coverage?inputKey=spanId', 'Invalid inputKey. Must be traceId or sessionId.'],
  ])('%s', async (path, error) => {
    const res = await get(path);
    expect(res.status).toBe(HttpStatus.BadRequest);
    expect(await res.json()).toEqual({ error });
  });

  it('reports period before the fields after it', async () => {
    const res = await get('/api/metrics/m/evaluations?period=1y&sortBy=random');
    expect(await res.json()).toEqual({ error: 'Invalid period. Must be 24h, 7d, 30d, or 90d.' });
  });
});

describe('accepted queries', () => {
  it('defaults period to 7d, and to 30d on /api/correlations', async () => {
    expect(await bodyOf('/api/pipeline')).toEqual(pipelinePayload('7d'));
    expect(await bodyOf('/api/correlations')).toEqual(correlationsPayload('30d'));
  });

  it('reads the first value of a repeated key', async () => {
    expect(await bodyOf('/api/trends/m?period=24h&period=bogus')).toEqual(TREND_24H);
  });

  it('treats an empty role as no role', async () => {
    const res = await get('/api/dashboard?role=');
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(DASHBOARD_7D);
  });

  it('pages, sorts and filters metric evaluations', async () => {
    const res = await get('/api/metrics/m/evaluations?period=30d&sortBy=score_asc&scoreLabel=pass&limit=1&offset=1');
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ rows: [{ score: 3, label: 'pass' }], total: 2, limit: 1, offset: 1, hasMore: false });
  });
});

describe('unhandled errors', () => {
  it('answer a JSON 500, not Hono\'s plain-text default', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get('/api/pipeline', makeEnv(failingKv(new Error('KV unavailable'))));
    consoleError.mockRestore();
    expect(res.status).toBe(HttpStatus.InternalServerError);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('pass an HTTPException\'s own response through', async () => {
    const res = await get('/api/pipeline', makeEnv(failingKv(new HTTPException(HttpStatus.PayloadTooLarge))));
    expect(res.status).toBe(HttpStatus.PayloadTooLarge);
  });
});
