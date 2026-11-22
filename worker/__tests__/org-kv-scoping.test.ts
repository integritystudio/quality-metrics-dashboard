/**
 * Org-scoped KV read-path tests — exercised through the ALLOW_TEST_BYPASS
 * session, which carries the org-scoped session shape (activeOrgId
 * a0000000-…-0001).
 *
 * Pins the getKv behaviors:
 *  1. Reads are org-prefixed for the session's active org.
 *  2. Non-home org, only the bare key exists → MISS. The dual-read fallback is
 *     scoped to the home org alone: a tenant org must never fall back into the
 *     owner's global data.
 */

import { describe, it, expect, vi } from 'vitest';
import app from '../index.js';
import { WORKER_ERR_NO_DATA } from '../../src/lib/worker-contract.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { BYPASS_BINDINGS, BYPASS_HEADERS, BYPASS_ORG_ID, makeCtx, makeWorkerEnv } from './support/worker-env.js';

function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return makeWorkerEnv({ ...BYPASS_BINDINGS, ...overrides });
}

const ORG_DASHBOARD_PAYLOAD = { overallStatus: 'healthy', metrics: [] };
const BARE_DASHBOARD_PAYLOAD = { overallStatus: 'degraded', metrics: [] };

function dashboardFor(kv: MemoryKv): Promise<Response> {
  return Promise.resolve(app.request('/api/dashboard?period=7d', { headers: BYPASS_HEADERS }, makeEnv({ DASHBOARD: kv }), makeCtx()));
}

describe('getKv scoping through /api/dashboard', () => {
  const bothKeys = () => new MemoryKv({
    'dashboard:7d': BARE_DASHBOARD_PAYLOAD,
    [`org:${BYPASS_ORG_ID}:dashboard:7d`]: ORG_DASHBOARD_PAYLOAD,
  });

  it('reads the org-prefixed key for the active org', async () => {
    const res = await dashboardFor(bothKeys());
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(ORG_DASHBOARD_PAYLOAD);
  });

  it('non-home org: a bare-key-only store is a MISS (no cross-org fallback)', async () => {
    // The owner's global data exists under the bare key; the session's org has
    // no synced keys. The response must be 404, not the owner's data.
    const res = await dashboardFor(new MemoryKv({ 'dashboard:7d': BARE_DASHBOARD_PAYLOAD }));
    expect(res.status).toBe(HttpStatus.NotFound);
    expect(await res.json()).toEqual({ error: WORKER_ERR_NO_DATA });
  });

  it('a bypass session cannot be made the home org to reach the bare-key fallback', async () => {
    // Make the bypass org the home org so the fallback arm is reachable.
    const res = await app.request('/api/dashboard?period=7d', { headers: BYPASS_HEADERS }, makeEnv({
      DASHBOARD: new MemoryKv({ 'dashboard:7d': BARE_DASHBOARD_PAYLOAD }),
      HOME_ORG_ID: BYPASS_ORG_ID,
    }));
    // NOTE: HOME_ORG_ID set trips the production-marker assertion for the
    // bypass, so this must be 401 — which is itself the assertion under test.
    expect(res.status).toBe(HttpStatus.Unauthorized);
  });
});

describe('ALLOW_TEST_BYPASS production-marker assertion', () => {
  it('refuses the bypass when HOME_ORG_ID is set', async () => {
    const res = await app.request('/api/me', { headers: BYPASS_HEADERS }, makeEnv({ HOME_ORG_ID: 'f4286657-da73-4174-9e49-937f1bb6097f' }));
    expect(res.status).toBe(HttpStatus.Unauthorized);
  });

  it('refuses the bypass when the staff allowlist is non-empty', async () => {
    const res = await app.request('/api/me', { headers: BYPASS_HEADERS }, makeEnv({ STAFF_USER_IDS: '["f7a787eb-b97f-4636-b68d-2a08c52ae13d"]' }));
    expect(res.status).toBe(HttpStatus.Unauthorized);
  });

  it('allows the bypass in a marker-free (dev) environment and carries org context', async () => {
    const res = await app.request('/api/me', { headers: BYPASS_HEADERS }, makeEnv());
    expect(res.status).toBe(HttpStatus.Ok);
    const body = await res.json<Record<string, unknown>>();
    expect(body.activeOrg).toBe(BYPASS_ORG_ID);
    expect(body.role).toBe('owner');
    expect(body.isStaff).toBe(false);
    expect(Array.isArray(body.memberships)).toBe(true);
  });
});

describe('/api/org/switch', () => {
  it('switches to a member org and returns the updated me payload', async () => {
    // The PATCH to users must succeed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: HttpStatus.NoContent }));
    try {
      const res = await app.request('/api/org/switch', {
        method: 'POST',
        headers: { ...BYPASS_HEADERS, [CONTENT_TYPE_HEADER]: ContentType.Json },
        body: JSON.stringify({ orgId: BYPASS_ORG_ID }),
      }, makeEnv(), makeCtx());
      expect(res.status).toBe(HttpStatus.Ok);
      const body = await res.json<Record<string, unknown>>();
      expect(body.activeOrg).toBe(BYPASS_ORG_ID);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('403s a switch to an org the session is not a member of', async () => {
    const res = await app.request('/api/org/switch', {
      method: 'POST',
      headers: { ...BYPASS_HEADERS, [CONTENT_TYPE_HEADER]: ContentType.Json },
      body: JSON.stringify({ orgId: 'deadbeef-dead-4bad-8bad-deadbeefdead' }),
    }, makeEnv(), makeCtx());
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  it('400s a non-uuid orgId', async () => {
    const res = await app.request('/api/org/switch', {
      method: 'POST',
      headers: { ...BYPASS_HEADERS, [CONTENT_TYPE_HEADER]: ContentType.Json },
      body: JSON.stringify({ orgId: 'not-a-uuid' }),
    }, makeEnv(), makeCtx());
    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});
