/**
 * Per-metric evaluation row projection (`GET /api/metrics/:name/evaluations`),
 * shared by the API route (`routes/metrics.ts`) and the KV sync
 * (`scripts/sync-to-kv.ts`). The sync's rows were missing `evaluatorKind` and
 * `cohort` in the route; the route's rows were missing them from the sync
 * (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers sort and slice; this module only projects one evaluation record.
 */

import { resolveScoreLabelWithSource } from '../parent/qfe-label-ordinals.js';
import type { EvaluationResult } from '../../types.js';

export interface EvaluationRow {
  score: number;
  explanation: string | undefined;
  traceId: string | undefined;
  timestamp: bigint | string | number;
  evaluator: string | undefined;
  label: string | undefined;
  labelDerived: boolean;
  evaluatorType: string | undefined;
  evaluatorKind: string | undefined;
  cohort: string | undefined;
  spanId: string | undefined;
  sessionId: string | undefined;
  agentName: string | undefined;
  trajectoryLength: number | undefined;
  stepScores: unknown;
  toolVerifications: unknown;
}

/** Project one `EvaluationResult` into the row shape the evaluations table reads. */
export function projectEvaluationRow(e: EvaluationResult): EvaluationRow {
  const { label, derived } = resolveScoreLabelWithSource(e);
  return {
    score: e.scoreValue ?? 0,
    explanation: e.explanation,
    traceId: e.traceId,
    timestamp: e.timestamp,
    evaluator: e.evaluator,
    label,
    labelDerived: derived,
    evaluatorType: e.evaluatorType,
    evaluatorKind: e.evaluatorKind,
    cohort: e.cohort,
    spanId: e.spanId,
    sessionId: e.sessionId,
    agentName: e.agentName,
    trajectoryLength: e.trajectoryLength,
    stepScores: e.stepScores,
    toolVerifications: e.toolVerifications,
  };
}
