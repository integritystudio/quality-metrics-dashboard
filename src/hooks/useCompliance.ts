import { useQuery } from '@tanstack/react-query';
import type { SLAComplianceResult, HumanVerificationEvent, Period } from '../types.js';
import { API_BASE } from '../lib/api.js';

interface SLAResponse {
  results: SLAComplianceResult[];
  noSLAsConfigured: boolean;
}

interface VerificationResponse {
  count: number;
  verifications: HumanVerificationEvent[];
}

export function useComplianceSLA(period: Period) {
  return useQuery<SLAResponse>({
    queryKey: ['compliance-sla', period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/compliance/sla?period=${period}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 25_000,
    retry: 2,
  });
}

export function useComplianceVerifications(period: Period) {
  return useQuery<VerificationResponse>({
    queryKey: ['compliance-verifications', period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/compliance/verifications?period=${period}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 25_000,
    retry: 2,
  });
}
