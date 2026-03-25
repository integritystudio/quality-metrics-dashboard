/**
 * Activity logging — logActivity fire-and-forget via worker routes
 *
 * Verifies that view routes POST to user_activity after returning data,
 * and that activity logging failures do not affect response status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index.js';

const MOCK_JWT = 'test-token';
const MOCK_AUTH_USER_ID = 'a0000000-0000-4000-8000-000000000001';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';

const AUDITOR_PERMISSIONS = ['dashboard.read', 'dashboard.auditor', 'dashboard.compliance.read', 'dashboard.traces.read', 'dashboard.sessions.read'];

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
};

const mockAssets = {
  fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })),
};

function makeEnv() {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
}

function authHeaders() {
  return { Authorization: `Bearer ${MOCK_JWT}` };
}

function mockAuthSequence(fetchMock: ReturnType<typeof vi.fn>, options?: { rejectActivity?: boolean }) {
  // Set up a reusable implementation that returns appropriate responses based on URL
  const callCount = new Map<string, number>();

  fetchMock.mockImplementation((url: string) => {
    const count = (callCount.get(url) ?? 0) + 1;
    callCount.set(url, count);

    // Auth user endpoint
    if (url.includes('/auth/v1/user')) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: MOCK_AUTH_USER_ID, email: 'user@test.com' }), { status: 200 })
      );
    }
    // Get app users (by auth ID)
    if (url.includes('/rest/v1/users') && url.includes('auth_id')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'user@test.com' }]), { status: 200 })
      );
    }
    // Get user roles
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'auditor', permissions: AUDITOR_PERMISSIONS } }]), { status: 200 })
      );
    }
    // Activity logging calls: optionally reject for failure testing
    if (url.includes('/rest/v1/user_activity') && options?.rejectActivity) {
      return Promise.reject(new Error('Supabase unreachable'));
    }
    // Activity logging and other calls: return success
    return Promise.resolve(new Response(null, { status: 201 }));
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function findActivityCall(calls: unknown[][]) {
  return calls.find(([url]) => typeof url === 'string' && url.includes('/rest/v1/user_activity'));
}

describe('logActivity: dashboard_view', () => {
  it('POSTs to user_activity after /api/dashboard returns data', async () => {
    mockAuthSequence(fetchMock);
    mockKV.get.mockResolvedValue({ metrics: [] });

    const res = await app.request(
      '/api/dashboard?period=7d',
      { headers: authHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);

    // Wait for microtasks to allow async activity logging to be queued
    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeDefined();
    const init = activityCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.user_id).toBe(MOCK_APP_USER_ID);
    expect(body.activity_type).toBe('dashboard_view');
  });

  it('does not POST to user_activity when KV returns no data (404)', async () => {
    mockAuthSequence(fetchMock);
    mockKV.get.mockResolvedValue(null);

    const res = await app.request('/api/dashboard', { headers: authHeaders() }, makeEnv());
    expect(res.status).toBe(404);

    // Wait for microtasks
    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeUndefined();
  });
});

describe('logActivity: trace_view', () => {
  it('POSTs activity_type=trace_view on /api/traces/:traceId', async () => {
    mockAuthSequence(fetchMock);
    mockKV.get.mockResolvedValue({ traceId: 'trace-1', spans: [] });

    const res = await app.request(
      '/api/traces/trace-1',
      { headers: authHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);

    // Wait for microtasks
    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeDefined();
    const init = activityCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.activity_type).toBe('trace_view');
  });
});

describe('logActivity: session_view', () => {
  it('POSTs activity_type=session_view on /api/sessions/:sessionId', async () => {
    mockAuthSequence(fetchMock);
    mockKV.get.mockResolvedValue({ sessionId: 'sess-1' });

    const res = await app.request(
      '/api/sessions/sess-1',
      { headers: authHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeDefined();
    const init = activityCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.activity_type).toBe('session_view');
  });
});

describe('logActivity: compliance_view', () => {
  it('POSTs activity_type=compliance_view on /api/compliance/sla', async () => {
    mockAuthSequence(fetchMock);
    mockKV.get.mockResolvedValue({ slaCompliance: [] });

    const res = await app.request(
      '/api/compliance/sla',
      { headers: authHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));

    const activityCall = findActivityCall(fetchMock.mock.calls as unknown[][]);
    expect(activityCall).toBeDefined();
    const init = activityCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.activity_type).toBe('compliance_view');
  });
});

describe('logActivity: failure resilience', () => {
  it('returns 200 even when activity POST throws', async () => {
    mockAuthSequence(fetchMock, { rejectActivity: true });
    mockKV.get.mockResolvedValue({ metrics: [] });

    const res = await app.request(
      '/api/dashboard',
      { headers: authHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });
});
