/** Keys for the already-judged set, and the records that count as this script's. */

import { LLM_EVALUATOR_TYPE, type EvaluationCohort } from '../../src/lib/validation/dashboard-schemas.js';
import { CANARY_COHORT } from './evaluation-constants.js';
import { EVALUATION_ATTRS, LEGACY_EVALUATOR_TYPE_ATTR, NORMAL_COHORT, SEED_COHORT, BACKFILL_COHORT, SEED_EVALUATOR_TYPE, TRACE_BACKFILL_EVALUATOR_TYPE } from './eval-record.js';
import { HAIKU_MODEL } from './judge-criteria.js';

export const TIMESTAMP_TURN_KEY_LEN = 19; // ISO 8601 up to seconds: "2026-02-09T01:11:15"

/** A turn's dedup key: its ISO timestamp (or epoch ms) cut to the second. */
export function turnKeyOf(at: string | number): string {
  const iso = typeof at === 'number' ? new Date(at).toISOString() : at;
  return iso.slice(0, TIMESTAMP_TURN_KEY_LEN);
}

/**
 * The dedup set holds two keys per judged criterion: the plain
 * `${sessionId}:${evaluationName}:${turnKey}` for every row, and the same key
 * suffixed `@<judgeModel>` for every LLM row (JUDGE-MODEL-METADATA-ONLY,
 * 2026-10-01). The LLM paths check the suffixed key, so a turn Haiku judged is
 * still judged by a different model; the seed path checks the plain key, so it
 * never seeds a turn any judge scored. Rows written before the model was
 * recorded are all Haiku 4.5, so a judge row with no model and no synthetic
 * cohort counts as one.
 */
export function turnScoreKey(sessionId: string, evaluationName: string, turnKey: string): string {
  return `${sessionId}:${evaluationName}:${turnKey}`;
}

export function judgedByKey(sessionId: string, evaluationName: string, turnKey: string, judgeModel: string): string {
  return `${turnScoreKey(sessionId, evaluationName, turnKey)}@${judgeModel}`;
}

export const SYNTHETIC_COHORTS: ReadonlySet<string> = new Set<EvaluationCohort>([SEED_COHORT, CANARY_COHORT]);

/** Add both keys for one stored judge row. No model on a non-synthetic row means a pre-2026-09-30 Haiku row. */
export function addJudgedKeys(
  keys: Set<string>,
  row: { sessionId: string; evaluationName: string; turnKey: string; judgeModel?: string | undefined; cohort?: string | undefined },
): void {
  keys.add(turnScoreKey(row.sessionId, row.evaluationName, row.turnKey));
  const synthetic = row.cohort !== undefined && SYNTHETIC_COHORTS.has(row.cohort);
  const judgeModel = row.judgeModel ?? (synthetic ? undefined : HAIKU_MODEL);
  if (judgeModel) keys.add(judgedByKey(row.sessionId, row.evaluationName, row.turnKey, judgeModel));
}

/**
 * Whether a record on disk is one this script produced, and therefore counts
 * toward dedup.
 *
 * **Dual-read, deliberately.** Records written before OBP16 carry
 * the overloaded `gen_ai.evaluation.evaluator.type`, holding a kind for judged
 * rows and a cohort for seeded ones; records written after it carry
 * `integritystudio.evaluation.cohort` instead. Neither set is being
 * backfilled, so a reader that knows only one shape either re-judges every
 * historical turn or re-seeds every new one — both duplicate silently.
 */
export function isThisScriptsRecord(attrs: Record<string, unknown>): boolean {
  const cohort = attrs[EVALUATION_ATTRS.COHORT];
  if (typeof cohort === 'string') {
    // Post-OBP16: judged rows are the NORMAL cohort, the rest are ours by cohort.
    return cohort === NORMAL_COHORT || cohort === SEED_COHORT || cohort === BACKFILL_COHORT;
  }
  const legacy = attrs[LEGACY_EVALUATOR_TYPE_ATTR];
  return legacy === LLM_EVALUATOR_TYPE
    || legacy === SEED_EVALUATOR_TYPE
    || legacy === TRACE_BACKFILL_EVALUATOR_TYPE;
}
