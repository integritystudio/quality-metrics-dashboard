import { useQuery } from '@tanstack/react-query';
import type { EvalRow } from '../components/EvaluationTable.js';
import type { Period } from '../types.js';
import { API_BASE, STALE_TIME, DEFAULT_PAGE_LIMIT, DEFAULT_PERIOD, DEFAULT_SORT_BY, type SortBy } from '../lib/constants.js';

interface EvaluationsResponse {
  rows: EvalRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function useMetricEvaluations(
  name: string | undefined,
  period: Period = DEFAULT_PERIOD,
  { limit = DEFAULT_PAGE_LIMIT, offset = 0, scoreLabel, sortBy = DEFAULT_SORT_BY, enabled = true }: {
    limit?: number;
    offset?: number;
    scoreLabel?: string;
    sortBy?: SortBy;
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
    staleTime: STALE_TIME.DEFAULT,
    retry: 2,
  });
}
