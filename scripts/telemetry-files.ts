/** Dated JSONL files under the telemetry directory. */

import { readdirSync } from 'fs';
import { join } from 'path';
import { TELEMETRY_DIR } from './evaluation-constants.js';

/**
 * `evaluations-YYYY-MM-DD.jsonl`: the hooks' own records and the judge's
 * records. Derive writes no file since cloud-read Phase 6; it posts every record.
 */
export const EVALUATIONS_FILE_PREFIX = 'evaluations';
export const LOGS_FILE_PREFIX = 'logs';
export const TRACES_FILE_PREFIX = 'traces';
const JSONL_EXTENSION = '.jsonl';

/** Dated JSONL filename for a prefix. */
export function datedJsonlName(prefix: string, date: string): string {
  return `${prefix}-${date}${JSONL_EXTENSION}`;
}

/** Full paths of every `<prefix>-*.jsonl` file in `dir`, in name (date) order. */
export function listTelemetryJsonl(prefix: string, dir: string = TELEMETRY_DIR): string[] {
  return readdirSync(dir)
    .filter(f => f.startsWith(`${prefix}-`) && f.endsWith(JSONL_EXTENSION))
    .sort()
    .map(f => join(dir, f));
}
