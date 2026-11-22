/**
 * Turns whose hallucination verdict went missing while the rest of the
 * consolidated call was recorded. Turn selection counts such a turn as judged,
 * so its hallucination score stays blank; each one is written as an ERROR log
 * record in `logs-<today>.jsonl`, which the span shipper carries.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES } from '../../src/lib/core/shared-schemas.js';
import { SESSION_ATTRIBUTES, severityCodec, type OtelLogSeverity } from '../../src/lib/otel/constants-otel.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../src/lib/otel/genai-attributes.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { IDENTITY_KEY_REF_FIELD } from './account-index.js';
import { EVALUATION_SERVICE_NAME } from './evaluation-delivery.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';
import { toHrTime, type HrTime } from './evaluation-events.js';
import { CONSOLIDATED_PRODUCER } from './judge-consolidated.js';
import type { Turn } from './judge-turns.js';
import { LOGS_FILE_PREFIX, datedJsonlName } from './telemetry-files.js';

export const HALLUCINATION_GAP_EVENT = 'integritystudio.judge.hallucination_missing';
export const HALLUCINATION_GAP_SEVERITY: OtelLogSeverity = 'ERROR';
export const TURN_TIMESTAMP_ATTRIBUTE = 'integritystudio.evaluation.turn.timestamp';
const LOG_PREFIX = '[judge]';

export type HallucinationGapLine = {
  timestamp: HrTime;
  observedTimestamp: HrTime;
  severityNumber: number;
  severityText: OtelLogSeverity;
  eventName: typeof HALLUCINATION_GAP_EVENT;
  body: string;
  attributes: Record<string, string>;
  traceId?: string;
  spanId?: string;
  resource: { serviceName: string };
  [IDENTITY_KEY_REF_FIELD]: string;
};

/** The log line for one turn, or undefined when it has no account to ship under. */
export function toHallucinationGapLine(turn: Turn, judgeModel: string, observedMs: number): HallucinationGapLine | undefined {
  if (typeof turn.identityKeyRef !== 'string') return undefined;
  const at = toHrTime(observedMs);
  return {
    timestamp: at,
    observedTimestamp: at,
    severityNumber: severityCodec.encode(HALLUCINATION_GAP_SEVERITY),
    severityText: HALLUCINATION_GAP_SEVERITY,
    eventName: HALLUCINATION_GAP_EVENT,
    body: `no ${HALLUCINATION_EVAL_NAME} verdict for a turn whose other criteria were recorded; it will not be retried`,
    attributes: {
      [SESSION_ATTRIBUTES.ID]: turn.sessionId,
      [TURN_TIMESTAMP_ATTRIBUTE]: turn.timestamp,
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: HALLUCINATION_EVAL_NAME,
      [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR]: CONSOLIDATED_PRODUCER,
      [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.JUDGE_MODEL]: judgeModel,
    },
    ...(turn.traceId && { traceId: turn.traceId }),
    ...(turn.spanId && { spanId: turn.spanId }),
    resource: { serviceName: EVALUATION_SERVICE_NAME },
    [IDENTITY_KEY_REF_FIELD]: turn.identityKeyRef,
  };
}

export type HallucinationGapReport = {
  /** Lines appended to today's logs file. */
  written: number;
  /** Turns with no account, reported on stderr only. */
  unshipped: number;
};

/** Log every gap on stderr and append the shippable ones to today's logs file. */
export function reportHallucinationGaps(
  turns: readonly Turn[],
  judgeModel: string,
  now: Date = new Date(),
  dir: string = TELEMETRY_DIR,
): HallucinationGapReport {
  const lines = turns.map(turn => toHallucinationGapLine(turn, judgeModel, now.getTime())).filter(line => line !== undefined);
  for (const turn of turns) {
    console.error(`${LOG_PREFIX} ${HALLUCINATION_GAP_SEVERITY} ${HALLUCINATION_EVAL_NAME} left blank for session ${turn.sessionId} turn ${turn.timestamp}`);
  }
  if (lines.length > 0) {
    const file = join(dir, datedJsonlName(LOGS_FILE_PREFIX, toDateOnly(now)));
    appendFileSync(file, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  }
  return { written: lines.length, unshipped: turns.length - lines.length };
}
