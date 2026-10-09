/**
 * /api/agents in the Worker (production). It serves the `meta:agents:<period>`
 * key scripts/sync-to-kv.ts writes with the dev route's projection. It once
 * served a bare summary list from `meta:agents`, which the page's shape check
 * rejected on every load (DASHBOARD-AGGREGATE-DUAL-IMPL).
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

const WEEK_PAYLOAD = {
  period: '7d',
  startDate: '2026-10-01',
  endDate: '2026-10-08',
  agents: [{ agentName: 'general-purpose', invocations: 2, errors: 0, errorRate: 0 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/agents', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    stubKv({ [`org:${BYPASS_ORG}:meta:agents:7d`]: WEEK_PAYLOAD });

    const res = await app.request('/api/agents?period=7d', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(WEEK_PAYLOAD);
    expect(mockKV.get).toHaveBeenCalledWith(`org:${BYPASS_ORG}:meta:agents:7d`, 'json');
  });

  it('defaults to the month, as the dev route does', async () => {
    stubKv({});

    await app.request('/api/agents', { headers }, makeEnv(), makeCtx());

    expect(mockKV.get).toHaveBeenCalledWith(`org:${BYPASS_ORG}:meta:agents:30d`, 'json');
  });

  it('answers the envelope the page requires when the key is absent', async () => {
    stubKv({});

    const res = await app.request('/api/agents?period=24h', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ period: '24h', startDate: null, endDate: null, agents: [] });
  });

  it('rejects a period the sync never writes', async () => {
    const res = await app.request('/api/agents?period=99d', { headers }, makeEnv(), makeCtx());

    expect(res.status).toBe(400);
  });
});
