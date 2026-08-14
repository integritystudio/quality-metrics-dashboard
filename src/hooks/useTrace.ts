import { useQuery } from '@tanstack/react-query';
import type { EvaluationResult } from '../types.js';
import { API_BASE, STALE_TIME, QUERY_RETRY_COUNT } from '../lib/constants.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useOrgOptional } from '../contexts/OrgContext.js';
import { apiFetch } from '../lib/api-client.js';

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
  const { getAccessToken } = useAuth();
  // On-choke-point (P6): org id in the key and X-Org-Id on the wire, matching
  // useApiQuery — this hook fetches outside useApiQuery and must not drift.
  const org = useOrgOptional();
  const activeOrgId = org?.activeOrgId ?? null;
  return useQuery<TraceResponse>({
    queryKey: [activeOrgId, 'trace', traceId],
    queryFn: async () => {
      if (!traceId) throw new Error('traceId is required');
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        throw new Error('AUTH_REQUIRED');
      }
      const res = await apiFetch(`${API_BASE}/api/traces/${encodeURIComponent(traceId)}`, token, activeOrgId);
      if (!res.ok) {
        // Worker returns 404 with JSON body when trace not in KV — return empty data
        if (res.status === 404) return { traceId, spans: [], evaluations: [] };
        throw new Error(`API error: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!traceId,
    staleTime: STALE_TIME.DETAIL,
    retry: QUERY_RETRY_COUNT,
  });
}
