import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The transport sends through the HTTP/1.1 fetch; route it to the stubbed
// global so these tests keep intercepting every request.
vi.mock('../../../src/lib/core/http1-fetch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/core/http1-fetch.js')>(),
  http1Fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

import { emptyAccountIndex, postEvaluationRecords } from '../post-evaluations.js';
import { evaluationId, MAX_BATCH_SIZE } from '../upload-evaluations.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const KEY_REF = 'OBTOOL_API_KEY_TEST';
const API_KEY = 'test-api-key';
const HMAC_SECRET = 'test-hmac-secret';

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-09-28T11:00:00.000Z',
    name: 'gen_ai.evaluation.result',
    traceId: 'trace-1',
    attributes: {
      'gen_ai.evaluation.name': 'tool_correctness',
      'gen_ai.evaluation.score.value': 1,
      'integritystudio.evaluation.producer': 'rule',
    },
    ...extra,
  };
}

interface Captured { url: string; headers: Record<string, string>; body: string }

let calls: Captured[];
let status: number;

beforeEach(() => {
  calls = [];
  status = 200;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return Promise.resolve(new Response('{}', { status }));
  }));
  vi.stubEnv('OBTOOL_INGEST_URL', 'https://ingest.test');
  vi.stubEnv(KEY_REF, API_KEY);
  vi.stubEnv('INJECT_HMAC_SECRET', HMAC_SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const post = (records: unknown[], dryRun = false) =>
  postEvaluationRecords(records, { dryRun, accounts: emptyAccountIndex(), nowMs: NOW });

describe('postEvaluationRecords', () => {
  it('sends a stamped record to its account with that key, carrying its evaluationId', async () => {
    const r = record({ identityKeyRef: KEY_REF });

    const summary = await post([r]);

    expect(summary).toMatchObject({ sent: 1, byDestination: { [KEY_REF]: 1 }, routedBy: { stamp: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ingest.test/v1/ingest/backfill?signal=evaluations');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(calls[0]!.body.trim())).toMatchObject({ evaluationId: evaluationId(r), traceId: 'trace-1' });
  });

  it('sends an unstamped record over the signed webhook', async () => {
    const summary = await post([record()]);

    expect(summary.byDestination).toEqual({ webhook: 1 });
    expect(calls[0]!.url).toBe('https://ingest.test/v1/evaluations');
    expect(calls[0]!.headers['x-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('does not age out old records, because the flush dates rows by evaluatedAtMs', async () => {
    const summary = await post([record({ timestamp: '2026-08-01T00:00:00.000Z' })]);

    expect(summary.sent).toBe(1);
    expect(summary.skipped).toEqual({});
  });

  it('splits a destination into batches of the webhook cap', async () => {
    const records = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => record({ identityKeyRef: KEY_REF, spanId: `s${i}` }));

    const summary = await post(records);

    expect(summary.sent).toBe(MAX_BATCH_SIZE + 1);
    expect(calls.map(c => c.body.trim().split('\n').length)).toEqual([MAX_BATCH_SIZE, 1]);
  });

  it('withholds a record stamped for an unmapped account', async () => {
    const summary = await post([record({ identityKeyRef: null })]);

    expect(summary).toMatchObject({ sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });

  it('holds a record whose account key is not in the environment', async () => {
    const summary = await post([record({ identityKeyRef: 'OBTOOL_API_KEY_ABSENT' })]);

    expect(summary).toMatchObject({ sent: 0, heldForKey: { OBTOOL_API_KEY_ABSENT: 1 } });
    expect(calls).toHaveLength(0);
  });

  it('refuses webhook records without INJECT_HMAC_SECRET, sending nothing', async () => {
    vi.stubEnv('INJECT_HMAC_SECRET', '');

    const summary = await post([record()]);

    expect(summary.failure).toMatch(/INJECT_HMAC_SECRET/);
    expect(calls).toHaveLength(0);
  });

  it('stops at a rejected batch and reports it', async () => {
    status = 400;

    const summary = await post([record({ identityKeyRef: KEY_REF })]);

    expect(summary.sent).toBe(0);
    expect(summary.failure).toMatch(/^POST to OBTOOL_API_KEY_TEST failed: 400/);
  });

  it('counts but never sends on a dry run', async () => {
    const summary = await post([record(), record({ identityKeyRef: KEY_REF })], true);

    expect(summary.byDestination).toEqual({ webhook: 1, [KEY_REF]: 1 });
    expect(calls).toHaveLength(0);
  });
});
