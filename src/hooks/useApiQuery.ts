import { useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '../lib/constants.js';

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
  const { enabled = true, staleTime = STALE_TIME.DEFAULT, retry = 2, refetchInterval, retryDelay, select } = options;
  return useQuery<TRaw, Error, T>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<TRaw>;
    },
    select,
    enabled,
    staleTime,
    retry,
    ...(refetchInterval !== undefined && { refetchInterval }),
    ...(retryDelay !== undefined && { retryDelay }),
  });
}
