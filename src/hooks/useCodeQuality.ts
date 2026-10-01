import type { CodeQualityResponse } from '../api/routes/code-quality.js';
import { STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export type { CodeQualityResponse };

export function useCodeQuality() {
  return useApiQuery<CodeQualityResponse>(
    ['code-quality'],
    () => `/api/code-quality`,
    { staleTime: STALE_TIME.AGGREGATE },
  );
}
