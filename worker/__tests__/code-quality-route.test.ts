/**
 * /api/code-quality in the Worker (production). The dev API route runs a live
 * query; the Worker has no such path, so it serves the `code-quality` KV key
 * scripts/sync-to-kv.ts writes. Before this route existed the page's request
 * missed every Worker route in production.
 */

import { describe, it, expect } from 'vitest';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { BYPASS_BINDINGS, BYPASS_HEADERS, BYPASS_ORG_ID, makeCtx, makeWorkerEnv } from './support/worker-env.js';

function makeEnv(kv: MemoryKv) {
  return makeWorkerEnv({ DASHBOARD: kv, ...BYPASS_BINDINGS, ORG_SCOPING_ENABLED: 'true' });
}

const CODE_QUALITY_PAYLOAD = {
  survivalByAgentWindow: [{ agentName: 'agent-auditor', window: '21d', cohort: 'scored', contentKind: 'code' }],
  versionRollout: [],
  hasData: true,
};

const BARE_PAYLOAD = { ...CODE_QUALITY_PAYLOAD, versionRollout: [{ agentName: 'pre-tenancy' }] };

describe('GET /api/code-quality', () => {
  it('serves the org-scoped code-quality key the sync writes', async () => {
    const kv = new MemoryKv({ [`org:${BYPASS_ORG_ID}:code-quality`]: CODE_QUALITY_PAYLOAD, 'code-quality': BARE_PAYLOAD });

    const res = await app.request('/api/code-quality', { headers: BYPASS_HEADERS }, makeEnv(kv), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(CODE_QUALITY_PAYLOAD);
  });

  it('answers the empty shape the page renders when the key is absent', async () => {
    const res = await app.request('/api/code-quality', { headers: BYPASS_HEADERS }, makeEnv(new MemoryKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ survivalByAgentWindow: [], versionRollout: [], hasData: false });
  });
});
