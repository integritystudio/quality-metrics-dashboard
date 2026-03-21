import { useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '../lib/constants.js';
import { getSession, refreshSession } from '../lib/supabase.js';

// Never retry auth errors — no token means the request will always fail.
// Callers can override with their own retry function via options.retry.
function defaultRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof Error && (
    error.message === 'AUTH_REQUIRED' ||
    error.message.startsWith('API error: 401')
  )) return false;
  return failureCount < 2;
}

/**
 * Thin wrapper around `useQuery` with shared defaults.
 *
 * **`buildUrl` / `enabled` contract**: `buildUrl` is called only when `enabled`
 * is `true` (React Query skips the `queryFn` otherwise). Callers that guard on
 * a nullable value — e.g. `buildUrl: () => \`/api/traces/${traceId!}\`` — must
 * also pass `enabled: !!traceId` to prevent `buildUrl` from executing before
 * the value is available.
 *
 * **Auth**: throws `AUTH_REQUIRED` immediately (no HTTP request) when no session
 * is available, preventing wasteful retries against 401-protected routes. On a
 * 401 response, attempts a single token refresh and retries the request once.
 */
export function useApiQuery<TRaw, T = TRaw>(
  queryKey: readonly unknown[],
  buildUrl: () => string,
  options: {
    enabled?: boolean;
    staleTime?: number;
    retry?: number | ((failureCount: number, error: unknown) => boolean);
    refetchInterval?: number;
    retryDelay?: (attempt: number) => number;
    select?: (raw: TRaw) => T;
  } = {},
) {
  const { enabled = true, staleTime = STALE_TIME.DEFAULT, retry, refetchInterval, retryDelay, select } = options;
  return useQuery<TRaw, Error, T>({
    queryKey,
    queryFn: async () => {
      let session = getSession();
      if (!session) {
        session = await refreshSession();
        if (!session) throw new Error('AUTH_REQUIRED');
      }
      const url = buildUrl();
      const doFetch = (token: string) =>
        fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      let res = await doFetch(session.access_token);
      if (res.status === 401) {
        // Token may have expired mid-flight — attempt a single refresh and retry
        const refreshed = await refreshSession();
        if (!refreshed) {
          const body = await res.text().catch(() => '');
          throw new Error(body ? `API error: 401 – ${body}` : 'API error: 401');
        }
        res = await doFetch(refreshed.access_token);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body ? `API error: ${res.status} – ${body}` : `API error: ${res.status}`);
      }
      return res.json() as Promise<TRaw>;
    },
    select,
    enabled,
    staleTime,
    retry: retry !== undefined ? retry : defaultRetry,
    ...(refetchInterval !== undefined && { refetchInterval }),
    ...(retryDelay !== undefined && { retryDelay }),
  });
}
