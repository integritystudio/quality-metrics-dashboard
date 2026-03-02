import type { Period, PipelineResult } from '../types.js';
import { API_BASE } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export type PipelineResponse = PipelineResult & { period: string };

export function usePipeline(period: Period) {
  return useApiQuery<PipelineResponse>(
    ['pipeline', period],
    () => `${API_BASE}/api/pipeline?${new URLSearchParams({ period })}`,
  );
}
