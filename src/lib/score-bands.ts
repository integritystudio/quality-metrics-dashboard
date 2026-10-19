/**
 * Score color band thresholds shared with the parent toolkit. Re-export only:
 * the parent's `score-bands.ts` is import-free, so it is safe in browser code,
 * unlike `quality-constants.ts`, which reaches `process.env` at load.
 */
export {
  SCORE_BAND_ADEQUATE,
  SCORE_BAND_EXCELLENT,
  SCORE_BAND_GOOD,
  SCORE_BAND_POOR,
} from '@parent/lib/quality/score-bands.js';
