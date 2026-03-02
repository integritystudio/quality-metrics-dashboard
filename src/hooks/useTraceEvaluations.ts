import type { EvaluationResult } from '../types.js';
import { API_BASE } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export function useTraceEvaluations(traceId: string | undefined) {
  return useApiQuery<EvaluationResult[]>(
    ['trace-evaluations', traceId],
    () => `${API_BASE}/api/evaluations/trace/${encodeURIComponent(traceId!)}`,
    {
      enabled: !!traceId,
      // Worker returns 200 with { evaluations: [] } when key not in KV (not yet synced)
      select: (raw) => ((raw as { evaluations?: EvaluationResult[] }).evaluations ?? []),
    },
  );
}
