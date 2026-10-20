/**
 * The data-loader's shared cloud reads: identical in-flight reads share one
 * request, and with CLOUD_READ_CACHE_TTL_MS set, a repeat of a finished read
 * is served from the held result. The real CloudBackend runs against the
 * fixture server, so each assertion counts the requests that went over the wire.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createFixtureServer, evalToWire, spanToWire, type FixtureServer } from './support/fixture-server.js';
import { loadEvaluationsByMetric, loadEvaluationsForMetric, loadTracesBySessionId } from '../api/data-loader.js';
import { CLOUD_READ_CACHE_TTL_ENV, resetCloudReads } from '../api/cloud-reads.js';
import { SESSION_ATTRIBUTES } from '../lib/otel-attributes.js';

const EVALUATIONS_PATH = '/v1/evaluations';
const TRACES_PATH = '/v1/traces';
const START = '2026-10-01T00:00:00.000Z';
const LATER_SAME_DAY = '2026-10-01T09:30:00.000Z';
const END = '2026-10-02T00:00:00.000Z';
const OTHER_END = '2026-10-03T00:00:00.000Z';
const CACHE_TTL_MS = '60000';
const METRIC = 'relevance';
const SESSION_ID = 'sess-shared-1';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

beforeEach(() => {
  fixture.reset();
  resetCloudReads();
  vi.unstubAllEnvs();
  fixture.setEvals([evalToWire({ traceId: 'trace-1', evaluationName: METRIC }, 1)]);
  fixture.setTraces([spanToWire({ traceId: 'trace-1', spanId: 'span-1', name: 'hook:Stop', sessionId: SESSION_ID, attributes: { [SESSION_ATTRIBUTES.ID]: SESSION_ID } })]);
});

function requestsTo(path: string): number {
  return fixture.requests().filter((r) => r.path === path).length;
}

describe('shared cloud reads', () => {
  it('serves concurrent identical reads from one request', async () => {
    const [first, second] = await Promise.all([
      loadEvaluationsByMetric(START, END),
      loadEvaluationsByMetric(START, END),
    ]);

    expect(requestsTo(EVALUATIONS_PATH)).toBe(1);
    expect(second).toEqual(first);
    expect(first.get(METRIC)).toHaveLength(1);
  });

  it('re-reads a finished read when no cache TTL is configured', async () => {
    await loadEvaluationsByMetric(START, END);
    await loadEvaluationsByMetric(START, END);

    expect(requestsTo(EVALUATIONS_PATH)).toBe(2);
  });

  it('serves a repeat read from the held result within the TTL, whatever time of day the bounds carry', async () => {
    vi.stubEnv(CLOUD_READ_CACHE_TTL_ENV, CACHE_TTL_MS);

    await loadEvaluationsByMetric(START, END);
    await loadEvaluationsByMetric(START, END);
    await loadEvaluationsByMetric(LATER_SAME_DAY, END);

    expect(requestsTo(EVALUATIONS_PATH)).toBe(1);
  });

  it('keeps reads with different requests apart', async () => {
    vi.stubEnv(CLOUD_READ_CACHE_TTL_ENV, CACHE_TTL_MS);

    const DISTINCT_READS = 3;
    await loadEvaluationsByMetric(START, END);
    await loadEvaluationsByMetric(START, OTHER_END);
    await loadEvaluationsForMetric(METRIC, START, END);

    expect(requestsTo(EVALUATIONS_PATH)).toBe(DISTINCT_READS);
  });

  it('does not hold a failed read, in flight or cached', async () => {
    vi.stubEnv(CLOUD_READ_CACHE_TTL_ENV, CACHE_TTL_MS);
    fixture.failPath(EVALUATIONS_PATH);
    await expect(loadEvaluationsByMetric(START, END)).rejects.toThrow();

    fixture.reset();
    fixture.setEvals([evalToWire({ traceId: 'trace-1', evaluationName: METRIC }, 1)]);
    const recovered = await loadEvaluationsByMetric(START, END);

    expect(recovered.get(METRIC)).toHaveLength(1);
    expect(requestsTo(EVALUATIONS_PATH)).toBe(1);
  });

  it('shares trace reads the same way', async () => {
    const [first, second] = await Promise.all([
      loadTracesBySessionId(SESSION_ID, START, END),
      loadTracesBySessionId(SESSION_ID, START, END),
    ]);

    expect(requestsTo(TRACES_PATH)).toBe(1);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
  });
});
