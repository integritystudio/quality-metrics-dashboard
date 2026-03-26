/**
 * AGENTS-404 — SPA fallback for Cloudflare Worker
 *
 * Non-API routes (e.g. /agents, /agents/sess-123, /) must serve index.html
 * so client-side routing works on the deployed Worker. The worker currently
 * only handles /api/* routes, so SPA fallback tests are expected to FAIL
 * until the catch-all route is implemented.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index.js';

const SPA_HTML = '<!DOCTYPE html><html><body>SPA</body></html>';

const mockAssets = {
  fetch: vi.fn(),
};

const mockKV = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
};

function makeEnv() {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
}

// Minimal auth stub for API route tests — handles the 3 middleware fetch calls
// so requests reach the route handler. Not needed for non-API (SPA) route tests.
function stubAuthFetch(): void {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/auth/v1/user')) {
      return Promise.resolve(new Response(JSON.stringify({ id: 'a0000000-0000-4000-8000-000000000001', email: 'test@example.com' }), { status: 200 }));
    }
    if (url.includes('/rest/v1/users')) {
      return Promise.resolve(new Response(JSON.stringify([{ id: 'a0000000-0000-4000-8000-000000000002', email: 'test@example.com' }]), { status: 200 }));
    }
    if (url.includes('/rest/v1/user_roles')) {
      return Promise.resolve(new Response(JSON.stringify([{ roles: { name: 'admin', permissions: ['dashboard.admin'] } }]), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssets.fetch.mockResolvedValue(
    new Response(SPA_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
  );
  mockKV.get.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// SPA fallback — non-API routes
// ---------------------------------------------------------------------------

describe('SPA fallback: non-API routes serve index.html', () => {
  it('GET /agents returns 200 with HTML content', async () => {
    const res = await app.request('/agents', {}, makeEnv());
    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/text\/html/);
  });

  it('GET /agents body contains HTML', async () => {
    const res = await app.request('/agents', {}, makeEnv());
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
  });

  it('GET /agents/sess-123 returns 200 with HTML content (nested SPA route)', async () => {
    const res = await app.request('/agents/sess-123', {}, makeEnv());
    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/text\/html/);
  });

  it('GET /agents/sess-123 body contains HTML', async () => {
    const res = await app.request('/agents/sess-123', {}, makeEnv());
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
  });

  it('GET / (root) returns 200 with HTML content', async () => {
    const res = await app.request('/', {}, makeEnv());
    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/text\/html/);
  });

  it('GET / body contains HTML', async () => {
    const res = await app.request('/', {}, makeEnv());
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
  });

  it('ASSETS.fetch is called with the original request', async () => {
    await app.request('/agents', {}, makeEnv());
    expect(mockAssets.fetch).toHaveBeenCalledTimes(1);
    const passedReq = mockAssets.fetch.mock.calls[0][0] as Request;
    expect(new URL(passedReq.url).pathname).toBe('/agents');
  });
});

// ---------------------------------------------------------------------------
// API routes remain unaffected
// ---------------------------------------------------------------------------

describe('API routes: unaffected by SPA fallback', () => {
  it('GET /api/health returns JSON (not HTML)', async () => {
    mockKV.get.mockResolvedValue('2026-03-16T00:00:00Z');
    const res = await app.request('/api/health', {}, makeEnv());
    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type') ?? '';
    expect(contentType).toMatch(/application\/json/);
  });

  it('GET /api/health response body is valid JSON with status field', async () => {
    mockKV.get.mockResolvedValue('2026-03-16T00:00:00Z');
    const res = await app.request('/api/health', {}, makeEnv());
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
  });

  it('GET /api/nonexistent returns 404 for authenticated requests', async () => {
    stubAuthFetch();
    const res = await app.request('/api/nonexistent', { headers: { Authorization: 'Bearer mock-jwt' } }, makeEnv());
    expect(res.status).toBe(404);
  });

  it('GET /api (no trailing slash) returns 404, not SPA HTML', async () => {
    stubAuthFetch();
    const res = await app.request('/api', { headers: { Authorization: 'Bearer mock-jwt' } }, makeEnv());
    expect(res.status).toBe(404);
    expect(mockAssets.fetch).not.toHaveBeenCalled();
  });
});
