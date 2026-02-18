import { useQuery } from '@tanstack/react-query';
import type { EvalRow } from '../components/EvaluationTable.js';
import type { Period } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface EvaluationsResponse {
  rows: EvalRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function useMetricEvaluations(
  name: string | undefined,
  period: Period = '7d',
  { limit = 50, offset = 0, scoreLabel, sortBy = 'timestamp_desc', enabled = true }: {
    limit?: number;
    offset?: number;
    scoreLabel?: string;
    sortBy?: 'score_asc' | 'score_desc' | 'timestamp_desc';
    enabled?: boolean;
  } = {},
) {
  return useQuery<EvaluationsResponse>({
    queryKey: ['metric-evaluations', name, period, limit, offset, scoreLabel, sortBy],
    queryFn: async () => {
      const params = new URLSearchParams({ period, limit: String(limit), offset: String(offset), sortBy });
      if (scoreLabel) params.set('scoreLabel', scoreLabel);
      const res = await fetch(`${API_BASE}/api/metrics/${encodeURIComponent(name!)}/evaluations?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!name && enabled,
    staleTime: 25_000,
    retry: 2,
  });
}
