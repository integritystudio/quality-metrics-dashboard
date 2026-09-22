/**
 * Tests for `useApiQuery`'s `onNotFound` option — the 404-with-ERR_NO_DATA
 * branch that renders the no-data state instead of an error.
 *
 * Exercises the real `useApiQuery` + react-query + `apiFetch` stack against a
 * stubbed `fetch` (same pattern as useCalibration.test.tsx). Auth is mocked to
 * the shared `TEST_ACCESS_TOKEN`; the `OrgProvider` is deliberately absent so
 * `useOrgOptional` returns null (pre-cutover / no active org path).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { API_BASE, WORKER_ERR_NO_DATA } from '../lib/constants.js';
import {
  makeQueryWrapper,
  stubFetch,
} from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve('test-access-token') }),
}));

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/**
 * A tiny typed hook that exercises `onNotFound` in isolation.
 *
 * `retry: 0` is required: without it `useApiQuery` applies its own
 * `defaultRetry` function which overrides `QueryClient.defaultOptions` and
 * causes error assertions to time out waiting for retries to exhaust.
 */
function useTestQuery(
  onNotFound?: (body: unknown) => { status: string } | undefined,
) {
  return useApiQuery<{ status: string }>(
    ['test'],
    () => `${API_BASE}/api/test`,
    { onNotFound, retry: 0 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useApiQuery onNotFound', () => {
  it('resolves as data when onNotFound matches a 404 body', async () => {
    stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HTTP_NOT_FOUND });

    const { result } = renderHook(
      () => useTestQuery((body) => {
        const parsed = body as { error?: unknown } | null;
        if (parsed?.error === WORKER_ERR_NO_DATA) return { status: 'no_data' };
        return undefined;
      }),
      makeQueryWrapper(),
    );

    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ status: 'no_data' });
  });

  it('falls through to an error when onNotFound returns undefined for a 404', async () => {
    stubFetch({ error: 'some other reason' }, { status: HTTP_NOT_FOUND });

    const { result } = renderHook(
      () => useTestQuery(() => undefined),
      makeQueryWrapper(),
    );

    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error?.message).toContain(`API error: ${HTTP_NOT_FOUND}`);
    expect(result.current.data).toBeUndefined();
  });

  it('surfaces a 404 as an error when no onNotFound is provided', async () => {
    stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HTTP_NOT_FOUND });

    const { result } = renderHook(
      () => useTestQuery(undefined),
      makeQueryWrapper(),
    );

    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error?.message).toContain(`API error: ${HTTP_NOT_FOUND}`);
    expect(result.current.data).toBeUndefined();
  });

  it('does not invoke onNotFound for non-404 errors', async () => {
    stubFetch({ error: 'crash' }, { status: HTTP_INTERNAL_SERVER_ERROR });
    const onNotFound = vi.fn(() => undefined as { status: string } | undefined);

    const { result } = renderHook(
      () => useTestQuery(onNotFound),
      makeQueryWrapper(),
    );

    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(onNotFound).not.toHaveBeenCalled();
    expect(result.current.error?.message).toContain(`API error: ${HTTP_INTERNAL_SERVER_ERROR}`);
  });

  it('passes parsed JSON to onNotFound when the body is valid JSON', async () => {
    const body = { error: WORKER_ERR_NO_DATA, extra: 'field' };
    stubFetch(body, { status: HTTP_NOT_FOUND });
    let captured: unknown;
    const onNotFound = (b: unknown): { status: string } | undefined => {
      captured = b;
      return undefined;
    };

    const { result } = renderHook(
      () => useTestQuery(onNotFound),
      makeQueryWrapper(),
    );

    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(captured).toEqual(body);
  });
});
