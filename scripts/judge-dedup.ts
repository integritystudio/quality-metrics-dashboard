/** Keys for the already-judged set. */

import { NORMAL_COHORT, BACKFILL_COHORT } from './eval-record.js';
import { HAIKU_MODEL } from './judge-criteria.js';

export const TIMESTAMP_TURN_KEY_LEN = 19; // ISO 8601 up to seconds: "2026-02-09T01:11:15"

/** A turn's dedup key: its ISO timestamp (or epoch ms) cut to the second. */
export function turnKeyOf(at: string | number): string {
  const iso = typeof at === 'number' ? new Date(at).toISOString() : at;
  return iso.slice(0, TIMESTAMP_TURN_KEY_LEN);
}

/**
 * The dedup set holds one key per criterion a model judged on a turn,
 * `${sessionId}:${evaluationName}:${turnKey}@${judgeModel}`
 * (JUDGE-MODEL-METADATA-ONLY), so a turn Haiku judged is still judged by a
 * different model.
 */
export function judgedByKey(sessionId: string, evaluationName: string, turnKey: string, judgeModel: string): string {
  return `${sessionId}:${evaluationName}:${turnKey}@${judgeModel}`;
}

/**
 * One criterion a model judged on a turn. Also the record's
 * `stableEvaluationKey`, so a turn judged again before its first records
 * reach the cloud posts under the same evaluation id and ingest drops it.
 */
export function turnJudgedKey(
  turn: { sessionId: string; timestamp: string },
  evaluationName: string,
  judgeModel: string,
): string {
  return judgedByKey(turn.sessionId, evaluationName, turnKeyOf(turn.timestamp), judgeModel);
}

/**
 * Add the key for one stored judge row. Rows written before the model was
 * recorded are all Haiku 4.5, so one with no model and no cohort, or a
 * `normal` or `backfill` one, counts as Haiku; any other has no key.
 */
export function addJudgedKey(
  keys: Set<string>,
  row: { sessionId: string; evaluationName: string; turnKey: string; judgeModel?: string | undefined; cohort?: string | undefined },
): void {
  const mayBeLegacyHaiku = row.cohort === undefined || row.cohort === NORMAL_COHORT || row.cohort === BACKFILL_COHORT;
  const judgeModel = row.judgeModel ?? (mayBeLegacyHaiku ? HAIKU_MODEL : undefined);
  if (judgeModel) keys.add(judgedByKey(row.sessionId, row.evaluationName, row.turnKey, judgeModel));
}
