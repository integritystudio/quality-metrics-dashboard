/**
 * Harness for testing hooks built on `useApiQuery` against the REAL query stack.
 *
 * The hooks in `src/hooks/` are thin wrappers, so mocking `useApiQuery` leaves
 * nothing under test but the wrapper's own argument list — the assertions become
 * "it called the mock with these values", which passes just as happily when the
 * URL, the auth header, or the error mapping is wrong. Rendering against real
 * `useApiQuery` + real react-query + real `apiFetch` puts all of that back in
 * scope, and the request the hook actually issues becomes the assertion target.
 *
 * Exactly two boundaries stay substituted, both genuinely external:
 *  - `useAuth`, because the real provider drags in the Auth0 SDK and a browser
 *    redirect flow. Each test file declares its own `vi.mock` for it (mock
 *    factories are hoisted per-file and cannot be shared from here) resolving
 *    {@link TEST_ACCESS_TOKEN}.
 *  - `fetch`, via {@link stubFetch}.
 *
 * `OrgProvider` is deliberately absent: `useOrgOptional` returns null without
 * one, which is the pre-cutover (no active org) path — no `X-Org-Id` header,
 * `null` leading the query key.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { ReactNode } from 'react';

/** The token the per-file `useAuth` mock must resolve; assert it on the header. */
export const TEST_ACCESS_TOKEN = 'test-access-token';

/**
 * A provider wrapper backed by a fresh QueryClient, returned alongside the
 * client so tests can drive a refetch through `invalidateQueries`.
 *
 * Retries are off so an error assertion resolves on the first failed response
 * rather than after `defaultRetry`'s backoff, and `gcTime: 0` keeps one test's
 * cache from answering another's query.
 */
export function makeQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper: QueryWrapper, queryClient };
}

const HTTP_OK = 200;

/**
 * Replace `globalThis.fetch` with a stub returning one JSON response, and return
 * the spy so tests can assert on the URL and headers the hook actually sent.
 */
export function stubFetch(body: unknown, { status = HTTP_OK }: { status?: number } = {}) {
  const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** The `RequestInit.headers` of a recorded {@link stubFetch} call, as a plain record. */
export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}
