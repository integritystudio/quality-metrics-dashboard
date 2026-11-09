/**
 * Records from a judge run whose post failed. The next run posts them before
 * its own and counts their turns as judged, so nothing a failed post dropped
 * is lost or paid for twice. Every record goes in, not only the unsent ones:
 * each carries its `stableEvaluationKey`, so ingest drops a re-post of one
 * that landed.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalRecord } from './eval-record.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';

export const JUDGE_PENDING_FILE = join(TELEMETRY_DIR, '.judge-pending.jsonl');

/** A judge record that can be posted again and deduplicated: one written before stable keys cannot. */
function isPendingRecord(value: unknown): value is EvalRecord & { stableEvaluationKey: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { evaluationName, stableEvaluationKey } = value as Record<string, unknown>;
  return typeof evaluationName === 'string' && typeof stableEvaluationKey === 'string' && stableEvaluationKey.length > 0;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The records a failed post left, or none when the file is absent; a line that is not one is dropped and counted. */
export function readPendingEvaluations(path: string = JUDGE_PENDING_FILE): { records: EvalRecord[]; dropped: number } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], dropped: 0 };
    throw err;
  }
  const lines = text.split('\n').filter(line => line.length > 0);
  const records = lines.map(line => parseLine(line)).filter(value => isPendingRecord(value));
  return { records, dropped: lines.length - records.length };
}

/** Replace the file with `records`, or remove it when there are none. */
export function writePendingEvaluations(records: readonly EvalRecord[], path: string = JUDGE_PENDING_FILE): void {
  if (records.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf-8');
}

/** Mark each pending record's turn and criterion as judged, so the run does not score it again. */
export function addPendingKeys(existingKeys: Set<string>, pending: readonly EvalRecord[]): void {
  for (const record of pending) {
    if (record.stableEvaluationKey) existingKeys.add(record.stableEvaluationKey);
  }
}
