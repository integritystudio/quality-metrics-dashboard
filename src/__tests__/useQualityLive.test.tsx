/**
 * Tests for useQualityLive.
 *
 * Run against the real `useApiQuery`/react-query/`apiFetch` stack — see
 * `support/query-harness.tsx` for why the previous `useApiQuery` mock was
 * removed. Only `useAuth` and `fetch` are substituted, so the URL, the bearer
 * header, the status→Error mapping, and the `undefined → null` coercion are all
 * production code here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useQualityLive } from '../hooks/useQualityLive.js';
import { API_BASE } from '../lib/constants.js';
import type { QualityLiveData } from '../types.js';
import {
  TEST_ACCESS_TOKEN,
  makeQueryWrapper,
  stubFetch,
  headersOf,
} from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;
/** defaultRetry allows 2 retries with react-query's 1s/2s backoff — 5s clears both. */
const RETRY_EXHAUSTION_TIMEOUT_MS = 5_000;

function makeQualityResponse(overrides: Partial<QualityLiveData> = {}): QualityLiveData {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useQualityLive', () => {
  it('requests /api/quality/live', async () => {
    const fetchSpy = stubFetch(makeQualityResponse());

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${API_BASE}/api/quality/live`);
  });

  it('sends the access token as a bearer header', async () => {
    const fetchSpy = stubFetch(makeQualityResponse());

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('omits X-Org-Id when no org is active', async () => {
    const fetchSpy = stubFetch(makeQualityResponse());

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(headersOf(fetchSpy.mock.calls[0]![1])).not.toHaveProperty('X-Org-Id');
  });

  it('returns isLoading=true, data=null, error=null before the response arrives', () => {
    stubFetch(makeQualityResponse());

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns the parsed body and clears isLoading after a successful fetch', async () => {
    const payload = makeQualityResponse();
    stubFetch(payload);

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a 401 as an Error naming the status, with data=null, without retrying', async () => {
    // useApiQuery's defaultRetry gives up immediately on auth errors — no token
    // means a retry can only fail the same way. The hook never overrides it.
    const fetchSpy = stubFetch({ error: 'unauthorized' }, { status: HTTP_UNAUTHORIZED });

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error?.message).toContain(`API error: ${HTTP_UNAUTHORIZED}`);
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 before surfacing the error', async () => {
    const fetchSpy = stubFetch({ error: 'boom' }, { status: HTTP_SERVER_ERROR });

    const { result } = renderHook(() => useQualityLive(), makeQueryWrapper());
    await waitFor(
      () => { expect(result.current.error).not.toBeNull(); },
      { timeout: RETRY_EXHAUSTION_TIMEOUT_MS },
    );

    expect(result.current.error?.message).toContain(`API error: ${HTTP_SERVER_ERROR}`);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('reflects a changed sessionCount when the query refetches', async () => {
    stubFetch(makeQualityResponse({ sessionCount: 1 }));
    const harness = makeQueryWrapper();

    const { result } = renderHook(() => useQualityLive(), harness);
    await waitFor(() => { expect(result.current.data?.sessionCount).toBe(1); });

    stubFetch(makeQualityResponse({ sessionCount: 5 }));
    await harness.queryClient.invalidateQueries();

    await waitFor(() => { expect(result.current.data?.sessionCount).toBe(5); });
  });
});
