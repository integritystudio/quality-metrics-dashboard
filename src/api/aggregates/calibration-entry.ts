/** The `meta:calibration` KV entry derive publishes: the percentile distributions the dashboard reads. */
import type { CalibrationState } from '../parent/qfe-percentiles.js';
import type { CalibrationResponse } from '../../lib/validation/dashboard-schemas.js';
import { orgPrefixedKey, toKVValue, type KVEntry } from './kv-entry.js';

export const META_CALIBRATION_KEY = 'meta:calibration';

export function buildCalibrationEntry(
  state: CalibrationState | null,
): KVEntry | null {
  if (!state?.distributions || Object.keys(state.distributions).length === 0) {
    return null;
  }
  const distributions: CalibrationResponse['distributions'] = {};
  const sampleCounts: CalibrationResponse['sampleCounts'] = {};
  for (const [metric, entry] of Object.entries(state.distributions)) {
    distributions[metric] = entry.distribution;
    sampleCounts[metric] = entry.sampleSize;
  }
  // Typed as the shared contract so a drift between what this writes and what
  // `useCalibration` reads is a typecheck failure, not a runtime surprise.
  const payload: CalibrationResponse = {
    distributions,
    sampleCounts,
    lastCalibrated: state.lastCalibrated,
  };
  return { key: META_CALIBRATION_KEY, value: toKVValue(payload) };
}

/** The entry under each key the dashboard reads it from: the home org's, and the bare key it falls back to. */
export function calibrationEntries(entry: KVEntry, homeOrgId: string): KVEntry[] {
  return homeOrgId ? [{ ...entry, key: orgPrefixedKey(homeOrgId, entry.key) }, entry] : [entry];
}
