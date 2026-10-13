import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { startRecordingServer, type RecordingServer } from './support/recording-server.js';
import { emptyAccountIndex, postEvaluationRecords } from '../post-evaluations.js';
import { EVALUATION_RESULT_EVENT } from '../eval-record.js';
import { evaluationId, MAX_BATCH_SIZE } from '../upload-evaluations.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_PREFIX } from '../../../src/lib/core/obtool-contract.js';
import { assertDefined, defined } from '../../src/__tests__/support/defined.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const KEY_REF = 'OBTOOL_API_KEY_TEST';
const API_KEY = 'test-api-key';
const HMAC_SECRET = 'test-hmac-secret';
const HTTP_BAD_REQUEST = 400;
/** The ingest worker's routes: keyed backfill, and the HMAC webhook. */
const KEYED_INGEST_PATH = '/v1/ingest/backfill?signal=evaluations';
const WEBHOOK_INGEST_PATH = '/v1/evaluations';
const HMAC_ALGORITHM = 'sha256';

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-09-28T11:00:00.000Z',
    name: EVALUATION_RESULT_EVENT,
    traceId: 'trace-1',
    attributes: {
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'tool_correctness',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 1,
      'integritystudio.evaluation.producer': 'rule',
    },
    ...extra,
  };
}

let ingest: RecordingServer;

beforeAll(async () => {
  ingest = await startRecordingServer();
});

afterAll(() => ingest.close());

beforeEach(() => {
  ingest.reset();
  vi.stubEnv('OBTOOL_INGEST_URL', ingest.url);
  vi.stubEnv(KEY_REF, API_KEY);
  vi.stubEnv('INJECT_HMAC_SECRET', HMAC_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const post = (records: unknown[], dryRun = false) =>
  postEvaluationRecords(records, { dryRun, accounts: emptyAccountIndex(), nowMs: NOW });

describe('postEvaluationRecords', () => {
  it('sends a stamped record to its account with that key, carrying its evaluationId', async () => {
    const r = record({ identityKeyRef: KEY_REF });

    const summary = await post([r]);

    expect(summary).toMatchObject({ sent: 1, byDestination: { [KEY_REF]: 1 }, routedBy: { stamp: 1 } });
    expect(ingest.requests).toHaveLength(1);
    const [sent] = ingest.requests;
    assertDefined(sent);
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe(KEYED_INGEST_PATH);
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(sent.body.trim())).toMatchObject({ evaluationId: evaluationId(r), traceId: 'trace-1' });
  });

  it('sends an unstamped record over the webhook, signed over the bytes received', async () => {
    const summary = await post([record()]);

    expect(summary.byDestination).toEqual({ webhook: 1 });
    expect(ingest.requests.map(r => r.path)).toEqual([WEBHOOK_INGEST_PATH]);
    const [sent] = ingest.requests;
    const expectedSignature = createHmac(HMAC_ALGORITHM, HMAC_SECRET).update(defined(sent).body).digest('hex');
    expect(defined(sent).headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]).toBe(`${WEBHOOK_SIGNATURE_PREFIX}${expectedSignature}`);
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
    expect(ingest.requests.map(r => r.body.trim().split('\n').length)).toEqual([MAX_BATCH_SIZE, 1]);
  });

  it('withholds a record stamped for an unmapped account', async () => {
    const summary = await post([record({ identityKeyRef: null })]);

    expect(summary).toMatchObject({ sent: 0, withheld: 1 });
    expect(ingest.requests).toHaveLength(0);
  });

  it('holds a record whose account key is not in the environment', async () => {
    const summary = await post([record({ identityKeyRef: 'OBTOOL_API_KEY_ABSENT' })]);

    expect(summary).toMatchObject({ sent: 0, heldForKey: { OBTOOL_API_KEY_ABSENT: 1 } });
    expect(ingest.requests).toHaveLength(0);
  });

  it('refuses webhook records without INJECT_HMAC_SECRET, sending nothing', async () => {
    vi.stubEnv('INJECT_HMAC_SECRET', '');

    const summary = await post([record()]);

    expect(summary.failure).toMatch(/INJECT_HMAC_SECRET/);
    expect(ingest.requests).toHaveLength(0);
  });

  it('stops at a rejected batch and reports it', async () => {
    ingest.respondWith(() => ({ status: HTTP_BAD_REQUEST, body: '{}' }));

    const summary = await post([record({ identityKeyRef: KEY_REF })]);

    expect(summary.sent).toBe(0);
    expect(summary.failure).toMatch(/^POST to OBTOOL_API_KEY_TEST failed: 400/);
  });

  it('counts but never sends on a dry run', async () => {
    const summary = await post([record(), record({ identityKeyRef: KEY_REF })], true);

    expect(summary.byDestination).toEqual({ webhook: 1, [KEY_REF]: 1 });
    expect(ingest.requests).toHaveLength(0);
  });
});
