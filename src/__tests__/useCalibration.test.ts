/**
 * Tests for useCalibration hook and getMetricCalibration helper.
 *
 * useCalibration is a thin wrapper around useApiQuery — mocked to test
 * the query key, URL, and options contract without a real network or
 * QueryClient setup.
 *
 * getMetricCalibration is a pure function tested directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCalibration, getMetricCalibration, type CalibrationResponse } from '../hooks/useCalibration.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';

// ─── Mock ──────────────────────────────────────────────────────────────────────

const mockUseApiQuery = vi.fn();
vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCalibrationResponse(overrides: Partial<CalibrationResponse> = {}): CalibrationResponse {
  return {
    distributions: {
      relevance: { p50: 0.7, p75: 0.82, p90: 0.91, p95: 0.95 },
      coherence: { p50: 0.65, p75: 0.78, p90: 0.88, p95: 0.93 },
    },
    sampleCounts: { relevance: 120, coherence: 95 },
    lastCalibrated: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

// ─── useCalibration ───────────────────────────────────────────────────────────

describe('useCalibration', () => {
  beforeEach(() => {
    mockUseApiQuery.mockReset();
    mockUseApiQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
  });

  it('passes query key ["calibration"] to useApiQuery', () => {
    renderHook(() => useCalibration());

    const [queryKey] = mockUseApiQuery.mock.calls[0];
    expect(queryKey).toEqual(['calibration']);
  });

  it('passes URL builder returning /api/calibration to useApiQuery', () => {
    renderHook(() => useCalibration());

    const [, buildUrl] = mockUseApiQuery.mock.calls[0];
    expect(buildUrl()).toBe(`${API_BASE}/api/calibration`);
  });

  it('passes staleTime=STALE_TIME.AGGREGATE and retry=1 to useApiQuery', () => {
    renderHook(() => useCalibration());

    const [, , options] = mockUseApiQuery.mock.calls[0];
    expect(options).toEqual({ staleTime: STALE_TIME.AGGREGATE, retry: 1 });
  });

  it('returns the useApiQuery result directly', () => {
    const payload = makeCalibrationResponse();
    mockUseApiQuery.mockReturnValue({ data: payload, isLoading: false, error: null });

    const { result } = renderHook(() => useCalibration());

    expect(result.current.data).toEqual(payload);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

// ─── getMetricCalibration ─────────────────────────────────────────────────────

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
      distributions: { relevance: { p50: 0.7, p75: 0.8, p90: 0.9, p95: 0.95 } },
      sampleCounts: {},
    });
    expect(getMetricCalibration(data, 'relevance')).toBeUndefined();
  });

  it('returns { distribution, sampleSize } for a present metric', () => {
    const data = makeCalibrationResponse();
    const result = getMetricCalibration(data, 'relevance');

    expect(result).toEqual({
      distribution: { p50: 0.7, p75: 0.82, p90: 0.91, p95: 0.95 },
      sampleSize: 120,
    });
  });

  it('returns sampleSize=0 when count is explicitly 0', () => {
    const data = makeCalibrationResponse({
      sampleCounts: { relevance: 0, coherence: 95 },
    });
    const result = getMetricCalibration(data, 'relevance');

    expect(result).toEqual({
      distribution: { p50: 0.7, p75: 0.82, p90: 0.91, p95: 0.95 },
      sampleSize: 0,
    });
  });

  it('returns calibration for a second metric independently', () => {
    const data = makeCalibrationResponse();
    const result = getMetricCalibration(data, 'coherence');

    expect(result).toEqual({
      distribution: { p50: 0.65, p75: 0.78, p90: 0.88, p95: 0.93 },
      sampleSize: 95,
    });
  });
});
