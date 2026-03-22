/**
 * Worker route tests: GET /api/calibration (FE-R1-UI).
 */
/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from 'vitest';
import app from '../../worker/index.js';

// ---------------------------------------------------------------------------
// KV mock helper
// ---------------------------------------------------------------------------

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

function makeCalibrationData() {
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

// ---------------------------------------------------------------------------
// GET /api/calibration
// ---------------------------------------------------------------------------

describe('GET /api/calibration', () => {
  it('returns 200 with calibration state from KV key meta:calibration', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    expect(res.status).toBe(200);
  });

  it('returns distributions field in response body', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('distributions');
  });

  it('returns lastCalibrated field in response body', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('lastCalibrated');
  });

  it('returns distributions with per-metric percentile data', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    const body = await res.json() as { distributions: Record<string, unknown> };
    expect(body.distributions).toHaveProperty('relevance');
    const relDist = body.distributions['relevance'] as Record<string, number>;
    expect(relDist).toHaveProperty('p10');
    expect(relDist).toHaveProperty('p25');
    expect(relDist).toHaveProperty('p50');
    expect(relDist).toHaveProperty('p75');
    expect(relDist).toHaveProperty('p90');
  });

  it('returns 404 with error field when no calibration data exists in KV', async () => {
    const kv = makeKV({});
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('returns exact lastCalibrated value from KV', async () => {
    const calibrationData = makeCalibrationData();
    const kv = makeKV({ 'meta:calibration': calibrationData });
    const res = await app.request('/api/calibration', { headers: { Authorization: 'Bearer test-token' } }, { DASHBOARD: kv });
    const body = await res.json() as { lastCalibrated: string };
    expect(body.lastCalibrated).toBe('2026-03-10T06:00:00.000Z');
  });
});
