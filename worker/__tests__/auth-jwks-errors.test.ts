/**
 * 401 versus 503 when token verification fails.
 *
 * The client never retries a 401 and does retry a 503, so an error that means "Auth0 is
 * unreachable" must not come back as 401. Each case drives real jose against a served key set:
 * a token Auth0 did not issue, or one that has lapsed, is 401; a JWKS endpoint that answers
 * 5xx, garbage, nothing or too late is 503.
 * The same split holds for the Supabase reads that follow: a failed read is 503, a missing
 * user row is 401.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import app from '../index.js';
import { jsonResponse } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE, createTestIssuer, jwksUrlFor, type FetchLike, type TestIssuer } from './support/jwt.js';
import { HttpStatus } from '../../src/lib/http-constants.js';

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const HMAC_SECRET_BYTES = 32;

const TENANT_DOMAIN = TEST_AUTH0_DOMAIN;
/** A second tenant whose JWKS endpoint each upstream case breaks; a failed fetch is never cached. */
const UNREACHABLE_DOMAIN = 'unreachable.us.auth0.com';
const AUTH0_ID = 'auth0|u';

const mockAssets = { fetch: vi.fn() };

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: new MemoryKv(),
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TENANT_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function noUpstream(): Promise<Response> {
  return Promise.reject(new TypeError('unexpected request'));
}

let tenant: TestIssuer;
let unreachable: TestIssuer;

async function meStatus(token: string, env = makeEnv()): Promise<number> {
  const res = await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }, env, makeCtx());
  return res.status;
}

beforeAll(async () => {
  tenant = await createTestIssuer(TENANT_DOMAIN);
  unreachable = await createTestIssuer(UNREACHABLE_DOMAIN);
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', tenant.serveJwks(noUpstream));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('token rejections are 401', () => {
  const minuteAgo = () => Math.floor(Date.now() / MS_PER_SECOND) - SECONDS_PER_MINUTE;

  it.each<[string, () => Promise<string>]>([
    ['expired', () => tenant.sign({ sub: AUTH0_ID, expiresAt: minuteAgo() })],
    ['wrong issuer', () => tenant.sign({ sub: AUTH0_ID, issuer: 'https://evil.example/' })],
    ['wrong audience', () => tenant.sign({ sub: AUTH0_ID, audience: 'https://other.api.dev' })],
    ['bad signature', async () => (await createTestIssuer(TENANT_DOMAIN, { kid: tenant.kid })).sign({ sub: AUTH0_ID })],
    ['unknown kid', async () => (await createTestIssuer(TENANT_DOMAIN)).sign({ sub: AUTH0_ID })],
    ['malformed JWS', () => Promise.resolve('not.a.jwt')],
    ['payload that is not a claims set', () => tenant.signPayload('[]')],
    ['symmetric alg', () => new SignJWT({ sub: AUTH0_ID }).setProtectedHeader({ alg: 'HS256', kid: tenant.kid }).sign(new Uint8Array(HMAC_SECRET_BYTES))],
  ])('%s', async (_label, mint) => {
    expect(await meStatus(await mint())).toBe(HttpStatus.Unauthorized);
  });

  it('a verified token without a subject', async () => {
    expect(await meStatus(await tenant.sign())).toBe(HttpStatus.Unauthorized);
  });
});

describe('upstream failures are 503', () => {
  const jwksUrl = jwksUrlFor(UNREACHABLE_DOMAIN);

  it.each<[string, () => Promise<Response>]>([
    ['JWKS timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['non-200 JWKS response', () => Promise.resolve(new Response('upstream', { status: HttpStatus.BadGateway }))],
    ['unparseable JWKS', () => Promise.resolve(new Response('<html>', { status: HttpStatus.Ok }))],
    ['JWKS that is not a key set', () => Promise.resolve(jsonResponse({ keys: 'none' }))],
    ['network failure', () => Promise.reject(new TypeError('Network connection lost.'))],
  ])('%s', async (_label, answerJwks) => {
    vi.stubGlobal('fetch', (url: string) => (url === jwksUrl ? answerJwks() : noUpstream()));
    const token = await unreachable.sign({ sub: AUTH0_ID });

    expect(await meStatus(token, makeEnv({ AUTH0_DOMAIN: UNREACHABLE_DOMAIN }))).toBe(HttpStatus.ServiceUnavailable);
  });
});

describe('Supabase reads during auth', () => {
  const APP_USER_ID = 'a0000000-0000-4000-8000-000000000051';
  const orgEnv = () => makeEnv({ ORG_SCOPING_ENABLED: 'true', HOME_ORG_ID: 'a0000000-0000-4000-8000-0000000000aa', STAFF_USER_IDS: '[]' });

  async function status(fetchImpl: FetchLike): Promise<number> {
    vi.stubGlobal('fetch', tenant.serveJwks(fetchImpl));
    return meStatus(await tenant.sign({ sub: AUTH0_ID }), orgEnv());
  }

  const userRow = [{ id: APP_USER_ID, email: 'u@test.com', default_organization_id: null }];

  it('503 when the user lookup fails', async () => {
    expect(await status(() => Promise.reject(new TypeError('Network connection lost.')))).toBe(HttpStatus.ServiceUnavailable);
    expect(await status(() => Promise.resolve(jsonResponse({ message: 'upstream' }, HttpStatus.InternalServerError)))).toBe(HttpStatus.ServiceUnavailable);
  });

  it('401 when the user has no app record', async () => {
    expect(await status(() => Promise.resolve(jsonResponse([])))).toBe(HttpStatus.Unauthorized);
  });

  it('503 when the membership read fails, rather than a session with no orgs', async () => {
    expect(await status((url) => {
      if (url.includes('/rest/v1/users?')) return Promise.resolve(jsonResponse(userRow));
      if (url.includes('/rest/v1/user_roles?')) return Promise.resolve(jsonResponse([]));
      return Promise.reject(new TypeError('Network connection lost.'));
    })).toBe(HttpStatus.ServiceUnavailable);
  });
});
