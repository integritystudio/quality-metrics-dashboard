/**
 * /api/agents in the Worker (production). It serves the `meta:agents:<period>`
 * key scripts/sync-to-kv.ts writes with the dev route's projection. It once
 * served a bare summary list from `meta:agents`, which the page's shape check
 * rejected on every load (DASHBOARD-AGGREGATE-DUAL-IMPL).
 */

import { describe, it, expect } from 'vitest';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { BYPASS_BINDINGS, BYPASS_HEADERS, BYPASS_ORG_ID, makeCtx, makeWorkerEnv } from './support/worker-env.js';

const OTHER_ORG = 'a0000000-0000-4000-8000-0000000000ff';

function makeEnv(kv: MemoryKv) {
  return makeWorkerEnv({ DASHBOARD: kv, ...BYPASS_BINDINGS, ORG_SCOPING_ENABLED: 'true' });
}

function agentsPayload(period: string, invocations: number) {
  return {
    period,
    startDate: '2026-10-01',
    endDate: '2026-10-08',
    agents: [{ agentName: 'general-purpose', invocations, errors: 0, errorRate: 0 }],
  };
}

const WEEK_PAYLOAD = agentsPayload('7d', 2);
const MONTH_PAYLOAD = agentsPayload('30d', 9);
const OTHER_ORG_WEEK_PAYLOAD = agentsPayload('7d', 5);
const BARE_WEEK_PAYLOAD = agentsPayload('7d', 7);

/** The session's org, another org, and the pre-tenancy bare key each hold a different week. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    [`org:${BYPASS_ORG_ID}:meta:agents:7d`]: WEEK_PAYLOAD,
    [`org:${BYPASS_ORG_ID}:meta:agents:30d`]: MONTH_PAYLOAD,
    [`org:${OTHER_ORG}:meta:agents:7d`]: OTHER_ORG_WEEK_PAYLOAD,
    'meta:agents:7d': BARE_WEEK_PAYLOAD,
  });
}

describe('GET /api/agents', () => {
  it('serves the org-scoped per-period key the sync writes', async () => {
    const res = await app.request('/api/agents?period=7d', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual(WEEK_PAYLOAD);
  });

  it('defaults to the month, as the dev route does', async () => {
    const res = await app.request('/api/agents', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(await res.json()).toEqual(MONTH_PAYLOAD);
  });

  it('answers the envelope the page requires when the key is absent', async () => {
    const res = await app.request('/api/agents?period=24h', { headers: BYPASS_HEADERS }, makeEnv(syncedKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ period: '24h', startDate: null, endDate: null, agents: [] });
  });

  it('rejects a period the sync never writes', async () => {
    const res = await app.request('/api/agents?period=99d', { headers: BYPASS_HEADERS }, makeEnv(new MemoryKv()), makeCtx());

    expect(res.status).toBe(HttpStatus.BadRequest);
  });
});
