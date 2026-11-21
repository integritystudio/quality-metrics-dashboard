/**
 * Dated JSONL files under the telemetry directory: their names, and the
 * read-only trace-file walk `trace-coverage` uses to compare local spans with
 * the cloud. That is a debugging and internal-observability check, not a
 * pipeline stage; the evaluation producers read the cloud instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIME_MS } from '../../src/lib/core/units.js';

export const LOGS_FILE_PREFIX = 'logs';
const JSONL_EXTENSION = '.jsonl';

/** Dated JSONL filename for a prefix. */
export function datedJsonlName(prefix: string, date: string): string {
  return `${prefix}-${date}${JSONL_EXTENSION}`;
}

/** `traces-YYYY-MM-DD.jsonl` — the stamped spans. */
export const TRACE_FILE_PATTERN = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Whether a dated file (`<prefix>-YYYY-MM-DD.jsonl`) is inside the window. */
export function fileInWindow(file: string, pattern: RegExp, windowDays: number, nowMs: number): boolean {
  const date = pattern.exec(file)?.[1];
  if (date === undefined) return false;
  // Compare on the date in the name, never mtime: a file can be rewritten or
  // copied after its day, so mtime says nothing about which day's records are inside.
  return Date.parse(`${date}T23:59:59.999Z`) >= nowMs - windowDays * TIME_MS.DAY;
}

/** Every parseable line of the trace files `files` (names under `dir`). */
export function* traceFileRecords(
  dir: string,
  files: readonly string[],
  onReadError?: (file: string, err: unknown) => void,
): Generator {
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (err) {
      onReadError?.(file, err);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // `unknown`, not a cast to Record: JSON.parse returns whatever the line
      // held, and a bare JSON string would make `'x' in span` throw below.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      yield parsed;
    }
  }
}
