import { useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '../lib/constants.js';
import { useAuth } from '../contexts/AuthContext.js';

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
 * **Auth**: throws `AUTH_REQUIRED` immediately (no HTTP request) when no token
 * is available. Token refresh is handled automatically by the Auth0 SDK.
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
  const { getAccessToken } = useAuth();
  return useQuery<TRaw, Error, T>({
    queryKey,
    queryFn: async () => {
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        throw new Error('AUTH_REQUIRED');
      }
      const url = buildUrl();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
