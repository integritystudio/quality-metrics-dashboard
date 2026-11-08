/**
 * The judge's backup copy of what it posts: each record as a
 * `gen_ai.evaluation.result` log event in `logs-<today>.jsonl`, in the hooks'
 * exporter shape (HDF12). The span shipper carries the file at the next session
 * Stop, so a failed post still lands; when the post succeeded, ingest keeps the
 * first of the two on `(org_id, evaluation_id)`.
 *
 * Only a record routed to a mapped account gets an event. The shipper sends a
 * line under its `identityKeyRef`, while an unstamped record's post lands in
 * `HOME_ORG_ID`, so an event for it would add a second row in another org.
 *
 * Every line must pass the shipper's `isValidRecord` (an HrTime `timestamp`):
 * a read window holding only lines it cannot send stops the logs cursor and
 * reports `export-failed` on every run.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES } from '../../src/lib/core/shared-schemas.js';
import { NANOSECONDS_PER_SECOND, TIME_MS } from '../../src/lib/core/units.js';
import { severityCodec, type OtelLogSeverity } from '../../src/lib/otel/constants-otel.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { IDENTITY_KEY_REF_FIELD, type AccountIndex } from './account-stamps.js';
import { EVALUATION_RESULT_EVENT } from './eval-record.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';
import { LOGS_FILE_PREFIX, datedJsonlName } from './telemetry-files.js';
import { UPLOAD_SERVICE_NAME, evaluationId, mapRecord, routeRecord } from './upload-evaluations.js';

type HrTime = [seconds: number, nanoseconds: number];

/** The hooks' `ExportedLog` fields this writer sets (`hooks/lib/otel/otel.ts`). */
export type EvaluationEventLine = {
  timestamp: HrTime;
  observedTimestamp: HrTime;
  severityNumber: number;
  severityText: OtelLogSeverity;
  eventName: typeof EVALUATION_RESULT_EVENT;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  resource: { serviceName: string };
  [IDENTITY_KEY_REF_FIELD]: string;
};

const EVENT_SEVERITY: OtelLogSeverity = 'INFO';
const NANOSECONDS_PER_MILLISECOND = NANOSECONDS_PER_SECOND / TIME_MS.SECOND;

function toHrTime(epochMs: number): HrTime {
  return [Math.floor(epochMs / TIME_MS.SECOND), (epochMs % TIME_MS.SECOND) * NANOSECONDS_PER_MILLISECOND];
}

/**
 * The event line for one `toOTelRecord` output, or undefined when it must not
 * ship: unmappable, undated, withheld, or headed for the webhook.
 */
export function toEvaluationEventLine(
  record: Record<string, unknown>,
  accounts: AccountIndex,
  observedMs: number,
): EvaluationEventLine | undefined {
  const mapped = mapRecord(record, observedMs, Number.POSITIVE_INFINITY);
  if (mapped.skip) return undefined;
  const { evaluatedAtMs, traceId, spanId } = mapped.payload;
  if (evaluatedAtMs === undefined) return undefined;
  const { route } = routeRecord(mapped, accounts);
  if (route.kind !== 'keyed') return undefined;

  return {
    timestamp: toHrTime(evaluatedAtMs),
    observedTimestamp: toHrTime(observedMs),
    severityNumber: severityCodec.encode(EVENT_SEVERITY),
    severityText: EVENT_SEVERITY,
    eventName: EVALUATION_RESULT_EVENT,
    // The id the post sends too, so whichever copy arrives second is dropped.
    attributes: {
      ...(record.attributes as Record<string, unknown>),
      [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]: evaluationId(record),
    },
    ...(traceId && { traceId }),
    ...(spanId && { spanId }),
    resource: { serviceName: UPLOAD_SERVICE_NAME },
    [IDENTITY_KEY_REF_FIELD]: route.ref,
  };
}

export type EventBackup = {
  file: string;
  /** Records with an event line; the rest can only be delivered by the post. */
  written: number;
};

/** Append the event lines for `records` to today's logs file, which is left untouched when none qualify. */
export function appendEvaluationEvents(
  records: ReadonlyArray<Record<string, unknown>>,
  accounts: AccountIndex,
  now: Date = new Date(),
  dir: string = TELEMETRY_DIR,
): EventBackup {
  const file = join(dir, datedJsonlName(LOGS_FILE_PREFIX, toDateOnly(now)));
  const lines = records
    .map(record => toEvaluationEventLine(record, accounts, now.getTime()))
    .filter(line => line !== undefined)
    .map(line => `${JSON.stringify(line)}\n`);
  if (lines.length > 0) appendFileSync(file, lines.join(''));
  return { file, written: lines.length };
}
