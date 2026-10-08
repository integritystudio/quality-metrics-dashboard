/**
 * 401 versus 503 when `jwtVerify` throws.
 *
 * The client never retries a 401 and does retry a 503, so an error that means "Auth0 is
 * unreachable" must not come back as 401. jose throws a generic JOSEError on a non-200 JWKS
 * response and rethrows the raw fetch error on a network failure; neither is a token problem.
 * The real error classes are used, so a jose rename fails here rather than in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { errors } from 'jose';
import type * as Jose from 'jose';
import app from '../index.js';

vi.mock('jose', async (importOriginal) => ({
  ...await importOriginal<typeof Jose>(),
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;

const mockKV = {
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn(),
};
const mockAssets = { fetch: vi.fn() };

const env = {
  DASHBOARD: mockKV,
  ASSETS: mockAssets,
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  AUTH0_DOMAIN: 'test.us.auth0.com',
  AUTH0_AUDIENCE: 'https://test.api.dev',
};

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

async function statusWhenVerifyThrows(err: unknown): Promise<number> {
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockRejectedValue(err);
  const res = await app.request('/api/me', { headers: { Authorization: 'Bearer mock-jwt' } }, env, makeCtx());
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('token rejections are 401', () => {
  it.each([
    ['expired', new errors.JWTExpired('"exp" claim timestamp check failed', {})],
    ['wrong issuer', new errors.JWTClaimValidationFailed('unexpected "iss" claim value', {})],
    ['bad signature', new errors.JWSSignatureVerificationFailed()],
    ['malformed JWS', new errors.JWSInvalid('Invalid Compact JWS')],
    ['malformed JWT', new errors.JWTInvalid('JWT Claims Set must be a top-level JSON object')],
    ['unknown kid', new errors.JWKSNoMatchingKey()],
    ['disallowed alg', new errors.JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed')],
  ])('%s', async (_label, err) => {
    expect(await statusWhenVerifyThrows(err)).toBe(UNAUTHORIZED);
  });
});

describe('upstream failures are 503', () => {
  it.each([
    ['JWKS timeout', new errors.JWKSTimeout()],
    ['non-200 JWKS response', new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')],
    ['unparseable JWKS', new errors.JWKSInvalid()],
    ['network failure', new TypeError('Network connection lost.')],
  ])('%s', async (_label, err) => {
    expect(await statusWhenVerifyThrows(err)).toBe(SERVICE_UNAVAILABLE);
  });
});
