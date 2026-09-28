/**
 * /api/code-quality in the Worker (production). The dev API route runs a live
 * query; the Worker has no such path, so it serves the `code-quality` KV key
 * scripts/sync-to-kv.ts writes. Before this route existed the page's request
 * missed every Worker route in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../index.js';

const BYPASS_ORG = 'a0000000-0000-4000-8000-000000000001';

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
};

const mockAssets = { fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })) };

// ALLOW_TEST_BYPASS requires the production markers to be ABSENT (empty
// HOME_ORG_ID + empty staff list) — which also matches the dev worker's config.
function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: 'test.us.auth0.com',
    AUTH0_AUDIENCE: 'https://test.api.dev',
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

// KV store fixture: get(key, 'json') resolves from a plain object.
function stubKv(store: Record<string, unknown>) {
  mockKV.get.mockImplementation((key: string) => Promise.resolve(store[key] ?? null));
}

const CODE_QUALITY_PAYLOAD = {
  survivalByAgentWindow: [{ agentName: 'agent-auditor', window: '21d', cohort: 'scored', contentKind: 'code' }],
  versionRollout: [],
  hasData: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/code-quality', () => {
  it('serves the org-scoped code-quality key the sync writes', async () => {
    stubKv({ [`org:${BYPASS_ORG}:code-quality`]: CODE_QUALITY_PAYLOAD });

    const res = await app.request('/api/code-quality', { headers: bypassHeaders() }, makeEnv({ ORG_SCOPING_ENABLED: 'true' }), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CODE_QUALITY_PAYLOAD);
    expect(mockKV.get).toHaveBeenCalledWith(`org:${BYPASS_ORG}:code-quality`, 'json');
  });

  it('answers the empty shape the page renders when the key is absent', async () => {
    stubKv({});

    const res = await app.request('/api/code-quality', { headers: bypassHeaders() }, makeEnv({ ORG_SCOPING_ENABLED: 'true' }), makeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ survivalByAgentWindow: [], versionRollout: [], hasData: false });
  });
});
