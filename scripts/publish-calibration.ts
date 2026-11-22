/**
 * Publishes `meta:calibration`, the percentile distributions the dashboard
 * reads, straight to Cloudflare KV. derive computes the calibration state and
 * is the key's only writer: the KV sync Workflow does not touch it.
 */
import { loadCalibrationState } from '../../src/lib/quality/qfe-percentiles.js';
import { CALIBRATION_STATE_FILE } from '../../src/lib/quality/quality-constants.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';
import { buildCalibrationEntry, calibrationEntries, META_CALIBRATION_KEY } from '../src/api/aggregates/calibration-entry.js';
import type { KVEntry } from '../src/api/aggregates/kv-entry.js';
import { CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { putKvEntries } from './kv-client.js';

const LOG_PREFIX = '[calibration]';

/**
 * The `meta:calibration` entry from the state derive keeps (`CALIBRATION_STATE_DIR`).
 * A missing file is reported loudly: a silent miss leaves the dashboard on stale
 * percentiles (CALIBRATION-READ-WRONG-DIR).
 */
export function loadCalibrationEntry(dir: string = CALIBRATION_STATE_DIR): KVEntry | null {
  const state = loadCalibrationState(dir);
  if (!state) {
    console.warn(`${LOG_PREFIX} no ${CALIBRATION_STATE_FILE} in ${dir}; ${META_CALIBRATION_KEY} not published`);
    return null;
  }
  console.log(`${LOG_PREFIX} lastCalibrated=${state.lastCalibrated} (${dir})`);
  return buildCalibrationEntry(state);
}

/**
 * Publishes the current state on every run, changed or not: two writes, and a
 * key lost or overwritten in KV is restored by the next run. A failed publish
 * is logged and left for that run too, so it never fails derive.
 */
export async function publishCalibration(dryRun: boolean): Promise<void> {
  const entry = loadCalibrationEntry();
  if (!entry) return;
  const entries = calibrationEntries(entry, process.env.HOME_ORG_ID ?? '');
  const keys = entries.map(({ key }) => key).join(', ');
  if (dryRun) {
    console.log(`[dry-run] would publish ${keys}`);
    return;
  }
  try {
    await putKvEntries(entries);
  } catch (err) {
    console.error(`${LOG_PREFIX} publish failed, ${keys} left as they were: ${describeUnknown(err)}`);
    return;
  }
  console.log(`${LOG_PREFIX} published ${keys}`);
}
