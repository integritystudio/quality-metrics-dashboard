/**
 * /api/quality/live in the Worker (production). It has no evaluation store of its
 * own: it lists the metrics in the org's `dashboard:24h` summary and takes each
 * one's newest row from the `metric:evaluations:<name>:24h` key sync-to-kv writes
 * newest first, with timestamps as the nanosecond strings toKVValue produces.
 */

import { describe, it, expect } from 'vitest';
import app from '../index.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { MemoryKv } from './support/memory-kv.js';
import { BYPASS_BINDINGS, BYPASS_HEADERS, BYPASS_ORG_ID, makeCtx, makeWorkerEnv } from './support/worker-env.js';

const NS_PER_MS = 1_000_000n;
const NEWEST = '2026-01-15T13:00:00.000Z';
const OLDER = '2026-01-15T12:00:00.000Z';

function nanos(iso: string): string {
  return String(BigInt(Date.parse(iso)) * NS_PER_MS);
}

function makeEnv(kv: MemoryKv) {
  return makeWorkerEnv({ DASHBOARD: kv, ...BYPASS_BINDINGS, ORG_SCOPING_ENABLED: 'true' });
}

function orgKey(key: string): string {
  return `org:${BYPASS_ORG_ID}:${key}`;
}

/** relevance has two rows, coherence one, and faithfulness is listed but has no rows key. */
function syncedKv(): MemoryKv {
  return new MemoryKv({
    [orgKey('dashboard:24h')]: { metrics: [{ name: 'relevance' }, { name: 'coherence' }, { name: 'faithfulness' }] },
    [orgKey('metric:evaluations:relevance:24h')]: {
      rows: [
        { score: 0.9, evaluatorType: 'llm', timestamp: nanos(NEWEST), traceId: 'trace-a' },
        { score: 0.4, evaluatorType: 'llm', timestamp: nanos(OLDER), traceId: 'trace-b' },
      ],
    },
    [orgKey('metric:evaluations:coherence:24h')]: {
      rows: [{ score: 0.7, timestamp: nanos(OLDER), traceId: 'trace-a' }],
    },
  });
}

async function getLive(kv: MemoryKv): Promise<Response> {
  return app.request('/api/quality/live', { headers: BYPASS_HEADERS }, makeEnv(kv), makeCtx());
}

describe('GET /api/quality/live', () => {
  it("serves each listed metric's newest row, sorted by name, with ISO timestamps", async () => {
    const res = await getLive(syncedKv());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({
      metrics: [
        { name: 'coherence', score: 0.7, evaluatorType: 'unknown', timestamp: OLDER },
        { name: 'relevance', score: 0.9, evaluatorType: 'llm', timestamp: NEWEST },
      ],
      sessionCount: 2,
      lastUpdated: NEWEST,
    });
  });

  it('serves no metrics when the org has no 24h summary synced', async () => {
    const res = await getLive(new MemoryKv());

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ metrics: [], sessionCount: 0 });
  });

  it("skips a metric whose newest row has no score, but counts that row's trace", async () => {
    const kv = new MemoryKv({
      [orgKey('dashboard:24h')]: { metrics: [{ name: 'relevance' }] },
      [orgKey('metric:evaluations:relevance:24h')]: {
        rows: [{ score: null, timestamp: nanos(NEWEST), traceId: 'trace-a' }],
      },
    });

    const res = await getLive(kv);

    expect(await res.json()).toMatchObject({ metrics: [], sessionCount: 1 });
  });
});
