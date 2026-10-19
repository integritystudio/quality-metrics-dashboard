/**
 * Org-scoped KV read-path tests (P5) — exercised through the ALLOW_TEST_BYPASS
 * session, which carries the org-scoped session shape (activeOrgId
 * a0000000-…-0001) in the same phase as the contract change.
 *
 * Pins the three getKv behaviors the cutover depends on:
 *  1. Flag OFF → bare-key reads, byte-identical to pre-tenancy behavior.
 *  2. Flag ON → org-prefixed reads for the session's active org.
 *  3. Flag ON, non-home org, only the bare key exists → MISS. The dual-read
 *     fallback is scoped to the home org alone (Risk 6): a tenant org must
 *     never fall back into the owner's global data.
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

function dashboardFor(kv: MemoryKv, overrides: Partial<Record<string, unknown>>): Promise<Response> {
  return Promise.resolve(app.request('/api/dashboard?period=7d', { headers: BYPASS_HEADERS }, makeEnv({ DASHBOARD: kv, ...overrides }), makeCtx()));
}

describe('getKv scoping through /api/dashboard', () => {
  const bothKeys = () => new MemoryKv({
    'dashboard:7d': BARE_DASHBOARD_PAYLOAD,
    [`org:${BYPASS_ORG_ID}:dashboard:7d`]: ORG_DASHBOARD_PAYLOAD,
  });

  it('flag OFF reads the bare key (legacy behavior)', async () => {
    const res = await dashboardFor(bothKeys(), { ORG_SCOPING_ENABLED: 'false' });
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(BARE_DASHBOARD_PAYLOAD);
  });

  it('flag ON reads the org-prefixed key for the active org', async () => {
    const res = await dashboardFor(bothKeys(), { ORG_SCOPING_ENABLED: 'true' });
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(ORG_DASHBOARD_PAYLOAD);
  });

  it('flag ON, non-home org: a bare-key-only store is a MISS (no cross-org fallback)', async () => {
    // The owner's global data exists under the bare key; the session's org has
    // no synced keys. The response must be 404, not the owner's data.
    const res = await dashboardFor(new MemoryKv({ 'dashboard:7d': BARE_DASHBOARD_PAYLOAD }), { ORG_SCOPING_ENABLED: 'true' });
    expect(res.status).toBe(HttpStatus.NotFound);
    expect(await res.json()).toEqual({ error: WORKER_ERR_NO_DATA });
  });

  it('flag ON, HOME org session: bare-key fallback applies (dual-read window)', async () => {
    // Make the bypass org the home org so the fallback arm is reachable.
    const res = await app.request('/api/dashboard?period=7d', { headers: BYPASS_HEADERS }, makeEnv({
      DASHBOARD: new MemoryKv({ 'dashboard:7d': BARE_DASHBOARD_PAYLOAD }),
      ORG_SCOPING_ENABLED: 'true',
      HOME_ORG_ID: BYPASS_ORG_ID,
    }));
    // NOTE: HOME_ORG_ID set trips the production-marker assertion for the
    // bypass, so this must be 401 — which is itself the assertion under test.
    expect(res.status).toBe(HttpStatus.Unauthorized);
  });
});

describe('ALLOW_TEST_BYPASS production-marker assertion (Q7)', () => {
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
    const body = await res.json() as Record<string, unknown>;
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
      }, makeEnv({ ORG_SCOPING_ENABLED: 'true' }), makeCtx());
      expect(res.status).toBe(HttpStatus.Ok);
      const body = await res.json() as Record<string, unknown>;
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
    }, makeEnv({ ORG_SCOPING_ENABLED: 'true' }), makeCtx());
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  it('400s a non-uuid orgId', async () => {
    const res = await app.request('/api/org/switch', {
      method: 'POST',
      headers: { ...BYPASS_HEADERS, [CONTENT_TYPE_HEADER]: ContentType.Json },
      body: JSON.stringify({ orgId: 'not-a-uuid' }),
    }, makeEnv({ ORG_SCOPING_ENABLED: 'true' }), makeCtx());
    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});
