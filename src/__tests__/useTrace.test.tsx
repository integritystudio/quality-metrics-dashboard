import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTrace } from '../hooks/useTrace.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper, stubFetch } from './support/query-harness.js';
import { defined } from './support/defined.js';
import { HttpStatus } from '../lib/http-constants.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const TRACE_ID = 'trace/1';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTrace', () => {
  it('requests the trace by its encoded id', async () => {
    const fetchSpy = stubFetch({ traceId: TRACE_ID, spans: [], evaluations: [] });
    const { wrapper } = makeQueryWrapper();

    const { result } = renderHook(() => useTrace(TRACE_ID), { wrapper });
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });

    expect(defined(fetchSpy.mock.calls[0])[0]).toBe('/api/traces/trace%2F1');
  });

  it('shows a trace the Worker does not hold as an empty trace', async () => {
    stubFetch({ error: 'not found' }, { status: HttpStatus.NotFound });
    const { wrapper } = makeQueryWrapper();

    const { result } = renderHook(() => useTrace(TRACE_ID), { wrapper });
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });

    expect(result.current.data).toEqual({ traceId: TRACE_ID, spans: [], evaluations: [] });
  });

  it('reports any other failure with the response body', async () => {
    stubFetch('boom', { status: HttpStatus.InternalServerError });
    const { wrapper } = makeQueryWrapper();

    const { result } = renderHook(() => useTrace(TRACE_ID), { wrapper });
    await waitFor(() => { expect(result.current.isError).toBe(true); });

    expect(result.current.error?.message).toBe('API error: 500 – "boom"');
  });

  it('does not retry a 401', async () => {
    const fetchSpy = stubFetch({ error: 'unauthorized' }, { status: HttpStatus.Unauthorized });
    const { wrapper } = makeQueryWrapper();

    const { result } = renderHook(() => useTrace(TRACE_ID), { wrapper });
    await waitFor(() => { expect(result.current.isError).toBe(true); });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends no request without a trace id', () => {
    const fetchSpy = stubFetch({});
    const { wrapper } = makeQueryWrapper();

    renderHook(() => useTrace(undefined), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
