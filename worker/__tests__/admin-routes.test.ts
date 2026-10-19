/**
 * Admin API route tests — GET/POST/DELETE /api/admin/*
 *
 * Tests permission enforcement and basic request validation for admin routes.
 * Admin tests use withAdminAuth() to compose fetch mocks: auth middleware calls
 * are handled by the helper layer; route-specific calls are handled by the test.
 * Non-admin tests use mockAuditorAuthSequence (auditor permissions, no dashboard.admin).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import app from '../index.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../../src/lib/http-constants.js';
import { TEST_AUTH0_DOMAIN, createTestIssuer, type FetchLike, type TestIssuer } from './support/jwt.js';
import { makeCtx, makeWorkerEnv } from './support/worker-env.js';

type FetchMock = Mock<FetchLike>;

const MOCK_AUTH0_ID = 'auth0|test-admin-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';

// Auditor has no dashboard.admin permission
const AUDITOR_PERMISSIONS = ['dashboard.read', 'dashboard.auditor', 'dashboard.compliance.read', 'dashboard.traces.read', 'dashboard.sessions.read'];
const ADMIN_PERMISSIONS = ['dashboard.read', 'dashboard.executive', 'dashboard.operator', 'dashboard.auditor', 'dashboard.traces.read', 'dashboard.sessions.read', 'dashboard.agents.read', 'dashboard.pipeline.read', 'dashboard.compliance.read', 'dashboard.admin'];

const VALID_USER_UUID = 'b1111111-1111-4111-8111-111111111111';
const VALID_ROLE_UUID = 'c2222222-2222-4222-8222-222222222222';
const VALID_KEY_UUID = 'd3333333-3333-4333-8333-333333333333';

function adminHeaders() {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Wraps a route-level fetch handler with auth middleware responses.
 * The auth middleware makes 2 sequential Supabase calls (the token is verified against the served JWKS first):
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
      return Promise.resolve(new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'admin@test.com' }]), { status: HttpStatus.Ok }));
    }
    // Auth roles: has roles(name,permissions)
    if (url.includes('/rest/v1/user_roles') && decodeURIComponent(url).includes('roles(name,permissions)')) {
      return Promise.resolve(new Response(JSON.stringify([{ roles: { name: 'admin', permissions: ADMIN_PERMISSIONS } }]), { status: HttpStatus.Ok }));
    }
    return routeHandler(url, init);
  };
}

/** Mock a non-admin auth sequence (auditor permissions, no dashboard.admin). */
function mockAuditorAuthSequence(fetchMock: FetchMock) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'auditor@test.com' }]), { status: HttpStatus.Ok }),
      );
    }
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'auditor', permissions: AUDITOR_PERMISSIONS } }]), { status: HttpStatus.Ok }),
      );
    }
    return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
  });
}

let fetchMock: FetchMock;

let tenant: TestIssuer;
let token: string;

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  token = await tenant.sign({ sub: MOCK_AUTH0_ID });
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', tenant.serveJwks(fetchMock));
  // Default: admin auth succeeds; route handler returns 200 for unmatched calls.
  fetchMock.mockImplementation(withAdminAuth(() => Promise.resolve(new Response(null, { status: HttpStatus.Ok }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Authentication (every /api/admin/* route) ─────────────────────────────────

/**
 * Pins the wiring, not the guards: registerAdminRoutes is exported, so nothing in the type
 * system stops a caller mounting these routes on an app without the /api/* authenticate
 * middleware. An unauthenticated request must be refused before any handler runs.
 */
const ADMIN_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/api/admin/members'],
  ['POST', `/api/admin/members/${VALID_USER_UUID}/role`],
  ['DELETE', `/api/admin/members/${VALID_USER_UUID}`],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/roles'],
  ['POST', `/api/admin/users/${VALID_USER_UUID}/roles`],
  ['DELETE', `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`],
  ['GET', '/api/admin/keys'],
  ['POST', `/api/admin/keys/${VALID_KEY_UUID}/rotate`],
];

describe.each(ADMIN_ROUTES)('%s %s', (method, path) => {
  it('returns 401 without a bearer token', async () => {
    const res = await app.request(path, { method }, makeWorkerEnv());
    expect(res.status).toBe(HttpStatus.Unauthorized);
    // No Supabase call may precede the refusal.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── GET /api/admin/users ──────────────────────────────────────────────────────

describe('GET /api/admin/users', () => {
  it('returns 403 for non-admin user (auditor)', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      '/api/admin/users',
      { headers: { Authorization: `Bearer ${token}` } },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  it('returns 200 with user list for admin user', async () => {
    const mockUsers = [
      { id: VALID_USER_UUID, email: 'user@test.com', created_at: '2026-03-26T05:56:23.812873+00:00' }, // PostgREST format
    ];
    const mockRoleRows = [
      { user_id: VALID_USER_UUID, role_id: VALID_ROLE_UUID, roles: { id: VALID_ROLE_UUID, name: 'auditor' } },
    ];

    fetchMock.mockImplementation(withAdminAuth((url) => {
      // Admin route fetches all users (order=created_at.desc) and role assignments (user_id,role_id)
      if (url.includes('/rest/v1/users')) {
        return Promise.resolve(new Response(JSON.stringify(mockUsers), { status: HttpStatus.Ok }));
      }
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(JSON.stringify(mockRoleRows), { status: HttpStatus.Ok }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await app.request(
      '/api/admin/users',
      { headers: adminHeaders() },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Ok);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // The route drops any row that fails AdminUserSchema, so an empty array is the failure mode.
    expect(data).toEqual([expect.objectContaining({ id: VALID_USER_UUID })]);
  });
});

// ─── GET /api/admin/roles ──────────────────────────────────────────────────────

describe('GET /api/admin/roles', () => {
  it('returns 403 for non-admin user (auditor)', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      '/api/admin/roles',
      { headers: { Authorization: `Bearer ${token}` } },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  it('returns 200 with roles list for admin user', async () => {
    const mockRoles = [
      { id: VALID_ROLE_UUID, name: 'auditor', permissions: AUDITOR_PERMISSIONS },
    ];

    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/roles')) {
        return Promise.resolve(new Response(JSON.stringify(mockRoles), { status: HttpStatus.Ok }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await app.request(
      '/api/admin/roles',
      { headers: adminHeaders() },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Ok);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
  });

  it('returns its own 500 when Supabase is unreachable', async () => {
    fetchMock.mockImplementation(withAdminAuth(() => Promise.reject(new TypeError('Network connection lost.'))));

    const res = await app.request('/api/admin/roles', { headers: adminHeaders() }, makeWorkerEnv());
    expect(res.status).toBe(HttpStatus.InternalServerError);
    expect(await res.json()).toEqual({ error: 'Failed to fetch roles' });
  });
});

// ─── POST /api/admin/users/:userId/roles ──────────────────────────────────────

describe('POST /api/admin/users/:userId/roles', () => {
  it('returns 400 for invalid (non-UUID) userId', async () => {
    const res = await app.request(
      '/api/admin/users/not-a-uuid/roles',
      {
        method: 'POST',
        headers: { ...adminHeaders(), [CONTENT_TYPE_HEADER]: ContentType.Json },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.BadRequest);
  });

  it('returns 400 for invalid request body (missing role_id)', async () => {
    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { ...adminHeaders(), [CONTENT_TYPE_HEADER]: ContentType.Json },
        body: JSON.stringify({}),
      },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.BadRequest);
  });

  it('returns 204 on successful role assignment', async () => {
    fetchMock.mockImplementation(withAdminAuth((url, init) => {
      // Route handler POSTs to user_roles with no query params
      if (url.includes('/rest/v1/user_roles') && init?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: HttpStatus.Created }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { ...adminHeaders(), [CONTENT_TYPE_HEADER]: ContentType.Json },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeWorkerEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(HttpStatus.NoContent);
  });

  it('returns 403 for non-admin user', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, [CONTENT_TYPE_HEADER]: ContentType.Json },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Forbidden);
  });
});

// ─── DELETE /api/admin/users/:userId/roles/:roleId ────────────────────────────

describe('DELETE /api/admin/users/:userId/roles/:roleId', () => {
  it('returns 400 for invalid userId', async () => {
    const res = await app.request(
      `/api/admin/users/bad-id/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: adminHeaders() },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.BadRequest);
  });

  it('returns 400 for invalid roleId', async () => {
    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/bad-role-id`,
      { method: 'DELETE', headers: adminHeaders() },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.BadRequest);
  });

  it('returns 204 on successful role revocation', async () => {
    fetchMock.mockImplementation(withAdminAuth((url, init) => {
      // Route handler DELETEs from user_roles with user_id/role_id params
      if (url.includes('/rest/v1/user_roles') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: adminHeaders() },
      makeWorkerEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(HttpStatus.NoContent);
  });

  it('returns 403 for non-admin user', async () => {
    mockAuditorAuthSequence(fetchMock);

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      makeWorkerEnv(),
    );
    expect(res.status).toBe(HttpStatus.Forbidden);
  });
});
