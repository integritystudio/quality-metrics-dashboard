/**
 * Audit logging — logAuditEvent fire-and-forget via admin mutation routes
 *
 * Verifies that mutating admin routes POST to audit_log after returning,
 * that failures do not trigger audit logging, and that audit log failures
 * do not affect response status.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import app from '../index.js';
import { HttpStatus } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE, createTestIssuer, type FetchLike, type TestIssuer } from './support/jwt.js';
import { defined } from '../../src/__tests__/support/defined.js';

type FetchMock = Mock<FetchLike>;

const MOCK_AUTH0_ID = 'auth0|test-admin-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000002';
const ADMIN_PERMISSIONS = [
  'dashboard.read', 'dashboard.executive', 'dashboard.operator', 'dashboard.auditor',
  'dashboard.traces.read', 'dashboard.sessions.read', 'dashboard.agents.read',
  'dashboard.pipeline.read', 'dashboard.compliance.read', 'dashboard.admin',
];
const VALID_USER_UUID = 'b1111111-1111-4111-8111-111111111111';
const VALID_ROLE_UUID = 'c2222222-2222-4222-8222-222222222222';

const mockAssets = {
  fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: HttpStatus.Ok })),
};

function makeEnv() {
  return {
    DASHBOARD: new MemoryKv(),
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
  };
}

function withAdminAuth(
  routeHandler: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'admin@test.com' }]), { status: HttpStatus.Ok }),
      );
    }
    if (url.includes('/rest/v1/user_roles') && decodeURIComponent(url).includes('roles(name,permissions)')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ roles: { name: 'admin', permissions: ADMIN_PERMISSIONS } }]), { status: HttpStatus.Ok }),
      );
    }
    return routeHandler(url, init);
  };
}

let fetchMock: FetchMock;
let tenant: TestIssuer;
let token: string;
let mockExecutionCtx: { waitUntil: Mock<ExecutionContext['waitUntil']>; passThroughOnException: Mock<ExecutionContext['passThroughOnException']> };

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  token = await tenant.sign({ sub: MOCK_AUTH0_ID });
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', tenant.serveJwks(fetchMock));
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

interface RoleMutation {
  action: string;
  path: string;
  init: RequestInit;
  upstreamOkStatus: number;
}

const ROLE_ASSIGN: RoleMutation = {
  action: 'role.assign',
  path: `/api/admin/users/${VALID_USER_UUID}/roles`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: VALID_ROLE_UUID }),
  },
  upstreamOkStatus: HttpStatus.NoContent,
};
const ROLE_MUTATIONS: RoleMutation[] = [
  ROLE_ASSIGN,
  {
    action: 'role.revoke',
    path: `/api/admin/users/${VALID_USER_UUID}/roles/${VALID_ROLE_UUID}`,
    init: { method: 'DELETE' },
    upstreamOkStatus: HttpStatus.Ok,
  },
];

function requestMutation({ path, init }: RoleMutation) {
  const headers = { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` };
  return app.request(path, { ...init, headers }, makeEnv(), mockExecutionCtx as unknown as ExecutionContext);
}

describe.each(ROLE_MUTATIONS)('audit log: $action', (mutation) => {
  it('POSTs to audit_log after the mutation succeeds', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: mutation.upstreamOkStatus }));
      }
      if (url.includes('/rest/v1/audit_log')) {
        return Promise.resolve(new Response(null, { status: HttpStatus.Created }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await requestMutation(mutation);
    expect(res.status).toBe(HttpStatus.NoContent);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeDefined();
    const init = defined(auditCall)[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.actor_user_id).toBe(MOCK_APP_USER_ID);
    expect(body.action).toBe(mutation.action);
    expect(body.target_type).toBe('user');
    expect(body.target_id).toBe(VALID_USER_UUID);
    expect((body.metadata as { role_id: string }).role_id).toBe(VALID_ROLE_UUID);
    // Ensure non-column names are absent — PostgREST rejects unknown columns
    expect(body.target_user_id).toBeUndefined();
    expect(body.role_id).toBeUndefined();
  });

  it('does not POST to audit_log when the mutation fails', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: HttpStatus.InternalServerError }));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await requestMutation(mutation);
    expect(res.status).toBe(HttpStatus.InternalServerError);

    await new Promise(resolve => setTimeout(resolve, 10));

    const auditCall = findAuditLogCall(fetchMock.mock.calls as unknown[][]);
    expect(auditCall).toBeUndefined();
  });
});

describe('audit log: failure resilience', () => {
  it('returns 204 even when audit_log POST rejects', async () => {
    fetchMock.mockImplementation(withAdminAuth((url) => {
      if (url.includes('/rest/v1/user_roles')) {
        return Promise.resolve(new Response(null, { status: HttpStatus.NoContent }));
      }
      if (url.includes('/rest/v1/audit_log')) {
        return Promise.reject(new Error('Supabase unreachable'));
      }
      return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
    }));

    const res = await requestMutation(ROLE_ASSIGN);
    expect(res.status).toBe(HttpStatus.NoContent);
  });
});
