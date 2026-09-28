import { describe, it, expect } from 'vitest';
import type { TraceSpan } from '../../../src/backends/index.js';
import {
  accountRefsFromEnv,
  dateScopeBounds,
  mergeAccountSpans,
  toLocalTraceSpan,
} from '../cloud-trace-source.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const START_NS = 1_790_553_614_235_000_000n; // 2026-09-28T00:00:14.235Z
const END_NS = START_NS + 1_463_666n;
const SCOPE = new Set(['2026-09-28']);

function cloudSpan(spanId: string, overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: TRACE_ID,
    spanId,
    name: 'hook:builtin-post-tool',
    kind: 'INTERNAL',
    startTimeUnixNano: START_NS,
    endTimeUnixNano: END_NS,
    status: { code: 'OK' },
    statusCode: 'OK',
    attributes: { 'session.id': 's1' },
    ...overrides,
  };
}

describe('toLocalTraceSpan', () => {
  it('converts epoch nanos to HRT tuples and the status name to its OTel number', () => {
    expect(toLocalTraceSpan(cloudSpan('00000000000000a1'))).toEqual({
      traceId: TRACE_ID,
      spanId: '00000000000000a1',
      name: 'hook:builtin-post-tool',
      startTime: [1_790_553_614, 235_000_000],
      endTime: [1_790_553_614, 236_463_666],
      duration: [0, 1_463_666],
      status: { code: 1 },
      attributes: { 'session.id': 's1' },
    });
  });

  it('maps ERROR to 2, the code derive treats as a failed agent', () => {
    const span = toLocalTraceSpan(cloudSpan('00000000000000a1', { status: { code: 'ERROR', message: 'boom' } }));

    expect(span?.status).toEqual({ code: 2, message: 'boom' });
  });

  it('gives a span without an end time a zero duration', () => {
    expect(toLocalTraceSpan(cloudSpan('00000000000000a1', { endTimeUnixNano: undefined }))?.duration).toEqual([0, 0]);
  });

  it('defaults missing attributes to an empty object', () => {
    expect(toLocalTraceSpan(cloudSpan('00000000000000a1', { attributes: undefined }))?.attributes).toEqual({});
  });
});

describe('mergeAccountSpans', () => {
  it('orders spans ascending by start time across accounts and stamps each with its account', () => {
    const later = cloudSpan('00000000000000b2', { startTimeUnixNano: START_NS + 1_000n });
    const earlier = cloudSpan('00000000000000a1');

    const merged = mergeAccountSpans([
      { ref: 'OBTOOL_API_KEY', spans: [later] },
      { ref: 'OBTOOL_API_KEY_OTHER', spans: [earlier] },
    ], SCOPE);

    expect(merged.spans.map(s => s.spanId)).toEqual(['00000000000000a1', '00000000000000b2']);
    expect(merged.accounts.get('00000000000000a1')).toBe('OBTOOL_API_KEY_OTHER');
    expect(merged.accounts.get('00000000000000b2')).toBe('OBTOOL_API_KEY');
  });

  it('keeps the first account for a span two keys can read, and counts it', () => {
    const span = cloudSpan('00000000000000a1');

    const merged = mergeAccountSpans([
      { ref: 'OBTOOL_API_KEY', spans: [span] },
      { ref: 'OBTOOL_API_KEY_OTHER', spans: [span] },
    ], SCOPE);

    expect(merged.spans).toHaveLength(1);
    expect(merged.accounts.get('00000000000000a1')).toBe('OBTOOL_API_KEY');
    expect(merged.duplicates).toBe(1);
  });

  it('drops spans outside the date scope', () => {
    const merged = mergeAccountSpans([{ ref: 'OBTOOL_API_KEY', spans: [cloudSpan('00000000000000a1')] }], new Set(['2026-09-27']));

    expect(merged.spans).toHaveLength(0);
  });

  it('counts and skips a span that fails the local schema', () => {
    const merged = mergeAccountSpans([{ ref: 'OBTOOL_API_KEY', spans: [cloudSpan('not-a-span-id')] }], SCOPE);

    expect(merged.spans).toHaveLength(0);
    expect(merged.rejected).toBe(1);
  });
});

describe('accountRefsFromEnv', () => {
  it('returns only identity-map names with a value, sorted', () => {
    const env = {
      OBTOOL_API_KEY_B: 'k2',
      OBTOOL_API_KEY: 'k1',
      OBTOOL_API_KEY_EMPTY: '',
      OBTOOL_API_URL: 'https://api.example',
      OTHER: 'x',
    };

    expect(accountRefsFromEnv(env)).toEqual(['OBTOOL_API_KEY', 'OBTOOL_API_KEY_B']);
  });
});

describe('dateScopeBounds', () => {
  it('spans from the first date at midnight to the last millisecond of the last date', () => {
    const { fromMs, toMs } = dateScopeBounds(new Set(['2026-09-27', '2026-09-25']));

    expect(new Date(fromMs).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(new Date(toMs).toISOString()).toBe('2026-09-27T23:59:59.999Z');
  });

  it('rejects an empty scope', () => {
    expect(() => dateScopeBounds(new Set())).toThrow('empty date scope');
  });
});
