import type { UseQueryResult } from '@tanstack/react-query';
import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
// The shapes the API computes, imported rather than restated so the two cannot drift
// (type-only, so none of src/api's Node-only code reaches the bundle).
import type { SessionDetail } from '../api/session-detail.js';
import { STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

/**
 * Deliberately NOT the API's `DataSources`: that type describes what the writer emits
 * (`truncated` present only when true), while this one describes what a reader may
 * receive. A payload can arrive with `truncated: false` from a producer that writes the
 * flag either way, which the writer-side union rejects — see the `is false` case in
 * SessionDetailPage.test.tsx. Keep the two separate.
 */
export type DataSources = {
  traces: {
    count: number;
    traceIds: number;
    /** As `evaluations.truncated`, for spans and every field derived from them. */
    truncated?: boolean;
  };
  logs: { count: number };
  evaluations: {
    count: number;
    /**
     * True when the session has more evaluations than `count`, so `evaluations`
     * and everything derived from it is a partial read. Optional because not
     * every producer of this payload sets it: the local API route always does,
     * while a `session:` key read from KV may predate the flag or come from a
     * writer that never sets it. Absent reads as not truncated.
     */
    truncated?: boolean;
  };
  total: number;
}

export type SessionDetailResponse = Omit<SessionDetail<MultiAgentEvaluation, EvaluationResult>, 'dataSources'> & {
  dataSources: DataSources;
}

export function useSessionDetail(sessionId: string | undefined): UseQueryResult<SessionDetailResponse> {
  return useApiQuery<SessionDetailResponse>(
    ['session-detail', sessionId],
    () => `/api/sessions/${encodeURIComponent(sessionId ?? '')}`,
    {
      enabled: !!sessionId,
      staleTime: STALE_TIME.DETAIL,
      retry: (failureCount, error) =>
        error instanceof Error && error.message.startsWith('API error: 404')
          ? false
          : failureCount < 2,
    },
  );
}
