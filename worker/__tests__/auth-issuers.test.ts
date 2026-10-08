/**
 * Which `iss` values the Worker accepts on a browser token (landing CR70).
 *
 * Auth0 stamps `iss` with whichever hostname the token was obtained through — the tenant's or,
 * once a custom domain is configured, that domain — and signs both with the tenant's key set.
 * With AUTH0_CUSTOM_DOMAIN set the Worker must accept both; without it, only the tenant's.
 * jose's `jwtVerify` takes `issuer` as a string or a list, so the assertion is on what the Worker
 * hands it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app, { acceptedIssuers } from '../index.js';

const TENANT_DOMAIN = 'test.us.auth0.com';
const CUSTOM_DOMAIN = 'auth.test.integritystudio.ai';
const TENANT_ISSUER = `https://${TENANT_DOMAIN}/`;
const CUSTOM_ISSUER = `https://${CUSTOM_DOMAIN}/`;
const MOCK_AUTH0_ID = 'auth0|issuer-user';
const APP_USER_ID = 'a0000000-0000-4000-8000-000000000041';
const HOME_ORG_ID = 'a0000000-0000-4000-8000-0000000000aa';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

const mockKV = {
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn(),
};
const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })) };

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TENANT_DOMAIN,
    AUTH0_AUDIENCE: 'https://test.api.dev',
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
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function stubSupabase() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/rest/v1/users?')) return json([{ id: APP_USER_ID, email: 'viewer@test.com', default_organization_id: null }]);
    if (url.includes('/rest/v1/user_roles?')) return json([]);
    if (url.includes('/rest/v1/organization_memberships?')) return json([]);
    return Promise.resolve(new Response(null, { status: 200 }));
  }));
}

async function issuerPassedToJose(env: ReturnType<typeof makeEnv>): Promise<unknown> {
  const jose = vi.mocked(await import('jose'));
  await app.request('/api/me', { headers: { Authorization: 'Bearer mock-jwt' } }, env, makeCtx());
  expect(jose.jwtVerify).toHaveBeenCalledTimes(1);
  const [call] = jose.jwtVerify.mock.calls;
  const options = call?.[2] as { issuer?: unknown } | undefined;
  return options?.issuer;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockResolvedValue({ payload: { sub: MOCK_AUTH0_ID } } as never);
  mockKV.get.mockResolvedValue(null);
  stubSupabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acceptedIssuers', () => {
  it('is the tenant issuer alone when no custom domain is configured', () => {
    expect(acceptedIssuers({ AUTH0_DOMAIN: TENANT_DOMAIN })).toEqual([TENANT_ISSUER]);
  });

  it('adds the custom-domain issuer, trailing slash included, when one is configured', () => {
    expect(acceptedIssuers({ AUTH0_DOMAIN: TENANT_DOMAIN, AUTH0_CUSTOM_DOMAIN: CUSTOM_DOMAIN }))
      .toEqual([TENANT_ISSUER, CUSTOM_ISSUER]);
  });

  it('treats an empty custom domain as unset', () => {
    expect(acceptedIssuers({ AUTH0_DOMAIN: TENANT_DOMAIN, AUTH0_CUSTOM_DOMAIN: '' })).toEqual([TENANT_ISSUER]);
  });
});

describe('JWT verification issuer (CR70)', () => {
  it('verifies against the tenant issuer only when AUTH0_CUSTOM_DOMAIN is unset', async () => {
    expect(await issuerPassedToJose(makeEnv())).toEqual([TENANT_ISSUER]);
  });

  it('verifies against both issuers when AUTH0_CUSTOM_DOMAIN is set', async () => {
    expect(await issuerPassedToJose(makeEnv({ AUTH0_CUSTOM_DOMAIN: CUSTOM_DOMAIN })))
      .toEqual([TENANT_ISSUER, CUSTOM_ISSUER]);
  });
});
