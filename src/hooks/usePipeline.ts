import type { Period, PipelineResult } from '../types.js';
import { useApiQuery } from './useApiQuery.js';

export type PipelineResponse = PipelineResult & { period: string };

export function usePipeline(period: Period) {
  return useApiQuery<PipelineResponse>(
    ['pipeline', period],
    () => `/api/pipeline?${new URLSearchParams({ period })}`,
  );
}
