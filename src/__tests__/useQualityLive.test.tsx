/**
 * Tests for useQualityLive hook.
 *
 * Mocks useApiQuery to test the thin wrapper behavior:
 * query key, URL builder, null coalescing, and return shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQualityLive } from '../hooks/useQualityLive.js';
import { POLL_INTERVAL_MS } from '../lib/constants.js';

// Mock useApiQuery

const mockUseApiQuery = vi.fn();
vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
}));

// Helpers

function makeQualityResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    metrics: [
      { name: 'relevance', score: 0.85, evaluatorType: 'seed', timestamp: '2026-01-15T12:00:00.000Z' },
      { name: 'coherence', score: 0.9, evaluatorType: 'seed', timestamp: '2026-01-15T12:00:00.000Z' },
    ],
    sessionCount: 3,
    lastUpdated: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

// Tests

describe('useQualityLive', () => {
  beforeEach(() => {
    mockUseApiQuery.mockReset();
  });

  it('passes correct query key, URL builder, and refetchInterval to useApiQuery', () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    renderHook(() => useQualityLive());

    expect(mockUseApiQuery).toHaveBeenCalledTimes(1);
    const [queryKey, buildUrl, options] = mockUseApiQuery.mock.calls[0];
    expect(queryKey).toEqual(['quality', 'live']);
    expect(buildUrl()).toContain('/api/quality/live');
    expect(options).toEqual({ refetchInterval: POLL_INTERVAL_MS });
  });

  it('returns isLoading=true, data=null, error=null while loading', () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    const { result } = renderHook(() => useQualityLive());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns data and clears isLoading after successful fetch', () => {
    const payload = makeQualityResponse();
    mockUseApiQuery.mockReturnValue({ data: payload, isLoading: false, error: null });

    const { result } = renderHook(() => useQualityLive());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('coerces undefined data to null', () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });

    const { result } = renderHook(() => useQualityLive());

    expect(result.current.data).toBeNull();
  });

  it('returns error from useApiQuery', () => {
    const err = new Error('API error: 500');
    mockUseApiQuery.mockReturnValue({ data: undefined, isLoading: false, error: err });

    const { result } = renderHook(() => useQualityLive());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(err);
    expect(result.current.data).toBeNull();
  });

  it('returns updated data when useApiQuery provides new results', () => {
    const first = makeQualityResponse({ sessionCount: 1 });
    mockUseApiQuery.mockReturnValue({ data: first, isLoading: false, error: null });

    const { result, rerender } = renderHook(() => useQualityLive());
    expect(result.current.data?.sessionCount).toBe(1);

    const second = makeQualityResponse({ sessionCount: 5 });
    mockUseApiQuery.mockReturnValue({ data: second, isLoading: false, error: null });
    rerender();

    expect(result.current.data?.sessionCount).toBe(5);
  });
});
