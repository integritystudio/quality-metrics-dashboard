import type { UseQueryResult } from '@tanstack/react-query';
import type { Period, PipelineResult } from '../types.js';
import { useApiQuery } from './useApiQuery.js';

export type PipelineResponse = PipelineResult & { period: string };

export function usePipeline(period: Period): UseQueryResult<PipelineResponse> {
  return useApiQuery<PipelineResponse>(
    ['pipeline', period],
    () => `/api/pipeline?${new URLSearchParams({ period })}`,
  );
}
