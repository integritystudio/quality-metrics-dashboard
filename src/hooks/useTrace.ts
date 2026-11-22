import type { UseQueryResult } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';
import { STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

type TraceSpanResponse = {
  traceId: string;
  spanId: string;
  name: string;
  kind?: string;
  durationMs?: number;
  status?: { code: number; message?: string };
  attributes?: Record<string, unknown>;
}

type TraceResponse = {
  traceId: string;
  spans: TraceSpanResponse[];
  evaluations: EvaluationResult[];
}

export function useTrace(traceId: string | undefined): UseQueryResult<TraceResponse> {
  return useApiQuery<TraceResponse>(
    ['trace', traceId],
    () => `/api/traces/${encodeURIComponent(traceId ?? '')}`,
    {
      enabled: !!traceId,
      staleTime: STALE_TIME.DETAIL,
      // The Worker answers 404 when the trace is not in KV: show it as an empty trace.
      onNotFound: () => ({ traceId: traceId ?? '', spans: [], evaluations: [] }),
    },
  );
}
