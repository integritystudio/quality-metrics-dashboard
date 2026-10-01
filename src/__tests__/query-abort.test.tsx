/**
 * Tests that a query whose key moves on mid-flight aborts its request
 * (QUERYFN-DROPS-ABORT-SIGNAL).
 *
 * Runs the real `useApiQuery`/`useTrace` + react-query + `apiFetch` stack; only
 * `useAuth` and `fetch` are substituted. The stub holds the first key's request
 * open until its signal aborts, as a slow network would, and answers the second
 * at once. Before the fix neither hook passed react-query's `signal` on, so the
 * superseded request ran to completion and was parsed anyway.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useTrace } from '../hooks/useTrace.js';
import { API_BASE } from '../lib/constants.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper } from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const SLOW_ID = 'slow';
const FAST_ID = 'fast';
const HTTP_OK = 200;

/** Hold requests for {@link SLOW_ID} open until aborted; answer every other request at once. */
function stubSlowFirstFetch() {
  const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
    if (!url.endsWith(SLOW_ID)) {
      return Promise.resolve(new Response(
        JSON.stringify({ traceId: FAST_ID, spans: [], evaluations: [] }),
        { status: HTTP_OK, headers: { 'Content-Type': 'application/json' } },
      ));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const HOOKS = [
  { name: 'useApiQuery', use: (id: string) => useApiQuery<unknown>(['item', id], () => `${API_BASE}/api/item/${id}`) },
  { name: 'useTrace', use: (id: string) => useTrace(id) },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('query abort on key change', () => {
  it.each(HOOKS)('$name aborts the request for a key it has moved off', async ({ use }) => {
    const fetchSpy = stubSlowFirstFetch();
    const { wrapper } = makeQueryWrapper();
    const { result, rerender } = renderHook(({ id }) => use(id), {
      wrapper,
      initialProps: { id: SLOW_ID },
    });
    await waitFor(() => { expect(fetchSpy).toHaveBeenCalledTimes(1); });
    const firstSignal = fetchSpy.mock.calls[0]![1]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    rerender({ id: FAST_ID });
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });

    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
