import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  mapRecord,
  fingerprint,
  loadShipped,
  saveShipped,
  pruneShipped,
  windowFiles,
  type ShippedIndex,
} from '../upload-evaluations.js';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const MAX_AGE_MS = 36 * 3_600_000;

function record(attrs: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-09-15T11:00:00.000Z',
    name: 'gen_ai.evaluation.result',
    attributes: {
      'gen_ai.evaluation.name': 'relevance',
      'gen_ai.evaluation.score.value': 0.9,
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
      'session.id': 'sess-1',
      'trace.id': 'trace-1',
      'span.id': 'span-1',
      'gen_ai.evaluation.explanation': 'because',
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
    // Cohort and true evaluation time survive only in metadata — the row's own
    // timestamp is overwritten by the webhook at receipt.
    expect(payload?.metadata).toMatchObject({ cohort: 'normal', evaluatedAt: '2026-09-15T11:00:00.000Z' });
  });

  it('maps a derive record that carries only the legacy overloaded evaluator.type', () => {
    const { payload } = mapRecord(record({
      'gen_ai.evaluation.evaluator': 'derive-evaluations',
      'gen_ai.evaluation.evaluator.type': 'rule',
      'gen_ai.evaluation.score.unit': 'ratio_0_1',
    }), NOW, MAX_AGE_MS);

    expect(payload).toMatchObject({
      evaluator: 'derive-evaluations',
      evaluatorType: 'rule',
      scoreUnit: 'ratio_0_1',
    });
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
    const { skip } = mapRecord(record({ 'gen_ai.evaluation.evaluator.type': 'canary' }), NOW, MAX_AGE_MS);
    expect(skip).toBe('canary');
  });

  it('drops records older than the max age rather than mis-dating them', () => {
    const old = {
      timestamp: '2026-09-01T00:00:00.000Z',
      name: 'gen_ai.evaluation.result',
      attributes: { 'gen_ai.evaluation.name': 'relevance', 'gen_ai.evaluation.score.value': 1 },
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
      name: 'gen_ai.evaluation.result',
      attributes: { 'gen_ai.evaluation.name': 'relevance' },
    };
    expect(mapRecord(noScore, NOW, MAX_AGE_MS).skip).toBe('no-score');
  });

  it('truncates an over-long explanation to the webhook cap', () => {
    const { payload } = mapRecord(
      record({ 'gen_ai.evaluation.explanation': 'x'.repeat(5000) }),
      NOW,
      MAX_AGE_MS,
    );
    expect(payload?.explanation).toHaveLength(2000);
  });

  it('keeps every payload under the per-evaluation byte cap', () => {
    const { payload, skip } = mapRecord(
      record({
        'gen_ai.evaluation.name': 'n'.repeat(500),
        'gen_ai.evaluation.explanation': 'e'.repeat(9000),
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

  it('returns empty for a missing directory rather than throwing', () => {
    expect(windowFiles(join(dir, 'nope'), 2, NOW)).toEqual([]);
  });
});

describe('webhook caps mirrored from the ingest worker', () => {
  // These four are module-private in services/obtool-ingest/src/evaluations.ts,
  // so upload-evaluations.ts copies them. This test is what keeps the copy
  // honest: if the worker tightens a cap, the uploader starts sending payloads
  // the worker rejects, and nothing else would catch it.
  it('match services/obtool-ingest/src/evaluations.ts', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../services/obtool-ingest/src/evaluations.ts'),
      'utf8',
    );
    const uploader = readFileSync(resolve(__dirname, '../upload-evaluations.ts'), 'utf8');

    for (const name of [
      'MAX_BATCH_SIZE',
      'MAX_EVALUATION_BYTES',
      'WEBHOOK_MAX_NAME_LENGTH',
      'WEBHOOK_MAX_EXPLANATION_LENGTH',
    ]) {
      const pattern = new RegExp(`const ${name} = ([0-9_]+)`);
      const fromSource = pattern.exec(source)?.[1];
      const fromUploader = pattern.exec(uploader)?.[1];
      expect(fromSource, `${name} not found in ingest worker`).toBeDefined();
      expect(fromUploader, `${name} not found in uploader`).toBe(fromSource);
    }
  });
});
