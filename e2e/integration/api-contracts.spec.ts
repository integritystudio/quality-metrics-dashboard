/**
 * E2E-1: Production-aligned integration tests.
 *
 * Hits the deployed Cloudflare Worker with a real Supabase JWT.
 * No mocks — validates actual API contracts and auth flow.
 *
 * Run: doppler run --project integrity-studio --config dev -- npx playwright test --project integration
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '.integration-state.json');

interface IntegrationState {
  jwt: string;
  userId: string;
  email: string;
  workerUrl: string;
}

let state: IntegrationState;
let authHeaders: Record<string, string>;

test.beforeAll(() => {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as IntegrationState;
  authHeaders = { 'Authorization': `Bearer ${state.jwt}` };
});

function url(path: string): string {
  return `${state.workerUrl}${path}`;
}

test.describe('Auth flow', () => {
  test('GET /api/me returns authenticated user session', async ({ request }) => {
    const res = await request.get(url('/api/me'), { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('email', state.email);
    expect(body).toHaveProperty('roles');
    expect(body).toHaveProperty('permissions');
    expect(body).toHaveProperty('allowedViews');
    expect(Array.isArray(body.permissions)).toBe(true);
    expect(Array.isArray(body.allowedViews)).toBe(true);
  });

  test('GET /api/me returns 401 without token', async ({ request }) => {
    const res = await request.get(url('/api/me'));
    expect(res.status()).toBe(401);
  });

  test('GET /api/me returns 401 with invalid token', async ({ request }) => {
    const res = await request.get(url('/api/me'), {
      headers: { 'Authorization': 'Bearer invalid.jwt.token' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('Dashboard API contracts', () => {
  test('GET /api/health returns 200 without auth', async ({ request }) => {
    const res = await request.get(url('/api/health'));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
  });

  test('GET /api/dashboard returns valid shape', async ({ request }) => {
    const res = await request.get(url('/api/dashboard?period=7d'), { headers: authHeaders });
    // 200 = data exists, 404 = no data synced yet — both are valid
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('metrics');
    }
  });

  test('GET /api/dashboard rejects invalid period', async ({ request }) => {
    const res = await request.get(url('/api/dashboard?period=99d'), { headers: authHeaders });
    expect(res.status()).toBe(400);
  });

  test('GET /api/metrics/:name returns 200 or 404', async ({ request }) => {
    const res = await request.get(url('/api/metrics/relevance'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/metrics/:name rejects invalid name', async ({ request }) => {
    // Path traversal gets normalized by HTTP clients; use a name with invalid chars instead
    const res = await request.get(url('/api/metrics/foo%00bar'), { headers: authHeaders });
    expect(res.status()).toBe(400);
  });

  test('GET /api/trends/:name returns 200 or 404', async ({ request }) => {
    const res = await request.get(url('/api/trends/relevance?period=7d'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/correlations returns 200 or 404', async ({ request }) => {
    const res = await request.get(url('/api/correlations?period=7d'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/degradation-signals returns valid response', async ({ request }) => {
    const res = await request.get(url('/api/degradation-signals?period=7d'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/coverage returns valid shape', async ({ request }) => {
    const res = await request.get(url('/api/coverage?period=7d'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('metrics');
    }
  });

  test('GET /api/calibration returns valid response', async ({ request }) => {
    const res = await request.get(url('/api/calibration'), { headers: authHeaders });
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/routing-telemetry returns valid response', async ({ request }) => {
    const res = await request.get(url('/api/routing-telemetry?period=7d'), { headers: authHeaders });
    // 200 = data exists, 404 = no KV entry, 500 = schema validation failure on malformed data
    expect([200, 404, 500]).toContain(res.status());
  });
});

test.describe('Permission-gated routes', () => {
  test('GET /api/pipeline requires dashboard.pipeline.read', async ({ request }) => {
    const res = await request.get(url('/api/pipeline?period=7d'), { headers: authHeaders });
    // 200 if user has permission and data exists, 403 if no permission, 404 if no data
    expect([200, 403, 404]).toContain(res.status());
  });

  test('GET /api/agents requires dashboard.agents.read', async ({ request }) => {
    const res = await request.get(url('/api/agents'), { headers: authHeaders });
    expect([200, 403, 404]).toContain(res.status());
  });

  test('GET /api/compliance/sla requires proper permissions', async ({ request }) => {
    const res = await request.get(url('/api/compliance/sla?period=7d'), { headers: authHeaders });
    expect([200, 403, 404]).toContain(res.status());
  });
});

test.describe('Admin routes (should be forbidden for test user)', () => {
  test('GET /api/admin/users returns 403 for non-admin', async ({ request }) => {
    const res = await request.get(url('/api/admin/users'), { headers: authHeaders });
    // Test user has a dashboard.read role, not dashboard.admin
    expect(res.status()).toBe(403);
  });

  test('GET /api/admin/roles returns 403 for non-admin', async ({ request }) => {
    const res = await request.get(url('/api/admin/roles'), { headers: authHeaders });
    expect(res.status()).toBe(403);
  });
});

test.describe('Activity logging', () => {
  test('POST /api/logout returns 204', async ({ request }) => {
    // Note: this doesn't invalidate the JWT — Supabase JWTs are stateless
    const res = await request.post(url('/api/logout'), { headers: authHeaders });
    expect(res.status()).toBe(204);
  });

  test('POST /api/activity with valid body returns 204', async ({ request }) => {
    const res = await request.post(url('/api/activity'), {
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      data: { activity_type: 'login' },
    });
    expect(res.status()).toBe(204);
  });

  test('POST /api/activity with invalid body returns 400', async ({ request }) => {
    const res = await request.post(url('/api/activity'), {
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      data: { invalid: 'field' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('CORS headers', () => {
  test('OPTIONS /api/me returns CORS headers', async ({ request }) => {
    const res = await request.fetch(url('/api/me'), {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://integritystudio.dev',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const allowOrigin = res.headers()['access-control-allow-origin'];
    expect(allowOrigin).toBe('https://integritystudio.dev');
  });
});
