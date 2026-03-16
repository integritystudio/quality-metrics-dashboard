import { API_BASE, POLL_INTERVAL_MS } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';
import type { QualityLiveData } from '../types.js';

export interface UseQualityLiveResult {
  data: QualityLiveData | null;
  isLoading: boolean;
  error: Error | null;
}

export function useQualityLive(): UseQualityLiveResult {
  const { data, isLoading, error } = useApiQuery<QualityLiveData>(
    ['quality', 'live'],
    () => `${API_BASE}/api/quality/live`,
    { refetchInterval: POLL_INTERVAL_MS },
  );
  return { data: data ?? null, isLoading, error };
}
