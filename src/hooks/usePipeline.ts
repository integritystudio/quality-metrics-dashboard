import { useQuery } from '@tanstack/react-query';
import type { Period, PipelineResult } from '../types.js';
import { API_BASE } from '../lib/api.js';

export type PipelineResponse = PipelineResult & { period: string };

export function usePipeline(period: Period) {
  return useQuery<PipelineResponse>({
    queryKey: ['pipeline', period],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      const res = await fetch(`${API_BASE}/api/pipeline?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 25_000,
    retry: 2,
  });
}
