/**
 * Tests for useQualityLive hook.
 *
 * Uses vi.useFakeTimers() + vi.advanceTimersByTimeAsync() to control
 * setInterval polling without triggering infinite timer loops.
 *
 * Pattern:
 *   - Flush initial async fetch: advanceTimersByTimeAsync(0) (flushes microtasks)
 *   - Trigger one poll interval: advanceTimersByTimeAsync(30_000)
 *   - Never use vi.runAllTimersAsync() — it loops infinitely on setInterval
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQualityLive } from '../hooks/useQualityLive.js';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

function makeErrorResponse(status = 500): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'Server error' }),
  } as Response;
}

/** Flush the initial fetchLive() promise without advancing the polling interval. */
async function flushInitialFetch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Advance by exactly one poll interval (30s) to trigger the setInterval callback. */
async function advanceOnePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useQualityLive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Ensure visibilityState is restored even if a test fails mid-mutation
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  });

  it('starts with isLoading=true, data=null, error=null', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useQualityLive());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets data and clears isLoading after successful fetch', async () => {
    const payload = makeQualityResponse();
    mockFetch.mockResolvedValue(makeOkResponse(payload));

    const { result } = renderHook(() => useQualityLive());
    await flushInitialFetch();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('sets error and clears isLoading on non-ok response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));

    const { result } = renderHook(() => useQualityLive());
    await flushInitialFetch();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('500');
    expect(result.current.data).toBeNull();
  });

  it('sets error on network failure (fetch throws)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useQualityLive());
    await flushInitialFetch();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Network error');
  });

  it('calls fetch once on mount with correct URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeQualityResponse()));

    renderHook(() => useQualityLive());
    await flushInitialFetch();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/quality/live')
    );
  });

  it('polls again after POLL_INTERVAL_MS (30s)', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeQualityResponse()));

    renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advanceOnePoll();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('polls a third time after two intervals', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeQualityResponse()));

    renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advanceOnePoll();
    await advanceOnePoll();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('stops polling after unmount', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeQualityResponse()));

    const { unmount } = renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    mockFetch.mockClear();

    await advanceOnePoll();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('updates data on subsequent successful polls', async () => {
    const firstPayload = makeQualityResponse({ sessionCount: 1 });
    const secondPayload = makeQualityResponse({ sessionCount: 5 });
    mockFetch
      .mockResolvedValueOnce(makeOkResponse(firstPayload))
      .mockResolvedValueOnce(makeOkResponse(secondPayload));

    const { result } = renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(result.current.data?.sessionCount).toBe(1);

    await advanceOnePoll();
    expect(result.current.data?.sessionCount).toBe(5);
  });

  it('clears error when subsequent poll succeeds after failure', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse(makeQualityResponse()));

    const { result } = renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(result.current.error).not.toBeNull();

    await advanceOnePoll();
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('pauses polling when document is hidden', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeQualityResponse()));

    renderHook(() => useQualityLive());
    await flushInitialFetch();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();

    // Simulate tab hidden → visibilitychange → stopPolling clears the interval
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await advanceOnePoll();

    // Interval was cleared — no new fetches
    expect(mockFetch).not.toHaveBeenCalled();

    // (visibilityState restored to 'visible' in afterEach)
  });
});
