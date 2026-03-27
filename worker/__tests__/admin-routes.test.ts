/**
 * Admin API route tests — GET/POST/DELETE /api/admin/*
 *
 * Tests permission enforcement and basic request validation for admin routes.
 * Admin tests use withAdminAuth() to compose fetch mocks: auth middleware calls
 * are handled by the helper layer; route-specific calls are handled by the test.
 * Non-admin tests use mockAuditorAuthSequence (auditor permissions, no dashboard.admin).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index.js';

const MOCK_AUTH0_ID = 'auth0|test-admin-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';

// Auditor has no dashboard.admin permission
const AUDITOR_PERMISSIONS = ['dashboard.read', 'dashboard.auditor', 'dashboard.compliance.read', 'dashboard.traces.read', 'dashboard.sessions.read'];
const ADMIN_PERMISSIONS = ['dashboard.read', 'dashboard.executive', 'dashboard.operator', 'dashboard.auditor', 'dashboard.traces.read', 'dashboard.sessions.read', 'dashboard.agents.read', 'dashboard.pipeline.read', 'dashboard.compliance.read', 'dashboard.admin'];

const VALID_USER_UUID = 'b1111111-1111-4111-8111-111111111111';
const VALID_ROLE_UUID = 'c2222222-2222-4222-8222-222222222222';

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

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: 'test.us.auth0.com',
    AUTH0_AUDIENCE: 'https://test.api.dev',
    ...overrides,
  };
}

function adminHeaders() {
  return { Authorization: 'Bearer mock-admin-jwt' };
}

/**
 * Wraps a route-level fetch handler with auth middleware responses.
 * The auth middleware makes 2 sequential Supabase calls (jose.jwtVerify is mocked separately):
 *   1. GET /rest/v1/users?auth0_id=eq.{auth0Id}&limit=1 — resolve appUserId
 *   2. GET /rest/v1/user_roles?select=roles(name,permissions)&... — load permissions
 * This helper intercepts those two by URL pattern and delegates everything else
 * to the provided routeHandler.
 */
function withAdminAuth(
  routeHandler: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url: string, init?: RequestInit) => {
    // Auth user lookup: has auth0_id= and limit=1
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
      return Promise.resolve(new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'admin@test.com' }]), { status: 200 }));
    }
    // Auth roles: has roles(name,permissions)
    if (url.includes('/rest/v1/user_roles') && url.includes('roles(name,permissions)')) {
      return Promise.resolve(new Response(JSON.stringify([{ roles: { name: 'admin', permissions: ADMIN_PERMISSIONS } }]), { status: 200 }));
    }
    return routeHandler(url, init);
  };
}

/** Mock a non-admin auth sequence (auditor permissions, no dashboard.admin). */
function mockAuditorAuthSequence(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'auditor@test.com' }]), { status: 200 }),
      );
    }
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'auditor', permissions: AUDITOR_PERMISSIONS } }]), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn((p: Promise<unknown>) => { void p; }), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockResolvedValue({ payload: { sub: MOCK_AUTH0_ID } } as never);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Default: admin auth succeeds; route handler returns 200 for unmatched calls.
  fetchMock.mockImplementation(withAdminAuth(() => Promise.resolve(new Response(null, { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── GET /api/admin/users ──────────────────────────────────────────────────────

describe('GET /api/admin/users', () => {
  it('returns 403 for non-admin user (auditor)', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      '/api/admin/users',
      { headers: { Authorization: 'Bearer real-auditor-token' } },
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 with user list for admin user', async () => {
    const mockUsers = [
      { id: VALID_USER_UUID, email: 'user@test.com', created_at: '2024-01-01T00:00:00.000Z' },
    ];
    const mockRoleRows = [
      { user_id: VALID_USER_UUID, role_id: VALID_ROLE_UUID, roles: { id: VALID_ROLE_UUID, name: 'auditor' } },
    ];

    fetchMock.mockImplementation(withAdminAuth((url) => {
      // Admin route fetches all users (order=created_at.desc) and role assignments (user_id,role_id)
      if (url.includes('/rest/v1/users')) {
        return Promise.resolve(new Response(JSON.stringify(mockUsers), { status: 200 }));
      }
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(JSON.stringify(mockRoleRows), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      '/api/admin/users',
      { headers: adminHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

// ─── GET /api/admin/roles ──────────────────────────────────────────────────────

describe('GET /api/admin/roles', () => {
  it('returns 403 for non-admin user (auditor)', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      '/api/admin/roles',
      { headers: { Authorization: 'Bearer real-auditor-token' } },
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 with roles list for admin user', async () => {
    const mockRoles = [
      { id: VALID_ROLE_UUID, name: 'auditor', permissions: AUDITOR_PERMISSIONS },
    ];

    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/roles')) {
        return Promise.resolve(new Response(JSON.stringify(mockRoles), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      '/api/admin/roles',
      { headers: adminHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
  });
});

// ─── POST /api/admin/users/:userId/roles ──────────────────────────────────────

describe('POST /api/admin/users/:userId/roles', () => {
  it('returns 400 for invalid (non-UUID) userId', async () => {
    const res = await app.request(
      '/api/admin/users/not-a-uuid/roles',
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid request body (missing role_id)', async () => {
    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 204 on successful role assignment', async () => {
    fetchMock.mockImplementation(withAdminAuth((url, init) => {
      // Route handler POSTs to user_roles with no query params
      if (url.includes('/rest/v1/user_roles') && init?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(204);
  });

  it('returns 403 for non-admin user', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer real-auditor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/admin/users/:userId/roles/:roleId ────────────────────────────

describe('DELETE /api/admin/users/:userId/roles/:roleId', () => {
  it('returns 400 for invalid userId', async () => {
    const res = await app.request(
      `/api/admin/users/bad-id/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: adminHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid roleId', async () => {
    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/bad-role-id`,
      { method: 'DELETE', headers: adminHeaders() },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 204 on successful role revocation', async () => {
    fetchMock.mockImplementation(withAdminAuth((url, init) => {
      // Route handler DELETEs from user_roles with user_id/role_id params
      if (url.includes('/rest/v1/user_roles') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: adminHeaders() },
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(204);
  });

  it('returns 403 for non-admin user', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer real-auditor-token' } },
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });
});
