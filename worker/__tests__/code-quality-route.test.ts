/**
 * /api/code-quality in the Worker (production). The dev API route runs a live
 * query; the Worker has no such path, so it serves the `code-quality` KV key
 * scripts/sync-to-kv.ts writes. Before this route existed the page's request
 * missed every Worker route in production.
 */

import { describe, it, expect, vi } from 'vitest';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, TEST_AUDIENCE } from './support/jwt.js';

const BYPASS_ORG = 'a0000000-0000-4000-8000-000000000001';

const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: HttpStatus.Ok })) };

// ALLOW_TEST_BYPASS requires the production markers to be ABSENT (empty
// HOME_ORG_ID + empty staff list) — which also matches the dev worker's config.
function makeEnv(kv: MemoryKv, overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: kv,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
    ALLOW_TEST_BYPASS: 'true',
    HOME_ORG_ID: '',
    STAFF_USER_IDS: '[]',
    ...overrides,
  };
}

function bypassHeaders() {
  return { Authorization: 'Bearer test-token' };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

const CODE_QUALITY_PAYLOAD = {
  survivalByAgentWindow: [{ agentName: 'agent-auditor', window: '21d', cohort: 'scored', contentKind: 'code' }],
  versionRollout: [],
  hasData: true,
};

const BARE_PAYLOAD = { ...CODE_QUALITY_PAYLOAD, versionRollout: [{ agentName: 'pre-tenancy' }] };

describe('GET /api/code-quality', () => {
  it('serves the org-scoped code-quality key the sync writes', async () => {
    const kv = new MemoryKv({ [`org:${BYPASS_ORG}:code-quality`]: CODE_QUALITY_PAYLOAD, 'code-quality': BARE_PAYLOAD });

    const res = await app.request('/api/code-quality', { headers: bypassHeaders() }, makeEnv(kv, { ORG_SCOPING_ENABLED: 'true' }), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(CODE_QUALITY_PAYLOAD);
  });

  it('answers the empty shape the page renders when the key is absent', async () => {
    const res = await app.request('/api/code-quality', { headers: bypassHeaders() }, makeEnv(new MemoryKv(), { ORG_SCOPING_ENABLED: 'true' }), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ survivalByAgentWindow: [], versionRollout: [], hasData: false });
  });
});
