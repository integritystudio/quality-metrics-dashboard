/**
 * Activity logging — logActivity fire-and-forget via worker routes
 *
 * Verifies that view routes POST to user_activity after returning data,
 * and that activity logging failures do not affect response status.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import app from '../index.js';
import { HttpStatus } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE, createTestIssuer, type FetchLike, type TestIssuer } from './support/jwt.js';
import { defined } from '../../src/__tests__/support/defined.js';

type FetchMock = Mock<FetchLike>;

const DASHBOARD_KEY = 'dashboard:7d';

const MOCK_AUTH0_ID = 'auth0|test-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';

const AUDITOR_PERMISSIONS = ['dashboard.read', 'dashboard.auditor', 'dashboard.compliance.read', 'dashboard.traces.read', 'dashboard.sessions.read'];

const mockAssets = {
  fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: HttpStatus.Ok })),
};

function makeEnv(kv = new MemoryKv()) {
  return {
    DASHBOARD: kv,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

let tenant: TestIssuer;
let token: string;

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function mockAuthSequence(fetchMock: FetchMock, options?: { rejectActivity?: boolean }) {
  const callCount = new Map<string, number>();

  fetchMock.mockImplementation((url: string) => {
    const count = (callCount.get(url) ?? 0) + 1;
    callCount.set(url, count);

    // Get app user by auth0_id — has auth0_id= and limit=1
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'user@test.com' }]), { status: HttpStatus.Ok })
      );
    }
    // Get user roles
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'auditor', permissions: AUDITOR_PERMISSIONS } }]), { status: HttpStatus.Ok })
      );
    }
    // Activity logging calls: optionally reject for failure testing
    if (url.includes('/rest/v1/user_activity') && options?.rejectActivity) {
      return Promise.reject(new Error('Supabase unreachable'));
    }
    // Activity logging and other calls: return success
    return Promise.resolve(new Response(null, { status: HttpStatus.Created }));
  });
}

let fetchMock: FetchMock;

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  token = await tenant.sign({ sub: MOCK_AUTH0_ID });
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', tenant.serveJwks(fetchMock));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function findActivityCall(calls: unknown[][]) {
  return calls.find(([url]) => typeof url === 'string' && url.includes('/rest/v1/user_activity'));
}

const VIEW_ROUTES = [
  { activityType: 'dashboard_view', path: '/api/dashboard?period=7d', kvKey: DASHBOARD_KEY, kvValue: { metrics: [] } },
  { activityType: 'trace_view', path: '/api/traces/trace-1', kvKey: 'trace:trace-1', kvValue: { traceId: 'trace-1', spans: [] } },
  { activityType: 'session_view', path: '/api/sessions/sess-1', kvKey: 'session:sess-1', kvValue: { sessionId: 'sess-1' } },
  { activityType: 'compliance_view', path: '/api/compliance/sla', kvKey: DASHBOARD_KEY, kvValue: { slaCompliance: [] } },
];

describe('logActivity: view routes', () => {
  it.each(VIEW_ROUTES)('POSTs activity_type=$activityType on $path', async ({ activityType, path, kvKey, kvValue }) => {
    mockAuthSequence(fetchMock);

    const res = await app.request(path, { headers: authHeaders() }, makeEnv(new MemoryKv({ [kvKey]: kvValue })), makeCtx());
    expect(res.status).toBe(HttpStatus.Ok);

    // Wait for microtasks to allow async activity logging to be queued
    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeDefined();
    const init = defined(activityCall)[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.user_id).toBe(MOCK_APP_USER_ID);
    expect(body.activity_type).toBe(activityType);
  });

  it('does not POST to user_activity when KV returns no data (404)', async () => {
    mockAuthSequence(fetchMock);

    const res = await app.request('/api/dashboard', { headers: authHeaders() }, makeEnv(), makeCtx());
    expect(res.status).toBe(HttpStatus.NotFound);

    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeUndefined();
  });
});

describe('logActivity: failure resilience', () => {
  it('returns 200 even when activity POST throws', async () => {
    mockAuthSequence(fetchMock, { rejectActivity: true });

    const res = await app.request(
      '/api/dashboard',
      { headers: authHeaders() },
      makeEnv(new MemoryKv({ [DASHBOARD_KEY]: { metrics: [] } })),
      makeCtx(),
    );
    expect(res.status).toBe(HttpStatus.Ok);
  });
});

describe('POST /api/activity: request body', () => {
  it.each([
    ['malformed JSON', '{"activity_type":'],
    ['a body the schema rejects', JSON.stringify({ activity_type: 'not-an-activity' })],
  ])('answers 400 with the JSON error for %s, and logs nothing', async (_label, body) => {
    mockAuthSequence(fetchMock);

    const res = await app.request(
      '/api/activity',
      { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body },
      makeEnv(),
      makeCtx(),
    );

    expect(res.status).toBe(HttpStatus.BadRequest);
    expect(await res.json()).toEqual({ error: 'Invalid request body' });
    expect(findActivityCall(fetchMock.mock.calls as unknown[][])).toBeUndefined();
  });
});
