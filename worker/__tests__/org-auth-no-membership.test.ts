/**
 * AUTH-NO-ORG-LEGACY-SESSION — under ORG_SCOPING_ENABLED, a signed-in user with
 * no org membership is refused, whatever their user_roles.
 *
 * The on_user_created trigger gives every new public.users row the
 * provisioned-dashboard-viewer role, so a roles-based fallback reached every
 * user who had not yet provisioned an org and served them the home org's
 * bare (pre-tenancy) KV keys. These tests drive the real JWT middleware path
 * (a real signed token, Supabase REST stubbed), not ALLOW_TEST_BYPASS, which always
 * carries an org.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import app from '../index.js';
import { jsonResponse } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE, createTestIssuer, type TestIssuer } from './support/jwt.js';
import { HttpStatus } from '../../src/lib/http-constants.js';

const MOCK_AUTH0_ID = 'auth0|no-org-user';
const APP_USER_ID = 'a0000000-0000-4000-8000-000000000031';
const HOME_ORG_ID = 'a0000000-0000-4000-8000-0000000000aa';
const MEMBER_ORG_ID = 'a0000000-0000-4000-8000-0000000000bb';
const ERR_NO_ORG = 'No organization membership';
const VIEWER_ROLE = {
  name: 'provisioned-dashboard-viewer',
  permissions: [
    'dashboard.read',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
  ],
};
const DASHBOARD_PATH = '/api/dashboard?period=7d';
const BARE_DASHBOARD_KEY = 'dashboard:7d';

// Every /api/* data route the worker serves; the middleware refusal must reach all of them.
const DATA_ROUTES = [
  DASHBOARD_PATH,
  '/api/metrics/relevance/evaluations?period=7d',
  '/api/metrics/relevance',
  '/api/trends/relevance?period=7d',
  '/api/evaluations/trace/trace-1',
  '/api/traces/trace-1',
  '/api/correlations?period=7d',
  '/api/degradation-signals?period=7d',
  '/api/coverage?period=7d',
  '/api/pipeline?period=7d',
  '/api/sessions/session-1',
  '/api/agents',
  '/api/code-quality',
  '/api/agents/detail/code-reviewer',
  '/api/agents/session-1',
  '/api/compliance/sla?period=7d',
  '/api/compliance/verifications',
  '/api/calibration',
  '/api/routing-telemetry',
];

// The rest of /api/* (all but /api/health): refused by the same middleware branch.
const NON_DATA_ROUTES: Array<[method: string, path: string]> = [
  ['GET', '/api/me'],
  ['POST', '/api/org/switch'],
  ['POST', '/api/logout'],
  ['POST', '/api/activity'],
  ['GET', '/api/admin/members'],
  ['POST', `/api/admin/members/${APP_USER_ID}/role`],
  ['DELETE', `/api/admin/members/${APP_USER_ID}`],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/roles'],
  ['POST', `/api/admin/users/${APP_USER_ID}/roles`],
  ['DELETE', `/api/admin/users/${APP_USER_ID}/roles/role-1`],
];

const BARE_PAYLOAD = { overallStatus: 'pre-tenancy', metrics: [] };
const HOME_PAYLOAD = { overallStatus: 'home-org', metrics: [] };
const MEMBER_PAYLOAD = { overallStatus: 'member-org', metrics: [] };

/** The home org's pre-tenancy and scoped dashboards, and the member org's, each distinct. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    [BARE_DASHBOARD_KEY]: BARE_PAYLOAD,
    [`org:${HOME_ORG_ID}:${BARE_DASHBOARD_KEY}`]: HOME_PAYLOAD,
    [`org:${MEMBER_ORG_ID}:${BARE_DASHBOARD_KEY}`]: MEMBER_PAYLOAD,
  });
}
const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: HttpStatus.Ok })) };

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: syncedKv(),
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
    ORG_SCOPING_ENABLED: 'true',
    HOME_ORG_ID,
    STAFF_USER_IDS: '[]',
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function json(body: unknown): Promise<Response> {
  return Promise.resolve(jsonResponse(body));
}

let tenant: TestIssuer;
let token: string;

function stubSupabase(memberships: unknown[]) {
  vi.stubGlobal('fetch', tenant.serveJwks((url: string) => {
    if (url.includes('/rest/v1/users?')) return json([{ id: APP_USER_ID, email: 'viewer@test.com', default_organization_id: null }]);
    if (url.includes('/rest/v1/user_roles?')) return json([{ roles: VIEWER_ROLE }]);
    if (url.includes('/rest/v1/organization_memberships?')) return json(memberships);
    return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
  }));
}

function request(path: string, env = makeEnv(), method = 'GET'): Promise<Response> {
  return Promise.resolve(app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, env, makeCtx()));
}

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  token = await tenant.sign({ sub: MOCK_AUTH0_ID });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('org scoping: a viewer-role user with no membership', () => {
  beforeEach(() => stubSupabase([]));

  it.each(DATA_ROUTES)('gets 403 ERR_NO_ORG from %s, not the home org\'s data', async (path) => {
    const res = await request(path);

    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(await res.json()).toEqual({ error: ERR_NO_ORG });
  });

  it.each(NON_DATA_ROUTES)('gets 403 ERR_NO_ORG from %s %s', async (method, path) => {
    const res = await request(path, makeEnv(), method);

    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(await res.json()).toEqual({ error: ERR_NO_ORG });
  });
});

describe('org scoping: sessions that keep access', () => {
  it('a member reads the org-prefixed key for their org', async () => {
    stubSupabase([{
      role: 'member',
      organization_id: MEMBER_ORG_ID,
      organizations: { id: MEMBER_ORG_ID, slug: 'member-org', name: 'Member Org' },
    }]);

    const res = await request(DASHBOARD_PATH);

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(MEMBER_PAYLOAD);
  });

  it('staff with no membership resolve to the home org', async () => {
    stubSupabase([]);

    const res = await request('/api/me', makeEnv({ STAFF_USER_IDS: JSON.stringify([APP_USER_ID]) }));

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ activeOrg: HOME_ORG_ID, isStaff: true, role: 'owner' });
  });
});

describe('org scoping off', () => {
  it('a viewer-role user keeps the global path and reads the bare key', async () => {
    stubSupabase([]);

    const res = await request(DASHBOARD_PATH, makeEnv({ ORG_SCOPING_ENABLED: 'false' }));

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(BARE_PAYLOAD);
  });
});
