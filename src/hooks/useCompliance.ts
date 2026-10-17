import type { UseQueryResult } from '@tanstack/react-query';
import type { SLAComplianceResult, HumanVerificationEvent, Period } from '../types.js';
import { useApiQuery } from './useApiQuery.js';

type SLAResponse = {
  results: SLAComplianceResult[];
  noSLAsConfigured: boolean;
}

type VerificationResponse = {
  count: number;
  verifications: HumanVerificationEvent[];
}

export function useComplianceSLA(period: Period): UseQueryResult<SLAResponse> {
  return useApiQuery<SLAResponse>(
    ['compliance-sla', period],
    () => `/api/compliance/sla?period=${period}`,
  );
}

export function useComplianceVerifications(period: Period): UseQueryResult<VerificationResponse> {
  return useApiQuery<VerificationResponse>(
    ['compliance-verifications', period],
    () => `/api/compliance/verifications?period=${period}`,
  );
}
