import { useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '../lib/constants.js';

export function useApiQuery<T>(
  queryKey: readonly unknown[],
  buildUrl: () => string,
  options: {
    enabled?: boolean;
    staleTime?: number;
    retry?: number | ((failureCount: number, error: unknown) => boolean);
    refetchInterval?: number;
    retryDelay?: (attempt: number) => number;
    select?: (raw: unknown) => T;
  } = {},
) {
  const { enabled = true, staleTime = STALE_TIME.DEFAULT, retry = 2, refetchInterval, retryDelay, select } = options;
  return useQuery<T>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const raw: unknown = await res.json();
      return (select ? select(raw) : raw) as T;
    },
    enabled,
    staleTime,
    retry,
    ...(refetchInterval !== undefined && { refetchInterval }),
    ...(retryDelay !== undefined && { retryDelay }),
  });
}
