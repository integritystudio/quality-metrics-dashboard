/**
 * Worker route tests: GET /api/calibration.
 */

import { describe, it, expect } from 'vitest';
import app from '../../worker/index.js';
import type { ErrorResponse } from './support/api-responses.js';
// The route serves the KV value byte-for-byte, so its body type is the
// producer's contract — imported from the one place it is declared.
import type { CalibrationResponse } from '../lib/validation/dashboard-schemas.js';

const HTTP_OK = 200;

// KV mock helper

function makeKV(store: Record<string, unknown> = {}): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const value = store[key];
      if (value === undefined) return null;
      if (type === 'json') return value;
      return JSON.stringify(value);
    },
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeCalibrationData(): CalibrationResponse {
  return {
    lastCalibrated: '2026-03-10T06:00:00.000Z',
    distributions: {
      relevance: { p10: 0.42, p25: 0.58, p50: 0.67, p75: 0.79, p90: 0.88 },
      faithfulness: { p10: 0.5, p25: 0.65, p50: 0.75, p75: 0.85, p90: 0.93 },
      coherence: { p10: 0.55, p25: 0.68, p50: 0.77, p75: 0.86, p90: 0.94 },
    },
    sampleCounts: {
      relevance: 312,
      faithfulness: 289,
      coherence: 301,
    },
  };
}

/** Request the route with a given KV store; the auth bypass keeps this route-focused. */
function requestCalibration(store: Record<string, unknown>) {
  return app.request(
    '/api/calibration',
    { headers: { Authorization: 'Bearer test-token' } },
    { DASHBOARD: makeKV(store), ALLOW_TEST_BYPASS: 'true' },
  );
}

// GET /api/calibration

describe('GET /api/calibration', () => {
  it('returns 200 with calibration state from KV key meta:calibration', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    expect(res.status).toBe(200);
  });

  it('returns distributions field in response body', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    const body = await res.json() as CalibrationResponse;
    expect(body).toHaveProperty('distributions');
  });

  it('returns lastCalibrated field in response body', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    const body = await res.json() as CalibrationResponse;
    expect(body).toHaveProperty('lastCalibrated');
  });

  it('returns distributions with per-metric percentile data', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    const body = await res.json() as CalibrationResponse;
    expect(body.distributions).toHaveProperty('relevance');
    const relDist = body.distributions['relevance'];
    expect(relDist).toHaveProperty('p10');
    expect(relDist).toHaveProperty('p25');
    expect(relDist).toHaveProperty('p50');
    expect(relDist).toHaveProperty('p75');
    expect(relDist).toHaveProperty('p90');
  });

  it('returns 404 with error field when no calibration data exists in KV', async () => {
    const kv = makeKV({});
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    expect(res.status).toBe(404);
    const body = await res.json() as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('returns exact lastCalibrated value from KV', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv, ALLOW_TEST_BYPASS: 'true' });
    const body = await res.json() as CalibrationResponse;
    expect(body.lastCalibrated).toBe('2026-03-10T06:00:00.000Z');
  });
});

/*
 * The KV read is a trust boundary: the value may have been written by an older
 * sync-to-kv than the worker serving it. These cover what the schema catches
 * there, and — just as importantly — what it deliberately lets through.
 */
describe('GET /api/calibration: malformed KV payload', () => {
  const HTTP_SERVER_ERROR = 500;

  it('returns 500 when a distribution is missing a percentile', async () => {
    const data = makeCalibrationData();
    // A p50-less distribution: the shape the pre-schema loose response type
    // accepted, and that empiricalCDF would have read as NaN downstream.
    const { p50: _p50, ...withoutP50 } = data.distributions['relevance']!;
    const res = await requestCalibration({
      'meta:calibration': { ...data, distributions: { relevance: withoutP50 } },
    });

    expect(res.status).toBe(HTTP_SERVER_ERROR);
    expect(await res.json() as ErrorResponse).toHaveProperty('error');
  });

  it('returns 500 when sampleCounts is absent', async () => {
    const { sampleCounts: _counts, ...withoutCounts } = makeCalibrationData();
    const res = await requestCalibration({ 'meta:calibration': withoutCounts });

    expect(res.status).toBe(HTTP_SERVER_ERROR);
  });

  it('returns 500 when a percentile is a string rather than a number', async () => {
    const data = makeCalibrationData();
    const res = await requestCalibration({
      'meta:calibration': {
        ...data,
        distributions: { relevance: { ...data.distributions['relevance'], p50: '0.67' } },
      },
    });

    expect(res.status).toBe(HTTP_SERVER_ERROR);
  });

  it('accepts percentiles outside 0–1, which unbounded metrics legitimately produce', async () => {
    // scoreValue is z.number().finite(), not a normalized 0–1 score — bounding
    // the schema would 500 a working route for any unbounded metric.
    const res = await requestCalibration({
      'meta:calibration': {
        lastCalibrated: '2026-03-10T06:00:00.000Z',
        distributions: { evaluation_latency: { p10: 12, p25: 40, p50: 118, p75: 402, p90: 1_500 } },
        sampleCounts: { evaluation_latency: 88 },
      },
    });

    expect(res.status).toBe(HTTP_OK);
    const body = await res.json() as CalibrationResponse;
    expect(body.distributions['evaluation_latency']?.p90).toBe(1_500);
  });

  it('strips unknown keys instead of rejecting, so a newer producer cannot 500 an older worker', async () => {
    const res = await requestCalibration({
      'meta:calibration': { ...makeCalibrationData(), futureField: { anything: true } },
    });

    expect(res.status).toBe(HTTP_OK);
    expect(await res.json()).not.toHaveProperty('futureField');
  });
});
