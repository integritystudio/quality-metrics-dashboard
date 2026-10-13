/**
 * /api/agents in the Worker (production). It serves the `meta:agents:<period>`
 * key scripts/sync-to-kv.ts writes with the dev route's projection. It once
 * served a bare summary list from `meta:agents`, which the page's shape check
 * rejected on every load (DASHBOARD-AGGREGATE-DUAL-IMPL).
 */

import { describe, it, expect, vi } from 'vitest';
import app from '../index.js';
import { HttpStatus } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE } from './support/jwt.js';

const BYPASS_ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-0000000000ff';

const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: HttpStatus.Ok })) };

function makeEnv(kv: MemoryKv) {
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
    ORG_SCOPING_ENABLED: 'true',
  };
}

const headers = { Authorization: 'Bearer test-token' };

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function agentsPayload(period: string, invocations: number) {
  return {
    period,
    startDate: '2026-10-01',
    endDate: '2026-10-08',
    agents: [{ agentName: 'general-purpose', invocations, errors: 0, errorRate: 0 }],
  };
}

const WEEK_PAYLOAD = agentsPayload('7d', 2);
const MONTH_PAYLOAD = agentsPayload('30d', 9);
const OTHER_ORG_WEEK_PAYLOAD = agentsPayload('7d', 5);
const BARE_WEEK_PAYLOAD = agentsPayload('7d', 7);

/** The session's org, another org, and the pre-tenancy bare key each hold a different week. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    [`org:${BYPASS_ORG}:meta:agents:7d`]: WEEK_PAYLOAD,
    [`org:${BYPASS_ORG}:meta:agents:30d`]: MONTH_PAYLOAD,
    [`org:${OTHER_ORG}:meta:agents:7d`]: OTHER_ORG_WEEK_PAYLOAD,
    'meta:agents:7d': BARE_WEEK_PAYLOAD,
  });
}

describe('GET /api/agents', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    const res = await app.request('/api/agents?period=7d', { headers }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(WEEK_PAYLOAD);
  });

  it('defaults to the month, as the dev route does', async () => {
    const res = await app.request('/api/agents', { headers }, makeEnv(syncedKv()), makeCtx());

    expect(await res.json()).toEqual(MONTH_PAYLOAD);
  });

  it('answers the envelope the page requires when the key is absent', async () => {
    const res = await app.request('/api/agents?period=24h', { headers }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ period: '24h', startDate: null, endDate: null, agents: [] });
  });

  it('rejects a period the sync never writes', async () => {
    const res = await app.request('/api/agents?period=99d', { headers }, makeEnv(new MemoryKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});
