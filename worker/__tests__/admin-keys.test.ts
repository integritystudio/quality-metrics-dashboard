/**
 * Admin API key routes — GET /api/admin/keys, POST /api/admin/keys/:keyId/rotate
 *
 * Tests permission enforcement, org scoping, and basic request validation.
 * Uses the same auth-mock helpers as admin-routes.test.ts:
 *   - withOrgAdminAuth: org-scoped session with dashboard.admin
 *   - mockAuditorAuthSequence: no dashboard.admin
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import app from '../index.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchLike>;

const MOCK_AUTH0_ID = 'auth0|test-admin-key-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000099';
const MOCK_ORG_ID = 'b0000000-0000-4000-8000-000000000099';
const VALID_KEY_UUID = 'c0000000-0000-4000-8000-000000000099';

const ORG_ADMIN_PERMISSIONS = [
  'dashboard.read',
  'dashboard.admin',
  'dashboard.executive',
  'dashboard.operator',
  'dashboard.auditor',
  'dashboard.traces.read',
  'dashboard.sessions.read',
  'dashboard.agents.read',
  'dashboard.pipeline.read',
  'dashboard.compliance.read',
];

const AUDITOR_PERMISSIONS = [
  'dashboard.read',
  'dashboard.auditor',
  'dashboard.compliance.read',
  'dashboard.traces.read',
  'dashboard.sessions.read',
];

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
    ORG_SCOPING_ENABLED: 'true',
    HOME_ORG_ID: MOCK_ORG_ID,
    STAFF_USER_IDS: '[]',
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn((p: Promise<unknown>) => { void p; }), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

/**
 * Wraps a route-level fetch handler with org-admin auth middleware responses.
 * Auth middleware makes 3 sequential Supabase calls under org scoping:
 *   1. GET /rest/v1/users?auth0_id=eq.{sub}&limit=1
 *   2. GET /rest/v1/user_roles?select=roles(name,permissions)&...
 *   3. GET /rest/v1/organization_memberships?...
 */
function withOrgAdminAuth(
  routeHandler: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
      return Promise.resolve(new Response(
        JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'admin@test.com', default_organization_id: MOCK_ORG_ID }]),
        { status: 200 },
      ));
    }
    if (url.includes('/rest/v1/user_roles') && decodeURIComponent(url).includes('roles(name,permissions)')) {
      return Promise.resolve(new Response(
        JSON.stringify([{ roles: { name: 'org-admin', permissions: ORG_ADMIN_PERMISSIONS } }]),
        { status: 200 },
      ));
    }
    if (url.includes('/rest/v1/organization_memberships')) {
      return Promise.resolve(new Response(
        JSON.stringify([{
          role: 'admin',
          organization_id: MOCK_ORG_ID,
          organizations: { id: MOCK_ORG_ID, slug: 'test-org', name: 'Test Org' },
        }]),
        { status: 200 },
      ));
    }
    return routeHandler(url, init);
  };
}

function mockAuditorAuthSequence(fetchMock: FetchMock) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=')) {
      return Promise.resolve(new Response(
        JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'auditor@test.com', default_organization_id: null }]),
        { status: 200 },
      ));
    }
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(new Response(
        JSON.stringify([{ roles: { name: 'auditor', permissions: AUDITOR_PERMISSIONS } }]),
        { status: 200 },
      ));
    }
    if (url.includes('/rest/v1/organization_memberships')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  });
}

function adminHeaders() {
  return { Authorization: 'Bearer mock-org-admin-jwt' };
}

let fetchMock: FetchMock;

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockResolvedValue({ payload: { sub: MOCK_AUTH0_ID } } as never);
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(withOrgAdminAuth(() => Promise.resolve(new Response(null, { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── GET /api/admin/keys ──────────────────────────────────────────────────────

describe('GET /api/admin/keys', () => {
  it('returns 403 for non-admin (auditor) session', async () => {
    mockAuditorAuthSequence(fetchMock);
    const res = await app.request('/api/admin/keys', { headers: adminHeaders() }, makeEnv(), makeCtx());
    expect(res.status).toBe(403);
  });

  it('returns 200 with key list for org-admin', async () => {
    const mockKeys = [
      {
        id: VALID_KEY_UUID,
        prefix: 'abcd1234',
        name: 'test-key',
        tier: 'standard',
        status: 'active',
        // PostgREST's own timestamptz format: the offset is what a bare z.iso.datetime() rejected.
        created_at: '2026-10-01T06:46:19.086694+00:00',
        last_used_at: '2026-10-02T11:00:00+00:00',
      },
    ];

    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys')) {
        return Promise.resolve(new Response(JSON.stringify(mockKeys), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request('/api/admin/keys', { headers: adminHeaders() }, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
  });

  it('queries only active keys for the active org and caller', async () => {
    let capturedUrl = '';
    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys')) {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    await app.request('/api/admin/keys', { headers: adminHeaders() }, makeEnv(), makeCtx());

    expect(capturedUrl).toContain(`user_id=eq.${encodeURIComponent(MOCK_APP_USER_ID)}`);
    expect(capturedUrl).toContain(`organization_id=eq.${encodeURIComponent(MOCK_ORG_ID)}`);
    expect(capturedUrl).toContain('status=eq.active');
  });

  it('returns 500 when Supabase query fails', async () => {
    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys')) {
        return Promise.resolve(new Response('error', { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await app.request('/api/admin/keys', { headers: adminHeaders() }, makeEnv(), makeCtx());
    expect(res.status).toBe(500);
  });
});

// ─── POST /api/admin/keys/:keyId/rotate ───────────────────────────────────────

describe('POST /api/admin/keys/:keyId/rotate', () => {
  function rotateRequest(keyId: string) {
    return app.request(
      `/api/admin/keys/${keyId}/rotate`,
      { method: 'POST', headers: adminHeaders() },
      makeEnv(),
      makeCtx(),
    );
  }

  it('returns 403 for non-admin (auditor) session', async () => {
    mockAuditorAuthSequence(fetchMock);
    const res = await rotateRequest(VALID_KEY_UUID);
    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-UUID keyId', async () => {
    const res = await rotateRequest('not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns 403 when the key does not belong to the active org', async () => {
    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys')) {
        // Empty result: key not found in org
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await rotateRequest(VALID_KEY_UUID);
    expect(res.status).toBe(403);
  });

  it('returns 200 and the new token on a successful rotation', async () => {
    const mockRotateResponse = {
      token: 'obtk_newtoken12345678901234567890123456789012345678901234',
      keyId: 'd0000000-0000-4000-8000-000000000099',
      previousKeyId: VALID_KEY_UUID,
      prefix: 'newtoke1',
      tier: 'standard',
    };

    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys') && url.includes('id=eq.')) {
        // Ownership check — key found
        return Promise.resolve(new Response(JSON.stringify([{ id: VALID_KEY_UUID }]), { status: 200 }));
      }
      if (url.includes('/functions/v1/api-keys-rotate')) {
        return Promise.resolve(new Response(JSON.stringify(mockRotateResponse), { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await rotateRequest(VALID_KEY_UUID);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ token: mockRotateResponse.token });
  });

  it('calls the Supabase function with the service key and the verified user, never the user token', async () => {
    // The function accepts only a service-level key (verify_jwt = false), and Supabase
    // cannot verify an Auth0 token, so forwarding the caller's token would fail every rotation.
    let capturedFnInit: RequestInit | undefined;
    fetchMock.mockImplementation(withOrgAdminAuth((url, init) => {
      if (url.includes('/rest/v1/api_keys') && url.includes('id=eq.')) {
        return Promise.resolve(new Response(JSON.stringify([{ id: VALID_KEY_UUID }]), { status: 200 }));
      }
      if (url.includes('/functions/v1/api-keys-rotate')) {
        capturedFnInit = init;
        return Promise.resolve(new Response(JSON.stringify({ token: 'obtk_x' }), { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    await rotateRequest(VALID_KEY_UUID);

    const headers = capturedFnInit?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBe('Bearer test-service-role-key');
    expect(headers?.['apikey']).toBe('test-service-role-key');
    expect(JSON.stringify(headers)).not.toContain('mock-org-admin-jwt');
    expect(JSON.parse(capturedFnInit?.body as string)).toEqual({ keyId: VALID_KEY_UUID, userId: MOCK_APP_USER_ID });
  });

  it('returns 500 when the Supabase function fails', async () => {
    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys') && url.includes('id=eq.')) {
        return Promise.resolve(new Response(JSON.stringify([{ id: VALID_KEY_UUID }]), { status: 200 }));
      }
      if (url.includes('/functions/v1/api-keys-rotate')) {
        return Promise.resolve(new Response('rotation failed', { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await rotateRequest(VALID_KEY_UUID);
    expect(res.status).toBe(500);
  });

  it('returns 500 when the Supabase function call throws a network error', async () => {
    fetchMock.mockImplementation(withOrgAdminAuth((url) => {
      if (url.includes('/rest/v1/api_keys') && url.includes('id=eq.')) {
        return Promise.resolve(new Response(JSON.stringify([{ id: VALID_KEY_UUID }]), { status: 200 }));
      }
      if (url.includes('/functions/v1/api-keys-rotate')) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    const res = await rotateRequest(VALID_KEY_UUID);
    expect(res.status).toBe(500);
  });
});
