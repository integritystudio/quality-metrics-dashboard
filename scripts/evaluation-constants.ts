/**
 * Telemetry paths and evaluation markers shared by the pipeline stages.
 *
 * Kept apart from judge-evaluations.ts so a stage that needs only these
 * (sync-to-kv, trace-coverage) does not load the judge and its dependencies.
 */

import { join } from 'node:path';

export const HOME = process.env.HOME ?? '';
// Must match the producer: hooks/lib/core/constants.ts writes telemetry here.
// `TELEMETRY_DIR` overrides it, as it does for the other scripts that read
// telemetry, so a run can be pointed at a scratch directory.
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty TELEMETRY_DIR must fall back to the default, not resolve paths against cwd
export const TELEMETRY_DIR = process.env.TELEMETRY_DIR || join(HOME, '.claude-history', 'telemetry');
/**
 * Where `.calibration-state.json` lives: derive writes it, and publish-calibration.ts reads it
 * to build `meta:calibration`. One constant for both: when the reader and writer used different
 * directories, the reader found nothing and the dashboard served stale percentiles.
 */
export const CALIBRATION_STATE_DIR = TELEMETRY_DIR;
