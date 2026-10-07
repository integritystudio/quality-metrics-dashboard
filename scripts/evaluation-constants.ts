/**
 * Telemetry paths and evaluation markers shared by the pipeline stages.
 *
 * Kept apart from judge-evaluations.ts so a stage that needs only these
 * (sync-to-kv, trace-coverage) does not load the judge and its dependencies.
 */

import { join } from 'path';
import type { EvaluationCohort } from '../../src/lib/validation/dashboard-schemas.js';

const HOME = process.env.HOME ?? '';
// Must match the producer: hooks/lib/constants.ts writes telemetry here.
export const TELEMETRY_DIR = join(HOME, '.claude-history', 'telemetry');
/**
 * Where `.calibration-state.json` lives: derive writes it, and sync-to-kv reads it to build
 * `meta:calibration`. One constant for both, because they disagreed: from 231e91d (2026-04-19)
 * to 2026-10-05 sync read `dashboard/scripts/`, found nothing, wrote nothing, and the
 * dashboard served the percentiles from 2026-03-23 (CALIBRATION-READ-WRONG-DIR).
 */
export const CALIBRATION_STATE_DIR = TELEMETRY_DIR;

/** Legacy (pre-OBP16) canary marker, carried in the overloaded `evaluatorType`. */
export const CANARY_EVALUATOR_TYPE = 'canary';
export const CANARY_COHORT: EvaluationCohort = 'canary';
