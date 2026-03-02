import type { SLAComplianceResult, HumanVerificationEvent, Period } from '../types.js';
import { API_BASE } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

interface SLAResponse {
  results: SLAComplianceResult[];
  noSLAsConfigured: boolean;
}

interface VerificationResponse {
  count: number;
  verifications: HumanVerificationEvent[];
}

export function useComplianceSLA(period: Period) {
  return useApiQuery<SLAResponse>(
    ['compliance-sla', period],
    () => `${API_BASE}/api/compliance/sla?period=${period}`,
  );
}

export function useComplianceVerifications(period: Period) {
  return useApiQuery<VerificationResponse>(
    ['compliance-verifications', period],
    () => `${API_BASE}/api/compliance/verifications?period=${period}`,
  );
}
