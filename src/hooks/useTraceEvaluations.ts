import { useQuery } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';

export function useTraceEvaluations(traceId: string | undefined) {
  return useQuery<EvaluationResult[]>({
    queryKey: ['trace-evaluations', traceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/evaluations/trace/${encodeURIComponent(traceId!)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      // Worker returns 200 with { evaluations: [] } when key not in KV (not yet synced)
      const data = await res.json();
      return (data.evaluations ?? []) as EvaluationResult[];
    },
    enabled: !!traceId,
    staleTime: STALE_TIME.DEFAULT,
    retry: 2,
  });
}
