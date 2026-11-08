import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvaluationEvents, toEvaluationEventLine } from '../evaluation-events.js';
import { emptyAccountIndex } from '../post-evaluations.js';
import { EVALUATION_ATTRS, EVALUATION_RESULT_EVENT } from '../eval-record.js';
import { UPLOAD_SERVICE_NAME, evaluationId } from '../upload-evaluations.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES } from '../../../src/lib/core/shared-schemas.js';
import { TIME_MS } from '../../../src/lib/core/units.js';
import { assertDefined } from '../../src/__tests__/support/defined.js';
import type { AccountIndex } from '../account-stamps.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const LOGS_FILE = 'logs-2026-11-08.jsonl';
const KEY_REF = 'OBTOOL_API_KEY_TEST';
const TURN_TIME = '2026-10-20T09:30:15.250Z';
const TURN_SECONDS = Math.floor(Date.parse(TURN_TIME) / TIME_MS.SECOND);
const TURN_NANOS = 250_000_000;
const INFO_SEVERITY_NUMBER = 9;

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: TURN_TIME,
    name: EVALUATION_RESULT_EVENT,
    traceId: 'trace-1',
    attributes: {
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'relevance',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 0.8,
      [EVALUATION_ATTRS.PRODUCER]: 'dashboard:judge-consolidated',
    },
    ...extra,
  };
}

function indexWithSpan(spanId: string, ref: string): AccountIndex {
  const index = emptyAccountIndex();
  index.bySpan.set(spanId, ref);
  return index;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evaluation-events-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readLines = (): Array<Record<string, unknown>> =>
  readFileSync(join(dir, LOGS_FILE), 'utf-8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

describe('toEvaluationEventLine', () => {
  it('writes a stamped record as a shippable log event carrying the id the post sends', () => {
    const r = record({ identityKeyRef: KEY_REF });

    const line = toEvaluationEventLine(r, emptyAccountIndex(), NOW.getTime());

    assertDefined(line);
    expect(line).toMatchObject({
      timestamp: [TURN_SECONDS, TURN_NANOS],
      severityNumber: INFO_SEVERITY_NUMBER,
      severityText: 'INFO',
      eventName: EVALUATION_RESULT_EVENT,
      traceId: 'trace-1',
      resource: { serviceName: UPLOAD_SERVICE_NAME },
      identityKeyRef: KEY_REF,
    });
    expect(line.attributes[INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]).toBe(evaluationId(r));
    expect(line.attributes[GENAI_EVALUATION_ATTRIBUTES.NAME]).toBe('relevance');
  });

  it('routes an unstamped record by the account of the span it names', () => {
    const line = toEvaluationEventLine(record({ spanId: 'span-1' }), indexWithSpan('span-1', KEY_REF), NOW.getTime());

    expect(line?.identityKeyRef).toBe(KEY_REF);
  });

  it.each([
    ['unstamped, so its post goes to the webhook org', record()],
    ['stamped null, so it is withheld', record({ identityKeyRef: null })],
    ['not an evaluation', record({ name: 'something.else', identityKeyRef: KEY_REF })],
  ])('writes nothing for a record that is %s', (_label, r) => {
    expect(toEvaluationEventLine(r, emptyAccountIndex(), NOW.getTime())).toBeUndefined();
  });
});

describe('appendEvaluationEvents', () => {
  it("appends only the shippable records to the logs file named for today's UTC date", () => {
    writeFileSync(join(dir, LOGS_FILE), '{"existing":true}\n');

    const backup = appendEvaluationEvents([record({ identityKeyRef: KEY_REF }), record()], emptyAccountIndex(), NOW, dir);

    expect(backup).toEqual({ file: join(dir, LOGS_FILE), written: 1 });
    const [existing, event] = readLines();
    expect(existing).toEqual({ existing: true });
    expect(Array.isArray(event?.timestamp)).toBe(true);
    expect(event?.identityKeyRef).toBe(KEY_REF);
  });

  it('leaves the logs file untouched when no record qualifies', () => {
    const backup = appendEvaluationEvents([record()], emptyAccountIndex(), NOW, dir);

    expect(backup.written).toBe(0);
    expect(existsSync(join(dir, LOGS_FILE))).toBe(false);
  });
});
