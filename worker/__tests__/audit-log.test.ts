/**
 * Audit logging — logAuditEvent fire-and-forget via admin mutation routes
 *
 * Verifies that mutating admin routes POST to audit_log after returning,
 * that failures do not trigger audit logging, and that audit log failures
 * do not affect response status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index.js';

const MOCK_AUTH0_ID = 'auth0|test-admin-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';
const ADMIN_PERMISSIONS = [
  'dashboard.read', 'dashboard.executive', 'dashboard.operator', 'dashboard.auditor',
  'dashboard.traces.read', 'dashboard.sessions.read', 'dashboard.agents.read',
  'dashboard.pipeline.read', 'dashboard.compliance.read', 'dashboard.admin',
];
const VALID_USER_UUID = 'b1111111-1111-4111-8111-111111111111';
const VALID_ROLE_UUID = 'c2222222-2222-4222-8222-222222222222';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

const mockKV = {
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn(),
};
const mockAssets = {
  fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })),
};

function makeEnv() {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: 'test.us.auth0.com',
    AUTH0_AUDIENCE: 'https://test.api.dev',
  };
}

function withAdminAuth(
  routeHandler: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'admin@test.com' }]), { status: 200 }),
      );
    }
    if (url.includes('/rest/v1/user_roles') && url.includes('roles(name,permissions)')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'admin', permissions: ADMIN_PERMISSIONS } }]), { status: 200 }),
      );
    }
    return routeHandler(url, init);
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let mockExecutionCtx: { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  vi.clearAllMocks();
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockResolvedValue({ payload: { sub: MOCK_AUTH0_ID } } as never);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mockExecutionCtx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { void p; }),
    passThroughOnException: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function findAuditLogCall(calls: unknown[][]) {
  return calls.find(([url]) =>
    typeof url === 'string' && url.includes('/rest/v1/audit_log'),
  );
}

describe('audit log: role.assign', () => {
  it('POSTs to audit_log after successful role assignment', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/rest/v1/audit_log')) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-admin-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(204);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeDefined();
    const init = auditCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.actor_user_id).toBe(MOCK_APP_USER_ID);
    expect(body.action).toBe('role.assign');
    expect(body.target_user_id).toBe(VALID_USER_UUID);
    expect(body.role_id).toBe(VALID_ROLE_UUID);
  });

  it('does not POST to audit_log when role assignment fails', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-admin-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(500);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeUndefined();
  });

  it('returns 204 even when audit_log POST rejects', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/rest/v1/audit_log')) {
        return Promise.reject(new Error('Supabase unreachable'));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-admin-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
      },
      makeEnv(),
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(204);
  });
});

describe('audit log: role.revoke', () => {
  it('POSTs to audit_log after successful role revocation', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.includes('/rest/v1/audit_log')) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer mock-admin-jwt' },
      },
      makeEnv(),
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(204);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeDefined();
    const init = auditCall![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.actor_user_id).toBe(MOCK_APP_USER_ID);
    expect(body.action).toBe('role.revoke');
    expect(body.target_user_id).toBe(VALID_USER_UUID);
    expect(body.role_id).toBe(VALID_ROLE_UUID);
  });

  it('does not POST to audit_log when role revocation fails', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request(
      `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer mock-admin-jwt' },
      },
      makeEnv(),
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(500);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeUndefined();
  });
});
