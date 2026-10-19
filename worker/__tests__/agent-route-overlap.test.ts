/**
 * Overlapping agent routes — `/api/agents/detail/:agentId` vs `/api/agents/:sessionId`.
 *
 * These two patterns both match `/api/agents/detail/x`. Hono resolves it to the static
 * `detail` route, and does so independently of registration order — verified by swapping
 * the two registrations, which leaves these assertions passing. So this is coverage of
 * the overlap, NOT a guard against reordering; do not treat a green run here as proof
 * that the order in worker/index.ts is safe to rely on elsewhere.
 *
 * The handlers read different KV keys (`agent:<id>` vs `session:<id>`); each test seeds both
 * and asserts on which payload the route serves.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import app from '../index.js';
import { jsonResponse } from './support/http.js';
import { MemoryKv } from './support/memory-kv.js';
import { TEST_AUTH0_DOMAIN, createTestIssuer, type TestIssuer } from './support/jwt.js';
import { makeCtx, makeWorkerEnv } from './support/worker-env.js';
import { HttpStatus } from '../../src/lib/http-constants.js';

const MOCK_AUTH0_ID = 'auth0|test-agents-user';
const MOCK_APP_USER_ID = 'a0000000-0000-4000-8000-000000000003';
const AGENTS_PERMISSIONS = ['dashboard.read', 'dashboard.agents.read'];
const READ_ONLY_PERMISSIONS = ['dashboard.read'];
/** The role's permissions for the next request; reset to AGENTS_PERMISSIONS before each test. */
let rolePermissions = AGENTS_PERMISSIONS;
const AGENT_ID = 'code-reviewer';
const SESSION_ID = 'session-abc123';
const AGENT_PAYLOAD = { agentName: AGENT_ID, invocations: 4 };

function withAgentsAuth(url: string): Promise<Response> {
  if (url.includes('/rest/v1/users') && url.includes('auth0_id=') && url.includes('limit=1')) {
    return Promise.resolve(jsonResponse([{ id: MOCK_APP_USER_ID, email: 'viewer@test.com' }]));
  }
  if (url.includes('/rest/v1/user_roles') && decodeURIComponent(url).includes('roles(name,permissions)')) {
    return Promise.resolve(jsonResponse([{ roles: { name: 'viewer', permissions: rolePermissions } }]));
  }
  return Promise.resolve(new Response(null, { status: HttpStatus.Ok }));
}

let tenant: TestIssuer;
let token: string;

beforeAll(async () => {
  tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
  token = await tenant.sign({ sub: MOCK_AUTH0_ID });
});

beforeEach(() => {
  rolePermissions = AGENTS_PERMISSIONS;
  vi.stubGlobal('fetch', tenant.serveJwks(withAgentsAuth));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(path: string, kv: MemoryKv) {
  return app.request(
    path,
    { headers: { Authorization: `Bearer ${token}` } },
    makeWorkerEnv({ DASHBOARD: kv }),
    makeCtx(),
  );
}

describe('overlapping agent routes: /api/agents/detail/:agentId vs /api/agents/:sessionId', () => {
  it('routes /api/agents/detail/:agentId to the agent-detail handler', async () => {
    const kv = new MemoryKv({ [`agent:${AGENT_ID}`]: AGENT_PAYLOAD, 'session:detail': { evaluations: [] } });

    const res = await get(`/api/agents/detail/${AGENT_ID}`, kv);

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(AGENT_PAYLOAD);
  });

  it('does not fall through to the session handler for a "detail" path', async () => {
    // A param-route match would serve the literal segment's session key.
    const kv = new MemoryKv({ 'session:detail': { evaluations: [] } });

    const res = await get(`/api/agents/detail/${AGENT_ID}`, kv);

    expect(res.status).toBe(HttpStatus.NotFound);
    expect(await res.json()).toEqual({ error: `No data for agent: ${AGENT_ID}` });
  });

  it('still routes a plain /api/agents/:sessionId to the session handler', async () => {
    const kv = new MemoryKv({ [`session:${SESSION_ID}`]: { evaluations: [] }, [`agent:${SESSION_ID}`]: AGENT_PAYLOAD });

    const res = await get(`/api/agents/${SESSION_ID}`, kv);

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ sessionId: SESSION_ID, evaluations: [] });
  });
});

describe('/api/agents/:sessionId payload', () => {
  const graph = { nodes: [], edges: [], rootNodeId: null, workflowShape: 'linear' };

  it('serves the workflowGraph precomputed by sync-to-kv as graph', async () => {
    const res = await get(`/api/agents/${SESSION_ID}`, new MemoryKv({ [`session:${SESSION_ID}`]: { workflowGraph: graph, evaluations: [] } }));

    expect(res.status).toBe(HttpStatus.Ok);
    expect((await res.json() as { graph: unknown }).graph).toEqual(graph);
  });

  it('serves graph: null for a session key synced before graphs were precomputed', async () => {
    const res = await get(`/api/agents/${SESSION_ID}`, new MemoryKv({ [`session:${SESSION_ID}`]: { evaluations: [] } }));

    expect((await res.json() as { graph: unknown }).graph).toBeNull();
  });
});

describe('/api/agents/:sessionId/graph payload', () => {
  const graph = { nodes: [], edges: [], rootNodeId: null, workflowShape: 'linear' };
  const multiAgentEvaluation = { turns: [], handoffs: [], totalTurns: 0 };
  const sessionKv = () => new MemoryKv({
    [`session:${SESSION_ID}`]: {
      workflowGraph: graph,
      multiAgentEvaluation,
      evaluations: [{ evaluationName: 'relevance', scoreValue: 1 }],
    },
  });

  it('reads the session key and serves its graph and evaluation, without its evaluations', async () => {
    const res = await get(`/api/agents/${SESSION_ID}/graph`, sessionKv());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ sessionId: SESSION_ID, evaluation: multiAgentEvaluation, graph });
  });

  it('answers 404 when the session has no key', async () => {
    const res = await get(`/api/agents/${SESSION_ID}/graph`, new MemoryKv());

    expect(res.status).toBe(HttpStatus.NotFound);
  });

  it('answers 403, without serving the session, to a role lacking dashboard.agents.read', async () => {
    rolePermissions = READ_ONLY_PERMISSIONS;

    const res = await get(`/api/agents/${SESSION_ID}/graph`, sessionKv());

    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('answers 400 to a session id with characters outside the id pattern', async () => {
    const res = await get('/api/agents/bad%20id/graph', new MemoryKv());

    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});
