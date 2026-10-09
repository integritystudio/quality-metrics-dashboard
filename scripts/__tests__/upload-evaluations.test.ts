import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  mapRecord,
  fingerprint,
  evaluationId,
  loadShipped,
  saveShipped,
  pruneShipped,
  windowFiles,
  keyedRequest,
  manifestKey,
  parseKeyManifest,
  payloadManifestKey,
  type ShippedIndex,
  type EvaluationPayload,
  main,
} from '../upload-evaluations.js';
import { buildAccountIndex } from '../account-stamps.js';
import { deriveToolCorrectness } from '../derive-evaluations.js';
import { EVALUATION_RESULT_EVENT, toOTelRecord } from '../eval-record.js';
import { GENAI_EVALUATION_ATTRIBUTES, GENAI_TOOL_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const MAX_AGE_MS = 36 * 3_600_000;

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
  it('maps a quality-evaluation hook record, reading trace/span ids from attributes', () => {
    const { payload, skip } = mapRecord(record({
      'integritystudio.evaluation.producer': 'hook:stop-quality-evaluation',
      'integritystudio.evaluation.evaluator.kind': 'llm',
      'integritystudio.evaluation.cohort': 'normal',
      [SESSION_ATTRIBUTES.ID]: 'sess-1',
      'trace.id': 'trace-1',
      'span.id': 'span-1',
      [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'because',
    }), NOW, MAX_AGE_MS);

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
    const { payload } = mapRecord(record({ 'integritystudio.evaluation.cohort': 'production' }), NOW, MAX_AGE_MS);

    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('cohort');
    expect(payload?.metadata).not.toHaveProperty('cohort');
  });

  it('carries a stamped schema URL to the row as metadata.schemaUrl', () => {
    const schemaUrl = 'https://integritystudio.ai/schemas/evaluation/1.0.0';
    const { payload } = mapRecord(record({ [SESSION_ATTRIBUTES.ID]: 'sess-1' }, { schemaUrl }), NOW, MAX_AGE_MS);

    expect(payload?.metadata).toMatchObject({ schemaUrl });
    expect(payload).not.toHaveProperty('schemaUrl');
  });

  it('writes no metadata.schemaUrl for a record written before the stamp existed', () => {
    const { payload } = mapRecord(record({ [SESSION_ATTRIBUTES.ID]: 'sess-1' }), NOW, MAX_AGE_MS);

    expect(payload?.metadata).not.toHaveProperty('schemaUrl');
  });

  it('sends the judge model as its own field, not inside metadata', () => {
    const { payload } = mapRecord(record({
      'integritystudio.evaluation.evaluator.kind': 'llm',
      'integritystudio.evaluation.judge.model': 'claude-haiku-4-5-20251001',
      [SESSION_ATTRIBUTES.ID]: 'sess-1',
    }), NOW, MAX_AGE_MS);

    expect(payload?.judgeModel).toBe('claude-haiku-4-5-20251001');
    expect(payload?.metadata).not.toHaveProperty('judgeModel');
  });

  // COMPAT until 2026-10-29 for its score-unit half: the old gen_ai.evaluation.score.unit key.
  it('maps a derive record that carries only the legacy overloaded evaluator.type', () => {
    const { payload } = mapRecord(record({
      [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR]: 'derive-evaluations',
      [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR_TYPE]: 'rule',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_UNIT]: 'ratio_0_1',
    }), NOW, MAX_AGE_MS);

    expect(payload).toMatchObject({
      evaluator: 'derive-evaluations',
      evaluatorType: 'rule',
      scoreUnit: 'ratio_0_1',
    });
  });

  it('reads the score unit from its integritystudio key, over the old gen_ai key', () => {
    const { payload } = mapRecord(record({
      'integritystudio.evaluation.score.unit': 'seconds',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_UNIT]: 'ratio_0_1',
    }), NOW, MAX_AGE_MS);

    expect(payload?.scoreUnit).toBe('seconds');
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

    const labelled = mapRecord(toOTelRecord({ ...base, scoreLabel: 'fail' }), NOW, MAX_AGE_MS).payload;
    const unlabelled = mapRecord(toOTelRecord(base), NOW, MAX_AGE_MS).payload;

    expect(labelled?.scoreLabel).toBe('fail');
    expect(unlabelled).not.toHaveProperty('scoreLabel');
  });

  it('reads a top-level traceId, as toOTelRecord writes it', () => {
    const { payload } = mapRecord(record({}, { traceId: 'top-level-trace' }), NOW, MAX_AGE_MS);
    expect(payload?.traceId).toBe('top-level-trace');
  });

  it('drops canary records marked by cohort', () => {
    const { skip } = mapRecord(record({ 'integritystudio.evaluation.cohort': 'canary' }), NOW, MAX_AGE_MS);
    expect(skip).toBe('canary');
  });

  it('drops canary records marked by the legacy overloaded field', () => {
    const { skip } = mapRecord(record({ [GENAI_EVALUATION_ATTRIBUTES.EVALUATOR_TYPE]: 'canary' }), NOW, MAX_AGE_MS);
    expect(skip).toBe('canary');
  });

  it('drops records older than the max age rather than mis-dating them', () => {
    const old = {
      timestamp: '2026-09-01T00:00:00.000Z',
      name: EVALUATION_RESULT_EVENT,
      attributes: { [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'relevance', [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 1 },
    };
    expect(mapRecord(old, NOW, MAX_AGE_MS).skip).toBe('too-old');
  });

  it('drops non-evaluation lines', () => {
    expect(mapRecord({ name: 'something.else' }, NOW, MAX_AGE_MS).skip).toBe('not-an-evaluation');
    expect(mapRecord(null, NOW, MAX_AGE_MS).skip).toBe('not-an-evaluation');
  });

  it('drops records with no numeric score, which the webhook would reject', () => {
    const noScore = {
      timestamp: '2026-09-15T11:00:00.000Z',
      name: EVALUATION_RESULT_EVENT,
      attributes: { [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'relevance' },
    };
    expect(mapRecord(noScore, NOW, MAX_AGE_MS).skip).toBe('no-score');
  });

  it('truncates an over-long explanation to the webhook cap', () => {
    const { payload } = mapRecord(
      record({ [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'x'.repeat(5000) }),
      NOW,
      MAX_AGE_MS,
    );
    expect(payload?.explanation).toHaveLength(2000);
  });

  it('keeps every payload under the per-evaluation byte cap', () => {
    const { payload, skip } = mapRecord(
      record({
        [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'n'.repeat(500),
        [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'e'.repeat(9000),
      }),
      NOW,
      MAX_AGE_MS,
    );
    expect(skip).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(10_000);
  });
});

describe('shipped index', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-upload-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips and returns empty when absent or malformed', () => {
    expect(loadShipped(dir)).toEqual({});
    const index: ShippedIndex = { 'evaluations-2026-09-15.jsonl': ['abc123'] };
    saveShipped(dir, index);
    expect(loadShipped(dir)).toEqual(index);

    writeFileSync(join(dir, '.eval-upload-state.json'), 'not json');
    expect(loadShipped(dir)).toEqual({});
  });

  it('discards non-array and non-string entries', () => {
    writeFileSync(join(dir, '.eval-upload-state.json'), JSON.stringify({ a: 'x', b: ['ok', 7] }));
    expect(loadShipped(dir)).toEqual({ b: ['ok'] });
  });

  it('leaves no temp file behind, so a partial write cannot be read as state', () => {
    saveShipped(dir, { 'evaluations-2026-09-15.jsonl': ['x'] });
    expect(() => readFileSync(join(dir, '.eval-upload-state.json.tmp'))).toThrow();
  });

  it('prunes files that have aged out of the window', () => {
    const index: ShippedIndex = {
      'evaluations-2026-09-15.jsonl': ['keep'],
      'evaluations-2026-08-01.jsonl': ['drop'],
    };
    expect(pruneShipped(index, 2, NOW)).toEqual({ 'evaluations-2026-09-15.jsonl': ['keep'] });
  });

  it("drops state for derive's retired files, even inside the window (Phase 6)", () => {
    const index: ShippedIndex = {
      'evaluations-2026-09-15.jsonl': ['keep'],
      'derived-evaluations-2026-09-15.jsonl': ['retired'],
    };
    expect(pruneShipped(index, 2, NOW)).toEqual({ 'evaluations-2026-09-15.jsonl': ['keep'] });
  });
});

describe('fingerprint', () => {
  it('is stable for identical content and insensitive to surrounding whitespace', () => {
    const line = '{"name":"gen_ai.evaluation.result"}';
    expect(fingerprint(line)).toBe(fingerprint(`  ${line}\n`));
  });

  it('differs for different content', () => {
    expect(fingerprint('{"a":1}')).not.toBe(fingerprint('{"a":2}'));
  });

  it('survives derive rewriting a file with the same records in a new order', () => {
    // derive emits rule lines BEFORE preserved ones, so record positions shift
    // between runs. Identity must come from content, never position.
    const a = '{"r":"rule"}';
    const b = '{"r":"judged"}';
    const before = [a, b];
    const after = [b, a];
    expect(new Set(before.map(fingerprint))).toEqual(new Set(after.map(fingerprint)));
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
    expect(mapRecord(r, NOW, MAX_AGE_MS).payload?.evaluationId).toBe(evaluationId(r));
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
});

describe('windowFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-upload-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, bytes: number): void => writeFileSync(join(dir, name), 'x'.repeat(bytes));

  it('selects evaluation files inside the day window, oldest first', () => {
    write('evaluations-2026-09-15.jsonl', 10);
    write('evaluations-2026-09-14.jsonl', 10);
    expect(windowFiles(dir, 2, NOW)).toEqual([
      'evaluations-2026-09-14.jsonl',
      'evaluations-2026-09-15.jsonl',
    ]);
  });

  it('excludes files outside the window', () => {
    write('evaluations-2026-09-15.jsonl', 10);
    write('evaluations-2026-08-01.jsonl', 10);
    expect(windowFiles(dir, 2, NOW)).toEqual(['evaluations-2026-09-15.jsonl']);
  });

  it('ignores traces/logs/metrics files — those belong to the span shipper', () => {
    write('traces-2026-09-15.jsonl', 10);
    write('logs-2026-09-15.jsonl', 10);
    write('metrics-2026-09-15.jsonl', 10);
    expect(windowFiles(dir, 2, NOW)).toEqual([]);
  });

  it("ignores derive's retired files: derive posts its own records (Phase 6)", () => {
    write('evaluations-2026-09-15.jsonl', 10);
    write('derived-evaluations-2026-09-15.jsonl', 10);
    expect(windowFiles(dir, 2, NOW)).toEqual(['evaluations-2026-09-15.jsonl']);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    expect(windowFiles(join(dir, 'nope'), 2, NOW)).toEqual([]);
  });
});

describe('account index (TKR7/TKR9)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-accounts-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const GMAIL_REF = 'OBTOOL_API_KEY_ALYSHIA_LEDLIE';

  const span = (spanId: string, sessionId: string, ref?: string | null): string => JSON.stringify({
    spanId,
    attributes: { [SESSION_ATTRIBUTES.ID]: sessionId },
    ...(ref === undefined ? {} : { identityKeyRef: ref }),
  });
  const writeTraces = (name: string, lines: string[]): void =>
    writeFileSync(join(dir, name), lines.join('\n') + '\n');

  it('indexes stamped spans by span id', () => {
    writeTraces('traces-2026-09-15.jsonl', [span('sp1', 's1', GMAIL_REF)]);
    const index = buildAccountIndex(dir, 7, NOW);
    expect(index.bySpan.get('sp1')).toBe(GMAIL_REF);
  });

  it('skips a line that parses to something other than an object', () => {
    // A JSONL line can hold any JSON value; without the object guard one
    // malformed line takes the whole index down.
    writeTraces('traces-2026-09-15.jsonl', [
      JSON.stringify('identityKeyRef'),
      span('sp1', 's1', GMAIL_REF),
    ]);
    const index = buildAccountIndex(dir, 7, NOW);
    expect(index.bySpan.get('sp1')).toBe(GMAIL_REF);
  });

  it('ignores trace files outside the index window and evaluation files', () => {
    writeTraces('traces-2026-08-01.jsonl', [span('sp-old', 's-old', GMAIL_REF)]);
    writeTraces('evaluations-2026-09-15.jsonl', [span('sp-eval', 's-eval', GMAIL_REF)]);
    const index = buildAccountIndex(dir, 7, NOW);
    expect(index.bySpan.size).toBe(0);
  });

  it('builds a keyed backfill request the ingest drain reads line by line', () => {
    const payload = (extra: Partial<EvaluationPayload>): EvaluationPayload => ({
      evaluationName: 'relevance', evaluator: 'judge', evaluatorType: 'llm', scoreValue: 4, ...extra,
    });
    const req = keyedRequest('https://ingest.example', [payload({ traceId: 'a' }), payload({ traceId: 'b' })], 'k');
    expect(req.url).toBe('https://ingest.example/v1/ingest/backfill?signal=evaluations');
    expect(req.headers).toEqual({ 'Content-Type': 'application/x-ndjson', Authorization: 'Bearer k' });
    const lines = req.body.trimEnd().split('\n').map((l) => JSON.parse(l) as { traceId: string });
    expect(lines.map((l) => l.traceId)).toEqual(['a', 'b']);
  });
});

describe('MAX_EVALUATION_BYTES mirrored from the ingest worker', () => {
  // The other webhook caps come from src/lib/core/obtool-contract.ts. This one
  // is still module-private in the ingest worker, so the uploader copies it and
  // this test keeps the copy honest: if the worker tightens it, the uploader
  // starts sending payloads the worker rejects, and nothing else would catch it.
  it('matches services/obtool-ingest/src/evaluations.ts', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../services/obtool-ingest/src/evaluations.ts'),
      'utf8',
    );
    const uploader = readFileSync(resolve(__dirname, '../upload-evaluations.ts'), 'utf8');

    const pattern = /const MAX_EVALUATION_BYTES = ([0-9_]+)/;
    const fromSource = pattern.exec(source)?.[1];
    expect(fromSource, 'MAX_EVALUATION_BYTES not found in ingest worker').toBeDefined();
    expect(pattern.exec(uploader)?.[1], 'MAX_EVALUATION_BYTES not found in uploader').toBe(fromSource);
  });
});

describe('network failure handling', () => {
  // Regression guard for three defects the first cut of this script had:
  // a thrown fetch escaped past saveShipped (losing fingerprints for batches
  // already delivered, which the next run re-sends as DUPLICATES, since the
  // evaluations INSERT keys on a per-POST r2_key); no retry, so one blip
  // aborted a 49-batch run; and no timeout, so a hung connection stalled it.
  const SCRIPT = readFileSync(resolve(__dirname, '../upload-evaluations.ts'), 'utf8');

  it('never lets a transport error escape as an exception', () => {
    // postBatchOnce must convert a thrown fetch into a returned result.
    const once = SCRIPT.slice(SCRIPT.indexOf('async function postBatchOnce'));
    const body = once.slice(0, once.indexOf('\n}\n'));
    expect(body).toContain('try {');
    expect(body).toContain('catch');
    expect(body).toMatch(/retryable:\s*true/);
  });

  it('persists the shipped index on every exit path, not just clean ones', () => {
    // A trailing saveShipped is not enough — it must be in a finally block.
    expect(SCRIPT).toMatch(/finally\s*\{\s*\n\s*if \(!opts\.dryRun\) saveShipped/);
  });

  it('retries transient failures and logs once on exhaustion', () => {
    const retry = SCRIPT.slice(SCRIPT.indexOf('async function postBatch(request'));
    const body = retry.slice(0, retry.indexOf('\n}\n'));
    expect(body).toContain('MAX_SEND_ATTEMPTS');
    expect(body).toMatch(/console\.error\(`\[upload-evaluations\] giving up/);
  });

  it('retries throttling and server faults but not payload rejections', () => {
    // A 400 means the same bytes will be rejected again — retrying wastes the
    // budget and delays the real error reaching the operator.
    expect(SCRIPT).toMatch(/response\.status === 429 \|\| response\.status >= 500/);
  });

  it('bounds every request with a timeout', () => {
    expect(SCRIPT).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
  });
});

// --only-keys: re-ship exactly the records deleted from D1 in the builtin.*
// key cleanup (docs/roadmap/builtin-key-eval-cleanup.md).
describe('parseKeyManifest', () => {
  const line = (e: Record<string, unknown>): string => JSON.stringify(e);
  const entry = { ref: 'OBTOOL_API_KEY', evaluationName: 'tool_correctness', traceId: 't1', evaluatedAtMs: 1_790_553_614_235 };

  it('maps each entry to its account ref, skipping blank lines', () => {
    const manifest = parseKeyManifest(`${line(entry)}\n\n${line({ ...entry, ref: 'OBTOOL_API_KEY_B', traceId: 't2' })}\n`);

    expect([...manifest]).toEqual([
      [manifestKey('tool_correctness', 't1', 1_790_553_614_235), 'OBTOOL_API_KEY'],
      [manifestKey('tool_correctness', 't2', 1_790_553_614_235), 'OBTOOL_API_KEY_B'],
    ]);
  });

  it('accepts an empty trace id, which pre-span-id rows carry', () => {
    expect(parseKeyManifest(line({ ...entry, traceId: '' })).size).toBe(1);
  });

  it.each([
    ['a ref that is not an identity-map name', { ...entry, ref: 'CLOUDFLARE_API_TOKEN' }],
    ['a missing event time', { ...entry, evaluatedAtMs: undefined }],
    ['a fractional event time', { ...entry, evaluatedAtMs: 1.5 }],
    ['an empty evaluation name', { ...entry, evaluationName: '' }],
  ])('rejects the whole manifest on %s, naming the line', (_label, bad) => {
    expect(() => parseKeyManifest(`${line(entry)}\n${line(bad)}`)).toThrow('manifest line 2');
  });

  it('rejects a line that is not JSON', () => {
    expect(() => parseKeyManifest('{not json')).toThrow();
  });
});

describe('payloadManifestKey', () => {
  it('keys a derive record exactly as its D1 row is keyed (name, trace, event time in ms)', () => {
    const span = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '00000000000000a1',
      name: 'hook:builtin-post-tool',
      startTime: [1_790_553_614, 235_000_000] as [number, number],
      endTime: [1_790_553_614, 236_463_666] as [number, number],
      duration: [0, 1_463_666] as [number, number],
      attributes: { [SESSION_ATTRIBUTES.ID]: 's1', [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Bash', 'integritystudio.tool.success': true },
    };
    const line = JSON.stringify(toOTelRecord(deriveToolCorrectness(span)!));

    const { payload } = mapRecord(JSON.parse(line), NOW, Number.POSITIVE_INFINITY);

    // A D1 row stores timestamp_ns = evaluatedAtMs * 1e6; the manifest carries that in ms.
    expect(payloadManifestKey(payload!)).toBe(manifestKey('tool_correctness', '0123456789abcdef0123456789abcdef', 1_790_553_614_235));
  });

  it('is undefined for a payload with no event time', () => {
    expect(payloadManifestKey({ evaluationName: 'x', evaluator: 'rule', evaluatorType: 'rule', scoreValue: 1 })).toBeUndefined();
  });
});

describe('main command line', () => {
  it.each([['--days=abc'], ['--limit=0'], ['--max-age-hours=-1'], ['--dry-run=1']])(
    'refuses %s with exit 1 before reading or sending anything',
    async (flag) => {
      expect(await main([flag])).toBe(1);
    },
  );
});
