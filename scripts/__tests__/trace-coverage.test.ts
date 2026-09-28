import { describe, it, expect } from 'vitest';
import {
  compareAccount,
  coverageWindow,
  parseArgs,
  parseLocalSpan,
  spanKey,
  type LocalSpan,
} from '../trace-coverage.js';

const DAY_1_NOON_MS = Date.parse('2026-09-26T12:00:00.000Z');
const DAY_2_NOON_MS = Date.parse('2026-09-27T12:00:00.000Z');
const WIDE_WINDOW = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
const REF = 'OBTOOL_API_KEY';

function localSpan(id: string, startMs: number, sessionId = 's1'): LocalSpan {
  return { key: spanKey('t1', id), ref: REF, startMs, sessionId };
}

function jsonLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    traceId: 't1',
    spanId: 'a1',
    startTime: [DAY_1_NOON_MS / 1000, 0],
    attributes: { 'session.id': 's1' },
    identityKeyRef: REF,
    ...fields,
  });
}

describe('coverageWindow', () => {
  it('starts at UTC midnight days-1 back and ends settleMinutes before now', () => {
    const window = coverageWindow(DAY_2_NOON_MS, 2, 60);

    expect(new Date(window.fromMs).toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(new Date(window.toMs).toISOString()).toBe('2026-09-27T11:00:00.000Z');
  });
});

describe('parseLocalSpan', () => {
  it('reads key, stamp, start time and session', () => {
    expect(parseLocalSpan(jsonLine({}), WIDE_WINDOW)).toEqual({
      key: 't1:a1', ref: REF, startMs: DAY_1_NOON_MS, sessionId: 's1',
    });
  });

  it('keeps an unstamped span with a null ref', () => {
    expect(parseLocalSpan(jsonLine({ identityKeyRef: null }), WIDE_WINDOW)?.ref).toBeNull();
  });

  it.each([
    ['blank line', ''],
    ['malformed JSON', '{not json'],
    ['missing spanId', jsonLine({ spanId: undefined })],
    ['malformed startTime', jsonLine({ startTime: 'yesterday' })],
  ])('skips a %s', (_label, line) => {
    expect(parseLocalSpan(line, WIDE_WINDOW)).toBeUndefined();
  });

  it('skips a span outside the window', () => {
    expect(parseLocalSpan(jsonLine({}), { fromMs: DAY_2_NOON_MS, toMs: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  });
});

describe('compareAccount', () => {
  it('counts matched, missing and cloud-only spans per UTC day', () => {
    const local = [localSpan('a', DAY_1_NOON_MS), localSpan('b', DAY_1_NOON_MS), localSpan('c', DAY_2_NOON_MS, 's2')];
    const cloud = new Map([[spanKey('t1', 'a'), DAY_1_NOON_MS], [spanKey('t1', 'z'), DAY_2_NOON_MS]]);

    const result = compareAccount(REF, local, cloud);

    expect(result.days).toEqual([
      { day: '2026-09-26', local: 2, matched: 1, missing: 1, cloudOnly: 0 },
      { day: '2026-09-27', local: 1, matched: 0, missing: 1, cloudOnly: 1 },
    ]);
    expect(result.coverage).toBeCloseTo(1 / 3);
    expect(result.missingBySession).toEqual([{ sessionId: 's1', missing: 1 }, { sessionId: 's2', missing: 1 }]);
  });

  it('counts a span written twice locally once', () => {
    const span = localSpan('a', DAY_1_NOON_MS);

    const result = compareAccount(REF, [span, span], new Map([[span.key, DAY_1_NOON_MS]]));

    expect(result.local).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it('reports full coverage when there is nothing local to compare', () => {
    expect(compareAccount(REF, [], new Map()).coverage).toBe(1);
  });
});

describe('parseArgs', () => {
  it('uses the defaults with no flags', () => {
    expect(parseArgs([])).toEqual({ days: 7, settleMinutes: 60, minCoverage: 0.99, jsonPath: undefined });
  });

  it('reads every flag', () => {
    expect(parseArgs(['--days', '3', '--settle-minutes', '120', '--min-coverage', '0.9', '--json', 'out.json']))
      .toEqual({ days: 3, settleMinutes: 120, minCoverage: 0.9, jsonPath: 'out.json' });
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseArgs(['--days', 'many'])).toThrow('--days');
  });
});
