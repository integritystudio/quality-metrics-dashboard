/** Dated JSONL file names under the telemetry directory. */

export const LOGS_FILE_PREFIX = 'logs';
const JSONL_EXTENSION = '.jsonl';

/** Dated JSONL filename for a prefix. */
export function datedJsonlName(prefix: string, date: string): string {
  return `${prefix}-${date}${JSONL_EXTENSION}`;
}
