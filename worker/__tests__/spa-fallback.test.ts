/**
 * SPA fallback for Cloudflare Worker
 *
 * Non-API routes (e.g. /agents, /agents/sess-123, /) must serve index.html
 * so client-side routing works on the deployed Worker. The worker currently
 * only handles /api/* routes, so SPA fallback tests are expected to FAIL
 * until the catch-all route is implemented.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import app from '../index.js';
import { HttpStatus, jsonResponse } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE, createTestIssuer, type TestIssuer } from './support/jwt.js';

const LAST_SYNC = '2026-03-16T00:00:00Z';

const SPA_HTML = '<!DOCTYPE html><html><body>SPA</body></html>';

const mockAssets = {
  fetch: vi.fn(),
};

function makeEnv(kv = new MemoryKv()) {
  return {
    DASHBOARD: kv,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
  };
}

let tenant: TestIssuer;
let authHeaders: { Authorization: string };

// Minimal auth stub for API route tests: the JWKS plus the 2 middleware Supabase reads.
function stubAuthFetch(): void {
  vi.stubGlobal('fetch', tenant.serveJwks((url: string) => {
    if (url.includes('/rest/v1/users') && url.includes('auth0_id=')) {
      return Promise.resolve(jsonResponse([{ id: 'a0000000-0000-4000-8000-000000000002', email: 'test@example.com' }]));
    }
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(jsonResponse([{ roles: { name: 'admin', permissions: ['dashboard.admin'] } }]));
    }
    return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
  }));
}

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  authHeaders = { Authorization: `Bearer ${await tenant.sign({ sub: 'auth0|test-user' })}` };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAssets.fetch.mockResolvedValue(
    new Response(SPA_HTML, {
      status: HttpStatus.Ok,
      headers: { 'Content-Type': 'text/html' },
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// SPA fallback — non-API routes

describe('SPA fallback: non-API routes serve index.html', () => {
  it.each([
    { path: '/agents' },
    { path: '/agents/sess-123' },
    { path: '/' },
  ])('GET $path returns 200 with an HTML body', async ({ path }) => {
    const res = await app.request(path, {}, makeEnv());
    expect(res.status).toBe(HttpStatus.Ok);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
  });

  it('ASSETS.fetch is called with the original request', async () => {
    await app.request('/agents', {}, makeEnv());
    expect(mockAssets.fetch).toHaveBeenCalledTimes(1);
    const passedReq = mockAssets.fetch.mock.calls[0]![0] as Request;
    expect(new URL(passedReq.url).pathname).toBe('/agents');
  });
});

// API routes remain unaffected

describe('API routes: unaffected by SPA fallback', () => {
  it('GET /api/health returns JSON (not HTML)', async () => {
    const res = await app.request('/api/health', {}, makeEnv(new MemoryKv({ 'meta:lastSync': LAST_SYNC })));
    expect(res.status).toBe(HttpStatus.Ok);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/application\/json/);
  });

  it('GET /api/health response body reports the last sync', async () => {
    const res = await app.request('/api/health', {}, makeEnv(new MemoryKv({ 'meta:lastSync': LAST_SYNC })));
    expect(await res.json()).toEqual({ status: 'ok', lastSync: LAST_SYNC });
  });

  it('GET /api/nonexistent returns 404 for authenticated requests', async () => {
    stubAuthFetch();
    const res = await app.request('/api/nonexistent', { headers: authHeaders }, makeEnv());
    expect(res.status).toBe(HttpStatus.NotFound);
  });

  it('GET /api (no trailing slash) returns 404, not SPA HTML', async () => {
    stubAuthFetch();
    const res = await app.request('/api', { headers: authHeaders }, makeEnv());
    expect(res.status).toBe(HttpStatus.NotFound);
    expect(mockAssets.fetch).not.toHaveBeenCalled();
  });
});
