/**
 * The calibration handoff from derive-evaluations (the writer) to sync-to-kv
 * (the reader), and the only module that knows where it is kept.
 *
 * From 2026-04-19 the two scripts each named a directory, and the names
 * differed: derive wrote the telemetry directory, sync read its own. Sync found
 * no file and published nothing, so `/api/calibration` kept serving March's
 * percentiles for six months while every run reported success
 * (CALIBRATION-READ-WRONG-DIR). Neither script names a location now.
 *
 * A stage that runs off the laptop cannot share a local file
 * (PM2-ALEPH-POPULATE-DEFERRED). When that happens the state moves to KV or R2
 * by changing `readCalibrationState` and `writeCalibrationState`; keep every
 * path to it inside this file.
 */

import { join } from 'path';
import {
  loadCalibrationState,
  saveCalibrationState,
  type CalibrationState,
} from '../../src/lib/quality/qfe-percentiles.js';
import { CALIBRATION_STATE_FILE, CALIBRATION_WINDOW_DAYS } from '../../src/lib/quality/quality-constants.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { TELEMETRY_DIR } from './judge-evaluations.js';

/** Named in warnings only, so a log line says where to look. */
const STATE_LOCATION = join(TELEMETRY_DIR, CALIBRATION_STATE_FILE);

/** The state derive last wrote; null when there is none or it does not parse. */
export function readCalibrationState(): CalibrationState | null {
  return loadCalibrationState(TELEMETRY_DIR);
}

export function writeCalibrationState(state: CalibrationState): void {
  saveCalibrationState(TELEMETRY_DIR, state);
}

/**
 * How old `lastCalibrated` may be before sync-to-kv warns.
 *
 * Derive rewrites the state only when a metric's distribution has drifted
 * (`shouldRecalibrate`), so a stamp that does not advance is normal: on
 * 2026-10-05 the live state was six days old under a twice-daily schedule. A
 * bound of a few days would warn on a working pipeline.
 * `CALIBRATION_WINDOW_DAYS` is the window each distribution is stamped with:
 * past it, every score the percentiles came from has left the window, and the
 * state is old by its own definition however stable the distributions are.
 */
export const CALIBRATION_STALE_AFTER_MS = CALIBRATION_WINDOW_DAYS * TIME_MS.DAY;

/**
 * Why the calibration state should not be taken as current, or null when it
 * can be. A missing state looked like a successful run for six months, and one
 * older than `CALIBRATION_STALE_AFTER_MS` would look the same; this is the line
 * that says so. A `lastCalibrated` that is not a date counts as stale.
 */
export function calibrationStalenessWarning(state: CalibrationState | null, nowMs: number): string | null {
  if (!state) {
    return `no readable calibration state at ${STATE_LOCATION}: derive has not written one where sync reads, so no meta:calibration is published`;
  }
  const ageMs = nowMs - Date.parse(state.lastCalibrated);
  if (ageMs <= CALIBRATION_STALE_AFTER_MS) return null;
  const age = Number.isFinite(ageMs) ? `${Math.floor(ageMs / TIME_MS.DAY)} days old` : 'undated';
  return `calibration state at ${STATE_LOCATION} is ${age} (lastCalibrated=${state.lastCalibrated}, bound ${CALIBRATION_WINDOW_DAYS} days): derive rewrites it only when a distribution drifts, so either nothing has drifted that long or derive is not writing there`;
}
