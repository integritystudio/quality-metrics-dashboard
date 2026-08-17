/**
 * Tests for useCalibration and getMetricCalibration.
 *
 * useCalibration runs against the real `useApiQuery`/react-query/`apiFetch`
 * stack — see `support/query-harness.tsx` for why the previous `useApiQuery`
 * mock was removed. `getMetricCalibration` is pure and tested directly.
 *
 * The fixture is typed as `CalibrationResponse`, the same declaration
 * `buildCalibrationEntry` writes to KV, so a payload this test accepts is one
 * the sync script can actually produce.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCalibration, getMetricCalibration } from '../hooks/useCalibration.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';
import type { CalibrationResponse } from '../lib/validation/dashboard-schemas.js';
import {
  TEST_ACCESS_TOKEN,
  makeQueryWrapper,
  stubFetch,
  headersOf,
} from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const HTTP_NOT_FOUND = 404;
/** The hook's retry:1 costs react-query's 1s first backoff — 3s clears it. */
const RETRY_EXHAUSTION_TIMEOUT_MS = 3_000;

function makeCalibrationResponse(overrides: Partial<CalibrationResponse> = {}): CalibrationResponse {
  return {
    distributions: {
      relevance: { p10: 0.5, p25: 0.62, p50: 0.7, p75: 0.82, p90: 0.91 },
      coherence: { p10: 0.45, p25: 0.57, p50: 0.65, p75: 0.78, p90: 0.88 },
    },
    sampleCounts: { relevance: 120, coherence: 95 },
    lastCalibrated: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCalibration', () => {
  it('requests /api/calibration with a bearer header', async () => {
    const fetchSpy = stubFetch(makeCalibrationResponse());

    const { result } = renderHook(() => useCalibration(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${API_BASE}/api/calibration`);
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('returns the parsed calibration payload', async () => {
    const payload = makeCalibrationResponse();
    stubFetch(payload);

    const { result } = renderHook(() => useCalibration(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('serves the cached payload within STALE_TIME.AGGREGATE instead of refetching', async () => {
    const fetchSpy = stubFetch(makeCalibrationResponse());
    const harness = makeQueryWrapper();

    const first = renderHook(() => useCalibration(), harness);
    await waitFor(() => { expect(first.result.current.isLoading).toBe(false); });

    // A second consumer of the same query key mounts; the entry is still fresh.
    const second = renderHook(() => useCalibration(), harness);
    await waitFor(() => { expect(second.result.current.data).toBeDefined(); });

    expect(STALE_TIME.AGGREGATE).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 (no calibration synced yet) as an error, leaving data undefined', async () => {
    const fetchSpy = stubFetch({ error: 'ERR_NO_DATA' }, { status: HTTP_NOT_FOUND });

    const { result } = renderHook(() => useCalibration(), makeQueryWrapper());
    await waitFor(
      () => { expect(result.current.error).not.toBeNull(); },
      { timeout: RETRY_EXHAUSTION_TIMEOUT_MS },
    );

    expect(result.current.error?.message).toContain(`API error: ${HTTP_NOT_FOUND}`);
    expect(result.current.data).toBeUndefined();
    // The hook passes retry:1 — the initial attempt plus exactly one retry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('getMetricCalibration', () => {
  it('returns undefined when data is undefined', () => {
    expect(getMetricCalibration(undefined, 'relevance')).toBeUndefined();
  });

  it('returns undefined when the metric is not in distributions', () => {
    const data = makeCalibrationResponse();
    expect(getMetricCalibration(data, 'hallucination')).toBeUndefined();
  });

  it('returns undefined when distribution exists but sampleCount is missing', () => {
    const data = makeCalibrationResponse({
      distributions: { relevance: { p10: 0.5, p25: 0.62, p50: 0.7, p75: 0.8, p90: 0.9 } },
      sampleCounts: {},
    });
    expect(getMetricCalibration(data, 'relevance')).toBeUndefined();
  });

  it('returns { distribution, sampleSize } for a present metric', () => {
    const data = makeCalibrationResponse();
    const result = getMetricCalibration(data, 'relevance');

    expect(result).toEqual({
      distribution: { p10: 0.5, p25: 0.62, p50: 0.7, p75: 0.82, p90: 0.91 },
      sampleSize: 120,
    });
  });

  it('returns sampleSize=0 when count is explicitly 0', () => {
    const data = makeCalibrationResponse({
      sampleCounts: { relevance: 0, coherence: 95 },
    });
    const result = getMetricCalibration(data, 'relevance');

    expect(result).toEqual({
      distribution: { p10: 0.5, p25: 0.62, p50: 0.7, p75: 0.82, p90: 0.91 },
      sampleSize: 0,
    });
  });

  it('returns calibration for a second metric independently', () => {
    const data = makeCalibrationResponse();
    const result = getMetricCalibration(data, 'coherence');

    expect(result).toEqual({
      distribution: { p10: 0.45, p25: 0.57, p50: 0.65, p75: 0.78, p90: 0.88 },
      sampleSize: 95,
    });
  });
});
