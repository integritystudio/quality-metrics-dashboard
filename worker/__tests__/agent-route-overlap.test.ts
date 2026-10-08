/**
 * Overlapping agent routes — `/api/agents/detail/:agentId` vs `/api/agents/:sessionId`.
 *
 * These two patterns both match `/api/agents/detail/x`. Hono resolves it to the static
 * `detail` route, and does so independently of registration order — verified by swapping
 * the two registrations, which leaves these assertions passing. So this is coverage of
 * the overlap, NOT a guard against reordering; do not treat a green run here as proof
 * that the order in worker/index.ts is safe to rely on elsewhere.
 *
 * The handlers read different KV keys (`agent:<id>` vs `session:<id>`), which is the
 * discriminator these tests assert on.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import app from '../index.js';

const MOCK_AUTH0_ID = 'auth0|test-agents-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000003';
const AGENTS_PERMISSIONS = ['dashboard.read', 'dashboard.agents.read'];
const READ_ONLY_PERMISSIONS = ['dashboard.read'];
/** The role's permissions for the next request; reset to AGENTS_PERMISSIONS before each test. */
let rolePermissions = AGENTS_PERMISSIONS;
const AGENT_ID = 'code-reviewer';
const SESSION_ID = 'session-abc123';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

const mockKV = {
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn(),
};
const mockAssets = {
  fetch: vi.fn().mockResolvedValue(new Response('SPA', { status: 200 })),
};

function makeEnv() {
  return {
    DASHBOARD: mockKV,
    ASSETS: mockAssets,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AUTH0_DOMAIN: 'test.us.auth0.com',
    AUTH0_AUDIENCE: 'https://test.api.dev',
  };
}

function withAgentsAuth(url: string): Promise<Response> {
  if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
    return Promise.resolve(
      new Response(JSON.stringify([{ id: MOCK_APP_USER_ID, email: 'viewer@test.com' }]), { status: 200 }),
    );
  }
  if (url.includes('/rest/v1/user_roles') && decodeURIComponent(url).includes('roles(name,permissions)')) {
    return Promise.resolve(
      new Response(JSON.stringify([{ roles: { name: 'viewer', permissions: rolePermissions } }]), { status: 200 }),
    );
  }
  return Promise.resolve(new Response(null, { status: 200 }));
}

let mockExecutionCtx: { waitUntil: Mock<ExecutionContext['waitUntil']>; passThroughOnException: Mock<ExecutionContext['passThroughOnException']> };

beforeEach(async () => {
  vi.clearAllMocks();
  rolePermissions = AGENTS_PERMISSIONS;
  const jose = vi.mocked(await import('jose'));
  jose.jwtVerify.mockResolvedValue({ payload: { sub: MOCK_AUTH0_ID } } as never);
  vi.stubGlobal('fetch', vi.fn(withAgentsAuth));
  mockExecutionCtx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { void p; }),
    passThroughOnException: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(path: string) {
  return app.request(
    path,
    { headers: { Authorization: 'Bearer mock-jwt' } },
    makeEnv(),
    mockExecutionCtx as unknown as ExecutionContext,
  );
}

function kvKeys() {
  return mockKV.get.mock.calls.map(([key]) => key as string);
}

describe('overlapping agent routes: /api/agents/detail/:agentId vs /api/agents/:sessionId', () => {
  it('routes /api/agents/detail/:agentId to the agent-detail handler', async () => {
    mockKV.get.mockResolvedValue(null);

    await get(`/api/agents/detail/${AGENT_ID}`);

    expect(kvKeys()).toContain(`agent:${AGENT_ID}`);
  });

  it('does not fall through to the session handler for a "detail" path', async () => {
    mockKV.get.mockResolvedValue(null);

    await get(`/api/agents/detail/${AGENT_ID}`);

    // A param-route match would look up the literal segment as a session id.
    expect(kvKeys()).not.toContain('session:detail');
  });

  it('still routes a plain /api/agents/:sessionId to the session handler', async () => {
    mockKV.get.mockResolvedValue(null);

    await get(`/api/agents/${SESSION_ID}`);

    expect(kvKeys()).toContain(`session:${SESSION_ID}`);
    expect(kvKeys()).not.toContain(`agent:${SESSION_ID}`);
  });
});

describe('/api/agents/:sessionId payload', () => {
  const graph = { nodes: [], edges: [], rootNodeId: null, workflowShape: 'linear' };

  it('serves the workflowGraph precomputed by sync-to-kv as graph', async () => {
    mockKV.get.mockResolvedValue({ workflowGraph: graph, evaluations: [] });

    const res = await get(`/api/agents/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect((await res.json() as { graph: unknown }).graph).toEqual(graph);
  });

  it('serves graph: null for a session key synced before graphs were precomputed', async () => {
    mockKV.get.mockResolvedValue({ evaluations: [] });

    const res = await get(`/api/agents/${SESSION_ID}`);

    expect((await res.json() as { graph: unknown }).graph).toBeNull();
  });
});

describe('/api/agents/:sessionId/graph payload', () => {
  const graph = { nodes: [], edges: [], rootNodeId: null, workflowShape: 'linear' };
  const multiAgentEvaluation = { turns: [], handoffs: [], totalTurns: 0 };

  it('reads the session key and serves its graph and evaluation, without its evaluations', async () => {
    mockKV.get.mockResolvedValue({
      workflowGraph: graph,
      multiAgentEvaluation,
      evaluations: [{ evaluationName: 'relevance', scoreValue: 1 }],
    });

    const res = await get(`/api/agents/${SESSION_ID}/graph`);

    expect(res.status).toBe(200);
    expect(kvKeys()).toContain(`session:${SESSION_ID}`);
    expect(await res.json()).toEqual({ sessionId: SESSION_ID, evaluation: multiAgentEvaluation, graph });
  });

  it('answers 404 when the session has no key', async () => {
    mockKV.get.mockResolvedValue(null);

    const res = await get(`/api/agents/${SESSION_ID}/graph`);

    expect(res.status).toBe(404);
  });

  it('answers 403, without reading the session, to a role lacking dashboard.agents.read', async () => {
    rolePermissions = READ_ONLY_PERMISSIONS;
    mockKV.get.mockResolvedValue({ workflowGraph: graph, multiAgentEvaluation });

    const res = await get(`/api/agents/${SESSION_ID}/graph`);

    expect(res.status).toBe(403);
    expect(kvKeys()).not.toContain(`session:${SESSION_ID}`);
  });

  it('answers 400 to a session id with characters outside the id pattern', async () => {
    mockKV.get.mockResolvedValue(null);

    const res = await get('/api/agents/bad%20id/graph');

    expect(res.status).toBe(400);
  });
});
