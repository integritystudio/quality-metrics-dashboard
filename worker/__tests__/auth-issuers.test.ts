/**
 * Which `iss` values the Worker accepts on a browser token (landing CR70).
 *
 * Auth0 stamps `iss` with whichever hostname the token was obtained through — the tenant's or,
 * once a custom domain is configured, that domain — and signs both with the tenant's key set.
 * With AUTH0_CUSTOM_DOMAIN set the Worker must accept both; without it, only the tenant's.
 * Tokens are signed with a real key pair and verified by real jose against the served JWKS.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import app, { acceptedIssuers } from '../index.js';
import { jsonResponse } from './support/http.js';
import { TEST_AUTH0_DOMAIN, createTestIssuer, issuerFor, type TestIssuer } from './support/jwt.js';
import { NO_STAFF_USER_IDS, makeCtx, makeWorkerEnv } from './support/worker-env.js';
import { HttpStatus } from '../../src/lib/http-constants.js';

const TENANT_DOMAIN = TEST_AUTH0_DOMAIN;
const CUSTOM_DOMAIN = 'auth.test.integritystudio.ai';
const FOREIGN_DOMAIN = 'other-tenant.us.auth0.com';
const TENANT_ISSUER = issuerFor(TENANT_DOMAIN);
const CUSTOM_ISSUER = issuerFor(CUSTOM_DOMAIN);
const FOREIGN_ISSUER = issuerFor(FOREIGN_DOMAIN);
const MOCK_AUTH0_ID = 'auth0|issuer-user';
const APP_USER_ID = 'a0000000-0000-4000-8000-000000000041';
const HOME_ORG_ID = 'a0000000-0000-4000-8000-0000000000aa';
const HOME_MEMBERSHIP = {
  role: 'member',
  organization_id: HOME_ORG_ID,
  organizations: { id: HOME_ORG_ID, slug: 'home-org', name: 'Home Org' },
};

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return makeWorkerEnv({ ORG_SCOPING_ENABLED: 'true', HOME_ORG_ID, STAFF_USER_IDS: NO_STAFF_USER_IDS, ...overrides });
}

function supabase(url: string): Promise<Response> {
  if (url.includes('/rest/v1/users?')) return Promise.resolve(jsonResponse([{ id: APP_USER_ID, email: 'viewer@test.com', default_organization_id: null }]));
  if (url.includes('/rest/v1/user_roles?')) return Promise.resolve(jsonResponse([]));
  if (url.includes('/rest/v1/organization_memberships?')) return Promise.resolve(jsonResponse([HOME_MEMBERSHIP]));
  return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
}

let tenant: TestIssuer;

async function meStatus(issuer: string, env: ReturnType<typeof makeEnv>): Promise<number> {
  const token = await tenant.sign({ sub: MOCK_AUTH0_ID, issuer });
  const res = await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }, env, makeCtx());
  return res.status;
}

beforeAll(async () => {
  tenant = await createTestIssuer(TENANT_DOMAIN);
});

beforeEach(() => {
  vi.stubGlobal('fetch', tenant.serveJwks(supabase));
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
  describe('without AUTH0_CUSTOM_DOMAIN', () => {
    const env = () => makeEnv();

    it('accepts a token issued by the tenant', async () => {
      expect(await meStatus(TENANT_ISSUER, env())).toBe(HttpStatus.Ok);
    });

    it('refuses a token issued through the custom domain', async () => {
      expect(await meStatus(CUSTOM_ISSUER, env())).toBe(HttpStatus.Unauthorized);
    });
  });

  describe('with AUTH0_CUSTOM_DOMAIN', () => {
    const env = () => makeEnv({ AUTH0_CUSTOM_DOMAIN: CUSTOM_DOMAIN });

    it('accepts a token issued by the tenant', async () => {
      expect(await meStatus(TENANT_ISSUER, env())).toBe(HttpStatus.Ok);
    });

    it('accepts a token issued through the custom domain', async () => {
      expect(await meStatus(CUSTOM_ISSUER, env())).toBe(HttpStatus.Ok);
    });

    it('refuses a token naming any other issuer', async () => {
      expect(await meStatus(FOREIGN_ISSUER, env())).toBe(HttpStatus.Unauthorized);
    });
  });
});
