/** Dated JSONL files under the telemetry directory. */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TELEMETRY_DIR } from './evaluation-constants.js';

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
    .toSorted()
    .map(f => join(dir, f));
}
