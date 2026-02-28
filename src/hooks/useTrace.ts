import { useQuery } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';
import { API_BASE } from '../lib/api.js';

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
      if (!res.ok) {
        // Worker returns 404 with JSON body when trace not in KV — return empty data
        if (res.status === 404) return { traceId: traceId!, spans: [], evaluations: [] };
        throw new Error(`API error: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!traceId,
    staleTime: 30_000,
    retry: 2,
  });
}
