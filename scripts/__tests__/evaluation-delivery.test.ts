import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluationId, keyedRequest, mapRecord, type EvaluationPayload } from '../evaluation-delivery.js';
import { EVALUATION_ATTRS, EVALUATION_RESULT_EVENT, LEGACY_EVALUATOR_TYPE_ATTR, toOTelRecord } from '../eval-record.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';
import { INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES } from '../../../src/lib/core/shared-schemas.js';
import { WEBHOOK_MAX_EXPLANATION_LENGTH } from '../../../src/lib/core/obtool-contract.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../../src/lib/http-constants.js';

const OVER_LONG_EXPLANATION_LENGTH = 5000;
/** Together past MAX_EVALUATION_BYTES before the explanation is truncated. */
const OVERSIZED_FIELD_LENGTHS = { name: 500, explanation: 9000 };
const MAX_EVALUATION_BYTES = 10_000;
const EVALUATION_ID_LENGTH = 32;
const STAMPED_EVALUATION_ID = 'f'.repeat(EVALUATION_ID_LENGTH);

function record(attrs: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-09-15T11:00:00.000Z',
    name: EVALUATION_RESULT_EVENT,
    attributes: {
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'relevance',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 0.9,
      ...attrs,
    },
    ...extra,
  };
}

describe('mapRecord', () => {
  it('maps a quality-evaluation hook record, never reading the judge-span attributes as its trace/span', () => {
    const { payload, skip } = mapRecord(record({
      [EVALUATION_ATTRS.PRODUCER]: 'hook:stop-quality-evaluation',
      [EVALUATION_ATTRS.EVALUATOR_KIND]: 'llm',
      [EVALUATION_ATTRS.COHORT]: 'normal',
      [SESSION_ATTRIBUTES.ID]: 'sess-1',
      'trace.id': 'judge-trace',
      'span.id': 'judge-span',
      [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'because',
    }, { traceId: 'trace-1', spanId: 'span-1' }));

    expect(skip).toBeUndefined();
    expect(payload).toMatchObject({
      evaluationName: 'relevance',
      evaluator: 'hook:stop-quality-evaluation',
      evaluatorType: 'llm',
      scoreValue: 0.9,
      explanation: 'because',
      traceId: 'trace-1',
      spanId: 'span-1',
      sessionId: 'sess-1',
    });
    expect(payload?.cohort).toBe('normal');
    // The ISO evaluation time also rides in metadata, for auditability.
    expect(payload?.metadata).toEqual({ evaluatedAt: '2026-09-15T11:00:00.000Z' });
  });

  it('does not send a cohort outside the webhook enum, which would reject the batch', () => {
    const { payload } = mapRecord(record({ [EVALUATION_ATTRS.COHORT]: 'production' }));

    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('cohort');
    expect(payload?.metadata).not.toHaveProperty('cohort');
  });

  it('carries a stamped schema URL to the row as metadata.schemaUrl', () => {
    const schemaUrl = 'https://integritystudio.ai/schemas/evaluation/1.0.0';
    const { payload } = mapRecord(record({ [SESSION_ATTRIBUTES.ID]: 'sess-1' }, { schemaUrl }));

    expect(payload?.metadata).toMatchObject({ schemaUrl });
    expect(payload).not.toHaveProperty('schemaUrl');
  });

  it('writes no metadata.schemaUrl for a record written before the stamp existed', () => {
    const { payload } = mapRecord(record({ [SESSION_ATTRIBUTES.ID]: 'sess-1' }));

    expect(payload?.metadata).not.toHaveProperty('schemaUrl');
  });

  it('sends the judge model as its own field, not inside metadata', () => {
    const { payload } = mapRecord(record({
      [EVALUATION_ATTRS.EVALUATOR_KIND]: 'llm',
      [EVALUATION_ATTRS.JUDGE_MODEL]: 'claude-haiku-4-5-20251001',
      [SESSION_ATTRIBUTES.ID]: 'sess-1',
    }));

    expect(payload?.judgeModel).toBe('claude-haiku-4-5-20251001');
    expect(payload?.metadata).not.toHaveProperty('judgeModel');
  });

  it('maps a derive record that carries only the legacy overloaded evaluator.type', () => {
    const { payload } = mapRecord(record({
      [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR]: 'derive-evaluations',
      [LEGACY_EVALUATOR_TYPE_ATTR]: 'rule',
    }));

    expect(payload).toMatchObject({
      evaluator: 'derive-evaluations',
      evaluatorType: 'rule',
    });
  });

  it('no longer reads the score unit from the old gen_ai key (EVAL-KEY-COMPAT-REMOVAL)', () => {
    const { payload } = mapRecord(record({
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the retired key is ignored
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_UNIT]: 'ratio_0_1',
    }));

    expect(payload?.scoreUnit).toBeUndefined();
  });

  it('carries a score label from toOTelRecord to the payload, and omits one never set', () => {
    const base = {
      timestamp: '2026-09-15T11:00:00.000Z',
      evaluationName: 'agent_overall',
      scoreValue: 0.4,
      explanation: 'x',
      evaluator: 'rule',
      evaluatorKind: 'rule' as const,
      cohort: 'normal' as const,
      traceId: 'trace-1',
      sessionId: 'sess-1',
    };

    const labelled = mapRecord(toOTelRecord({ ...base, scoreLabel: 'fail' })).payload;
    const unlabelled = mapRecord(toOTelRecord(base)).payload;

    expect(labelled?.scoreLabel).toBe('fail');
    expect(unlabelled).not.toHaveProperty('scoreLabel');
  });

  it('reads a top-level traceId, as toOTelRecord writes it', () => {
    const { payload } = mapRecord(record({}, { traceId: 'top-level-trace' }));
    expect(payload?.traceId).toBe('top-level-trace');
  });

  it('skips a record the hooks stamped with an evaluation id: it already shipped as a log event (RSR3)', () => {
    const stamped = record({
      [EVALUATION_ATTRS.PRODUCER]: 'hook:stop-quality-evaluation',
      [EVALUATION_ATTRS.COHORT]: 'canary',
      [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]: STAMPED_EVALUATION_ID,
    });
    expect(mapRecord(stamped).skip).toBe('shipped-as-event');
  });

  it('still maps a record whose id stamp is malformed, since no event carried it under that id', () => {
    const malformed = record({ [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]: 'not-an-id' });
    expect(mapRecord(malformed).skip).toBeUndefined();
  });

  it('drops non-evaluation lines', () => {
    expect(mapRecord({ name: 'something.else' }).skip).toBe('not-an-evaluation');
    expect(mapRecord(null).skip).toBe('not-an-evaluation');
  });

  it('drops records with no numeric score, which the webhook would reject', () => {
    const noScore = {
      timestamp: '2026-09-15T11:00:00.000Z',
      name: EVALUATION_RESULT_EVENT,
      attributes: { [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'relevance' },
    };
    expect(mapRecord(noScore).skip).toBe('no-score');
  });

  it('truncates an over-long explanation to the webhook cap', () => {
    const { payload } = mapRecord(
      record({ [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'x'.repeat(OVER_LONG_EXPLANATION_LENGTH) }),
    );
    expect(payload?.explanation).toHaveLength(WEBHOOK_MAX_EXPLANATION_LENGTH);
  });

  it('keeps every payload under the per-evaluation byte cap', () => {
    const { payload, skip } = mapRecord(
      record({
        [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'n'.repeat(OVERSIZED_FIELD_LENGTHS.name),
        [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'e'.repeat(OVERSIZED_FIELD_LENGTHS.explanation),
      }),
    );
    expect(skip).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_EVALUATION_BYTES);
  });
});

describe('evaluationId', () => {
  const base = {
    timestamp: '2026-09-15T11:00:00.000Z',
    name: EVALUATION_RESULT_EVENT,
    traceId: 'trace-1',
    attributes: { [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'tool_correctness', [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 1 },
  };

  it('is the same whether or not the record carries an account stamp', () => {
    // A cloud-sourced derive stamps records a local one could not; both are one evaluation.
    expect(evaluationId({ ...base, identityKeyRef: 'OBTOOL_API_KEY' })).toBe(evaluationId(base));
  });

  it('separates parallel spans that differ only in span id', () => {
    expect(evaluationId({ ...base, spanId: 'span-a' })).not.toBe(evaluationId({ ...base, spanId: 'span-b' }));
  });

  it('is sent on every mapped payload, so a re-send is dropped by the ingest worker', () => {
    const r = record({ [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR]: 'derive-evaluations' }) as Record<string, unknown>;
    expect(mapRecord(r).payload?.evaluationId).toBe(evaluationId(r));
  });

  it('keeps the id the hooks stamped on the record, whatever else changes (HDF12)', () => {
    const stamped = { ...base, attributes: { ...base.attributes, [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]: STAMPED_EVALUATION_ID } };
    expect(evaluationId(stamped)).toBe(STAMPED_EVALUATION_ID);
    expect(evaluationId({ ...stamped, spanId: 'span-b', identityKeyRef: 'OBTOOL_API_KEY' })).toBe(STAMPED_EVALUATION_ID);
  });

  it('ignores a stamp that is not 32 hex characters, so a bad producer cannot collapse rows', () => {
    const malformed = { ...base, attributes: { ...base.attributes, [INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID]: 'not-an-id' } };
    expect(evaluationId(malformed)).toMatch(/^[0-9a-f]{32}$/);
    expect(evaluationId(malformed)).not.toBe('not-an-id');
  });

  it('uses stableEvaluationKey when present, so session records hash the same across different span anchors', () => {
    const key = 'session:sess-abc:conversation_completeness';
    const withKeySpanA = { ...base, spanId: 'span-a', traceId: 'trace-1', stableEvaluationKey: key };
    const withKeySpanB = { ...base, spanId: 'span-b', traceId: 'trace-2', stableEvaluationKey: key };
    expect(evaluationId(withKeySpanA)).toBe(evaluationId(withKeySpanB));
  });

  it('excludes stableEvaluationKey from the hash for records without one', () => {
    // A record without the field must produce the same id regardless of whether
    // the field was stripped — it was never part of the hash for ordinary records.
    expect(evaluationId(base)).toBe(evaluationId({ ...base, stableEvaluationKey: undefined }));
  });

  it('falls back to full-record hash when stableEvaluationKey is an empty string', () => {
    // An empty key collapsing many records to sha256('') would be a data bug.
    expect(evaluationId({ ...base, stableEvaluationKey: '' })).toBe(evaluationId(base));
  });
});

describe('keyedRequest', () => {
  it('builds a keyed backfill request the ingest drain reads line by line', () => {
    const payload = (extra: Partial<EvaluationPayload>): EvaluationPayload => ({
      evaluationName: 'relevance', evaluator: 'judge', evaluatorType: 'llm', scoreValue: 4, ...extra,
    });
    const req = keyedRequest('https://ingest.example', [payload({ traceId: 'a' }), payload({ traceId: 'b' })], 'k');
    expect(req.url).toBe('https://ingest.example/v1/ingest/backfill?signal=evaluations');
    expect(req.headers).toEqual({ [CONTENT_TYPE_HEADER]: ContentType.Ndjson, Authorization: 'Bearer k' });
    const lines = req.body.trimEnd().split('\n').map((l) => JSON.parse(l) as { traceId: string });
    expect(lines.map((l) => l.traceId)).toEqual(['a', 'b']);
  });
});

describe('MAX_EVALUATION_BYTES mirrored from the ingest worker', () => {
  // The other webhook caps come from src/lib/core/obtool-contract.ts. This one
  // is still module-private in the ingest worker, so delivery copies it and
  // this test keeps the copy honest: if the worker tightens it, delivery
  // starts sending payloads the worker rejects, and nothing else would catch it.
  it('matches services/obtool-ingest/src/evaluations.ts', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../services/obtool-ingest/src/evaluations.ts'),
      'utf8',
    );
    const delivery = readFileSync(resolve(__dirname, '../evaluation-delivery.ts'), 'utf8');

    const pattern = /const MAX_EVALUATION_BYTES = ([0-9_]+)/;
    const fromSource = pattern.exec(source)?.[1];
    expect(fromSource, 'MAX_EVALUATION_BYTES not found in ingest worker').toBeDefined();
    expect(pattern.exec(delivery)?.[1], 'MAX_EVALUATION_BYTES not found in evaluation-delivery.ts').toBe(fromSource);
  });
});

describe('network failure handling', () => {
  // Guards three defects an earlier sender had: a thrown fetch escaped the
  // batch loop, no retry let one blip abort a long run, and no timeout let a
  // hung connection stall it.
  const SCRIPT = readFileSync(resolve(__dirname, '../evaluation-delivery.ts'), 'utf8');

  it('never lets a transport error escape as an exception', () => {
    // postBatchOnce must convert a thrown fetch into a returned result.
    const once = SCRIPT.slice(SCRIPT.indexOf('async function postBatchOnce'));
    const body = once.slice(0, once.indexOf('\n}\n'));
    expect(body).toContain('try {');
    expect(body).toContain('catch');
    expect(body).toMatch(/retryable:\s*true/);
  });

  it('retries transient failures and logs once on exhaustion', () => {
    const retry = SCRIPT.slice(SCRIPT.indexOf('async function postBatch(request'));
    const body = retry.slice(0, retry.indexOf('\n}\n'));
    expect(body).toContain('MAX_SEND_ATTEMPTS');
    expect(body).toMatch(/console\.error\(`\[ingest\] giving up/);
  });

  it('retries throttling and server faults but not payload rejections', () => {
    // A 400 means the same bytes will be rejected again — retrying wastes the
    // budget and delays the real error reaching the operator.
    expect(SCRIPT).toMatch(/response\.status === HttpStatus\.TooManyRequests \|\| response\.status >= HttpStatus\.InternalServerError/);
  });

  it('bounds every request with a timeout', () => {
    expect(SCRIPT).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
  });
});
