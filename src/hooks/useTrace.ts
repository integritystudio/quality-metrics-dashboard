import { useQuery } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface TraceSpanResponse {
  traceId: string;
  spanId: string;
  name: string;
  kind?: string;
  durationMs?: number;
  status?: { code: number; message?: string };
  attributes?: Record<string, unknown>;
}

interface TraceResponse {
  traceId: string;
  spans: TraceSpanResponse[];
  evaluations: EvaluationResult[];
}

export function useTrace(traceId: string | undefined) {
  return useQuery<TraceResponse>({
    queryKey: ['trace', traceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/traces/${encodeURIComponent(traceId!)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!traceId,
    staleTime: 30_000,
    retry: 2,
  });
}
