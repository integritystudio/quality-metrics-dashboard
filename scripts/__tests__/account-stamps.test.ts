import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildAccountIndex, turnAccount, turnSpan, type AccountIndex } from '../account-stamps.js';
import { anchorTurns, turnSourceFields, toOTelRecord, type EvalRecord, type Turn } from '../judge-evaluations.js';
import { deriveEvaluationLatency, setSpanAccounts, type TraceSpan } from '../derive-evaluations.js';
import { fingerprint, mapRecord, routeRecord } from '../upload-evaluations.js';

// TKR8 Phase 1: evaluations carry the account of what they score, and upload
// routes on that stamp instead of joining by trace and time. Phase 2: they also
// name the span they score, and upload can route by that span's stamp.

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const HOME_REF = 'OBTOOL_API_KEY';
const GMAIL_REF = 'OBTOOL_API_KEY_ALYSHIA_LEDLIE';
const SESSION = 's1';

/** Epoch ms for a time on the fixture day. */
const at = (hhmm: string): number => Date.parse(`2026-09-23T${hhmm}:00.000Z`);
const hrTime = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

interface SpanFixture { spanId: string; traceId: string; atMs: number; ref?: string | null; sessionId?: string }

const spanLine = ({ spanId, traceId, atMs, ref, sessionId = SESSION }: SpanFixture): string => JSON.stringify({
  traceId,
  spanId,
  startTime: hrTime(atMs),
  attributes: { 'session.id': sessionId },
  ...(ref === undefined ? {} : { identityKeyRef: ref }),
});

describe('TKR8 Phase 1 — account stamps on evaluations', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tkr8-stamps-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setSpanAccounts(new Map());
  });

  const index = (spans: SpanFixture[]): AccountIndex => {
    writeFileSync(join(dir, 'traces-2026-09-23.jsonl'), spans.map(spanLine).join('\n') + '\n');
    return buildAccountIndex(dir, 7, NOW);
  };

  /** A session that ran `/login` between two turns, both on one trace id. */
  const switchedSession = (): AccountIndex => index([
    { spanId: 'a1', traceId: 't1', atMs: at('10:00'), ref: HOME_REF },
    { spanId: 'a2', traceId: 't1', atMs: at('10:01'), ref: HOME_REF },
    { spanId: 'b1', traceId: 't1', atMs: at('11:00'), ref: GMAIL_REF },
  ]);

  describe('turnAccount', () => {
    it("takes the first stamped span inside the turn's window", () => {
      const idx = switchedSession();
      expect(turnAccount(idx, SESSION, at('09:59'), at('10:59'))).toBe(HOME_REF);
      expect(turnAccount(idx, SESSION, at('10:59'))).toBe(GMAIL_REF);
    });

    it('is undefined when no stamped span falls in the window', () => {
      const idx = switchedSession();
      expect(turnAccount(idx, SESSION, at('10:30'), at('10:45'))).toBeUndefined();
      expect(turnAccount(idx, 'other-session', at('09:00'))).toBeUndefined();
      expect(turnAccount(idx, SESSION, Number.NaN)).toBeUndefined();
    });

    it('keeps a null stamp, which means an unmapped account', () => {
      const idx = index([{ spanId: 'n1', traceId: 't1', atMs: at('10:00'), ref: null }]);
      expect(turnAccount(idx, SESSION, at('09:59'))).toBeNull();
    });

    it('ignores unstamped spans', () => {
      const idx = index([
        { spanId: 'u1', traceId: 't1', atMs: at('10:00') },
        { spanId: 'a1', traceId: 't1', atMs: at('10:05'), ref: HOME_REF },
      ]);
      expect(turnAccount(idx, SESSION, at('09:59'))).toBe(HOME_REF);
      expect(idx.bySpan.has('u1')).toBe(false);
    });
  });

  describe('turnSpan', () => {
    it("returns the first span in the turn's window, stamped or not", () => {
      const idx = index([
        { spanId: 'u1', traceId: 't-turn1', atMs: at('10:00') },
        { spanId: 'a1', traceId: 't-turn1', atMs: at('10:05'), ref: HOME_REF },
        { spanId: 'b1', traceId: 't-turn2', atMs: at('11:00'), ref: GMAIL_REF },
      ]);
      expect(turnSpan(idx, SESSION, at('09:59'), at('10:59'))).toEqual({ spanId: 'u1', traceId: 't-turn1' });
      expect(turnSpan(idx, SESSION, at('10:59'))).toEqual({ spanId: 'b1', traceId: 't-turn2' });
      expect(turnSpan(idx, SESSION, at('11:30'))).toBeUndefined();
    });
  });

  describe('judge: anchorTurns', () => {
    const turn = (timestamp: string, extra: Partial<Turn> = {}): Turn => ({
      sessionId: SESSION, traceId: '', timestamp, userText: 'q', assistantText: 'a', toolResults: [], ...extra,
    });

    it('stamps each turn with its own account across a /login', () => {
      const turns = [turn('2026-09-23T11:00:00.000Z'), turn('2026-09-23T09:59:59.000Z')];
      anchorTurns(turns, switchedSession());
      expect(turns.map((t) => t.identityKeyRef)).toEqual([GMAIL_REF, HOME_REF]);
    });

    it("gives each turn its own trace and span rather than the transcript's shared trace", () => {
      const idx = index([
        { spanId: 's-a', traceId: 't-prompt1', atMs: at('10:00'), ref: HOME_REF },
        { spanId: 's-b', traceId: 't-prompt2', atMs: at('11:00'), ref: HOME_REF },
      ]);
      const turns = [turn('2026-09-23T09:59:59.000Z'), turn('2026-09-23T10:59:59.000Z')];
      anchorTurns(turns, idx);
      expect(turns.map((t) => [t.traceId, t.spanId])).toEqual([['t-prompt1', 's-a'], ['t-prompt2', 's-b']]);
    });

    it('leaves a turn with no covering span unanchored', () => {
      const t = turn('2026-09-23T12:30:00.000Z');
      anchorTurns([t], switchedSession());
      expect(t).not.toHaveProperty('identityKeyRef');
      expect(t).not.toHaveProperty('spanId');
      expect(t.traceId).toBe('');
    });

    it('links a record by span, and by response id only when no span is known', () => {
      expect(turnSourceFields(turn('x', { spanId: 's-a', responseId: 'msg_1', identityKeyRef: HOME_REF })))
        .toEqual({ spanId: 's-a', identityKeyRef: HOME_REF });
      expect(turnSourceFields(turn('x', { responseId: 'msg_1' }))).toEqual({ responseId: 'msg_1' });
    });
  });

  describe('toOTelRecord', () => {
    const record = (extra: Partial<EvalRecord>): EvalRecord => ({
      timestamp: '2026-09-23T10:00:00.000Z', evaluationName: 'relevance', scoreValue: 0.8, explanation: 'x',
      evaluator: 'dashboard:judge-evaluations', evaluatorKind: 'llm', cohort: 'normal', traceId: 't1', sessionId: SESSION,
      ...extra,
    });

    it('writes span id then stamp as the last record fields, neither as an attribute', () => {
      const out = toOTelRecord(record({ spanId: 's-a', identityKeyRef: GMAIL_REF })) as Record<string, unknown>;
      expect(Object.keys(out).slice(-2)).toEqual(['spanId', 'identityKeyRef']);
      expect(out.identityKeyRef).toBe(GMAIL_REF);
      expect(out.attributes).not.toHaveProperty('identityKeyRef');
      expect(out.attributes).not.toHaveProperty('spanId');
    });

    it('writes the response id as the semconv attribute', () => {
      const out = toOTelRecord(record({ responseId: 'msg_1' })) as { attributes: Record<string, unknown> };
      expect(out.attributes['gen_ai.response.id']).toBe('msg_1');
    });

    it('writes a null stamp and omits an absent one', () => {
      expect(toOTelRecord(record({ identityKeyRef: null }))).toHaveProperty('identityKeyRef', null);
      expect(toOTelRecord(record({}))).not.toHaveProperty('identityKeyRef');
    });
  });

  describe('derive: span stamps', () => {
    const measurable = (spanId: string): TraceSpan => ({
      traceId: 't1', spanId, name: 'hook:session-start', startTime: [1707400000, 0], duration: [1, 0],
      attributes: { 'session.id': SESSION },
    });

    it("copies the scored span's stamp and leaves an unstamped span's record unstamped", () => {
      setSpanAccounts(new Map([['stamped', GMAIL_REF]]));
      expect(deriveEvaluationLatency(measurable('stamped'))!.identityKeyRef).toBe(GMAIL_REF);
      expect(deriveEvaluationLatency(measurable('bare'))).not.toHaveProperty('identityKeyRef');
    });

    it('names the span it scores', () => {
      expect(deriveEvaluationLatency(measurable('scored'))!.spanId).toBe('scored');
    });
  });

  describe('upload', () => {
    const evalLine = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      timestamp: '2026-09-23T11:30:00.000Z',
      name: 'gen_ai.evaluation.result',
      attributes: { 'gen_ai.evaluation.name': 'relevance', 'gen_ai.evaluation.score.value': 0.8 },
      traceId: 't1',
      ...extra,
    });
    const MAX_AGE_MS = 36 * 3_600_000;

    it("reads the record's stamp for routing but never puts it in the shipped payload", () => {
      const mapped = mapRecord(evalLine({ identityKeyRef: GMAIL_REF }), NOW, MAX_AGE_MS);
      expect(mapped.accountRef).toBe(GMAIL_REF);
      expect(JSON.stringify(mapped.payload)).not.toContain(GMAIL_REF);
    });

    it('routes on the stamp even where the time join would pick another account', () => {
      // Evaluated at 11:30 on a trace whose last stamp is gmail: the join says
      // gmail, but the scored turn was home's.
      const idx = switchedSession();
      const stamped = mapRecord(evalLine({ identityKeyRef: HOME_REF }), NOW, MAX_AGE_MS);
      expect(routeRecord(stamped, idx)).toEqual({ route: { kind: 'keyed', ref: HOME_REF }, basis: 'stamp' });
      const unstamped = mapRecord(evalLine(), NOW, MAX_AGE_MS);
      expect(routeRecord(unstamped, idx)).toEqual({ route: { kind: 'keyed', ref: GMAIL_REF }, basis: 'join' });
    });

    it("routes an unstamped record by its span's stamp before any join", () => {
      // Span a1 is home's; the time join would say gmail (evaluated 11:30).
      const idx = switchedSession();
      const bySpan = mapRecord(evalLine({ spanId: 'a1' }), NOW, MAX_AGE_MS);
      expect(routeRecord(bySpan, idx)).toEqual({ route: { kind: 'keyed', ref: HOME_REF }, basis: 'span' });
      const unknownSpan = mapRecord(evalLine({ spanId: 'not-indexed' }), NOW, MAX_AGE_MS);
      expect(routeRecord(unknownSpan, idx).basis).toBe('join');
    });

    it('forwards the response id in metadata', () => {
      const mapped = mapRecord(evalLine({
        attributes: { 'gen_ai.evaluation.name': 'relevance', 'gen_ai.evaluation.score.value': 0.8, 'gen_ai.response.id': 'msg_1' },
      }), NOW, MAX_AGE_MS);
      expect(mapped.payload!.metadata).toMatchObject({ responseId: 'msg_1' });
    });

    it('withholds a record stamped with an unmapped account', () => {
      const mapped = mapRecord(evalLine({ identityKeyRef: null }), NOW, MAX_AGE_MS);
      expect(routeRecord(mapped, switchedSession())).toEqual({ route: { kind: 'withheld' }, basis: 'stamp' });
    });

    it('fingerprints a stamped line the same as the line written before stamping', () => {
      // derive rewrites its rule records every run; a stamp must not make an
      // already-shipped record look new and ship twice.
      const before = JSON.stringify(evalLine());
      const after = JSON.stringify(evalLine({ identityKeyRef: HOME_REF }));
      expect(fingerprint(after)).toBe(fingerprint(before));
      const withSpan = JSON.stringify(evalLine({ spanId: 's-a', identityKeyRef: HOME_REF }));
      expect(fingerprint(withSpan)).toBe(fingerprint(before));
      expect(fingerprint(JSON.stringify(evalLine({ traceId: 't2' })))).not.toBe(fingerprint(before));
    });
  });
});
