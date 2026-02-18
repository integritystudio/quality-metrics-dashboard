import { useQuery } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

export function useTraceEvaluations(traceId: string | undefined) {
  return useQuery<EvaluationResult[]>({
    queryKey: ['trace-evaluations', traceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/evaluations/trace/${encodeURIComponent(traceId!)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      return data.evaluations;
    },
    enabled: !!traceId,
    staleTime: 25_000,
    retry: 2,
  });
}
