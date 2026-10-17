import type { UseQueryResult } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';
import { useApiQuery } from './useApiQuery.js';

export function useTraceEvaluations(traceId: string | undefined): UseQueryResult<EvaluationResult[]> {
  return useApiQuery<{ evaluations?: EvaluationResult[] }, EvaluationResult[]>(
    ['trace-evaluations', traceId],
    () => `/api/evaluations/trace/${encodeURIComponent(traceId ?? '')}`,
    {
      enabled: !!traceId,
      // Worker returns 200 with { evaluations: [] } when key not in KV (not yet synced)
      select: (raw) => raw.evaluations ?? [],
    },
  );
}
