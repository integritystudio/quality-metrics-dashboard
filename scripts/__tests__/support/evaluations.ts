import type { EvaluationResult } from '../../../../src/backends/index.js';
import { NANOSECONDS_PER_MILLISECOND_BIGINT } from '../../../../src/lib/core/units.js';

/** The metric evaluation fixtures score; a registered quality metric, so it reaches every aggregate. */
export const FIXTURE_METRIC = 'relevance';

/** An ISO instant as the nanosecond bigint the backend carries in `timestamp`. */
export function isoToNs(iso: string): bigint {
  return BigInt(Date.parse(iso)) * NANOSECONDS_PER_MILLISECOND_BIGINT;
}

/** An evaluation at `iso`; `label` goes in `explanation`, which the per-period evaluation rows carry through. */
export function evaluation(label: string, iso: string, overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return { evaluationName: FIXTURE_METRIC, scoreValue: 0.5, timestamp: isoToNs(iso), explanation: label, ...overrides };
}
