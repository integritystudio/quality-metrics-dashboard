import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCalibrationEntry,
  buildTraceEntries,
  loadCalibrationEntry,
  orgPrefixedKey,
  ORG_KEY_PREFIX_RE,
  SESSION_KEY_TTL_SECONDS,
  stripOrgPrefix,
  SYSTEM_LAST_SYNC_KEY,
  toKVValue,
  TRACE_KEY_TTL_SECONDS,
} from '../sync-to-kv.js';
import { CALIBRATION_STATE_DIR } from '../evaluation-constants.js';
import { loadCalibrationState, saveCalibrationState } from '../../../src/lib/quality/qfe-percentiles.js';
import type { CalibrationState } from '@parent/lib/quality/qfe-percentiles.js';
import type { EvaluationResult, TraceSpan } from '../../../src/backends/index.js';
import type { CalibrationResponse } from '../../src/lib/validation/dashboard-schemas.js';
import { SECONDS } from '../../../src/lib/core/units.js';

vi.mock('../../../src/lib/quality/qfe-percentiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/quality/qfe-percentiles.js')>();
  return { ...actual, loadCalibrationState: vi.fn(actual.loadCalibrationState) };
});

/**
 * Parse the entry's value as the type `useCalibration` actually receives.
 *
 * The dashboard is the only consumer of `meta:calibration`, so asserting
 * against its `CalibrationResponse` — rather than the `any` that `JSON.parse`
 * hands back — makes these producer↔consumer contract tests: adding a required
 * field on the consumer side without emitting it here fails the typecheck.
 *
 * The intersection keeps `rawScores`/`psiValues` addressable so the "these are
 * dropped" cases can still assert on keys absent from the contract.
 */
function parseCalibrationPayload(
  state: CalibrationState | null,
): CalibrationResponse & Record<string, unknown> {
  const entry = buildCalibrationEntry(state);
  if (!entry) throw new Error('expected buildCalibrationEntry to produce an entry');
  return JSON.parse(entry.value) as CalibrationResponse & Record<string, unknown>;
}

function makeCalibrationState(overrides: Partial<CalibrationState> = {}): CalibrationState {
  return {
    lastCalibrated: '2026-03-15T10:00:00.000Z',
    distributions: {
      relevance: {
        distribution: { p10: 0.3, p25: 0.5, p50: 0.7, p75: 0.85, p90: 0.95 },
        sampleSize: 120,
        windowStart: '2026-02-13T10:00:00.000Z',
        windowEnd: '2026-03-15T10:00:00.000Z',
      },
      faithfulness: {
        distribution: { p10: 0.4, p25: 0.6, p50: 0.75, p75: 0.88, p90: 0.96 },
        sampleSize: 85,
        windowStart: '2026-02-13T10:00:00.000Z',
        windowEnd: '2026-03-15T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('buildCalibrationEntry', () => {
  it('produces a meta:calibration KV entry from valid CalibrationState', () => {
    const state = makeCalibrationState();

    const entry = buildCalibrationEntry(state);

    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('meta:calibration');
  });

  it('entry value is valid JSON', () => {
    const state = makeCalibrationState();

    const parsed = parseCalibrationPayload(state);

    expect(parsed).toBeDefined();
  });

  it('transforms distributions to flat PercentileDistribution records (drops window metadata)', () => {
    const state = makeCalibrationState();

    const response = parseCalibrationPayload(state);

    // distributions should map metricName → PercentileDistribution (no sampleSize/windowStart/windowEnd)
    expect(response.distributions).toBeDefined();
    expect(response.distributions.relevance).toEqual({
      p10: 0.3, p25: 0.5, p50: 0.7, p75: 0.85, p90: 0.95,
    });
    expect(response.distributions.faithfulness).toEqual({
      p10: 0.4, p25: 0.6, p50: 0.75, p75: 0.88, p90: 0.96,
    });
    // sampleSize and window metadata must NOT be on the distribution objects.
    // Asserting the exact key set rather than probing two names: it also catches
    // any other CalibrationState field that starts leaking through.
    expect(Object.keys(response.distributions.relevance!).sort())
      .toEqual(['p10', 'p25', 'p50', 'p75', 'p90']);
  });

  it('extracts sampleCounts as a flat Record<string, number>', () => {
    const state = makeCalibrationState();

    const response = parseCalibrationPayload(state);

    expect(response.sampleCounts).toBeDefined();
    expect(response.sampleCounts.relevance).toBe(120);
    expect(response.sampleCounts.faithfulness).toBe(85);
  });

  it('preserves lastCalibrated timestamp verbatim', () => {
    const state = makeCalibrationState({
      lastCalibrated: '2026-03-10T08:30:00.000Z',
    });

    const response = parseCalibrationPayload(state);

    expect(response.lastCalibrated).toBe('2026-03-10T08:30:00.000Z');
  });

  it('drops rawScores from the response payload', () => {
    const state = makeCalibrationState({
      rawScores: { relevance: [0.5, 0.7, 0.8] },
    });

    const response = parseCalibrationPayload(state);

    expect(response.rawScores).toBeUndefined();
  });

  it('drops psiValues from the response payload', () => {
    const state = makeCalibrationState({
      psiValues: { relevance: 0.04 },
    });

    const response = parseCalibrationPayload(state);

    expect(response.psiValues).toBeUndefined();
  });

  it('handles CalibrationState with a single metric', () => {
    const state: CalibrationState = {
      lastCalibrated: '2026-03-01T00:00:00.000Z',
      distributions: {
        coherence: {
          distribution: { p10: 0.2, p25: 0.45, p50: 0.65, p75: 0.8, p90: 0.92 },
          sampleSize: 50,
          windowStart: '2026-02-01T00:00:00.000Z',
          windowEnd: '2026-03-01T00:00:00.000Z',
        },
      },
    };

    const response = parseCalibrationPayload(state);

    expect(Object.keys(response.distributions)).toHaveLength(1);
    expect(response.sampleCounts.coherence).toBe(50);
  });
});

describe('buildCalibrationEntry: graceful skip on missing or invalid state', () => {
  it('returns null when given null (file not found)', () => {
    const result = buildCalibrationEntry(null);

    expect(result).toBeNull();
  });

  it('returns null when given undefined', () => {
    const result = buildCalibrationEntry(undefined as unknown as null);

    expect(result).toBeNull();
  });

  it('returns null when distributions is an empty object', () => {
    const state = makeCalibrationState({ distributions: {} });

    const result = buildCalibrationEntry(state);

    expect(result).toBeNull();
  });
});

describe('KV trace/session TTL constants', () => {
  const TTL_DAYS = 90;
  // Default --days=30 window; a TTL longer than it keeps entries alive until the next sync rewrites them.
  const DEFAULT_QUERY_WINDOW_DAYS = 30;
  const ttls = [
    ['TRACE_KEY_TTL_SECONDS', TRACE_KEY_TTL_SECONDS],
    ['SESSION_KEY_TTL_SECONDS', SESSION_KEY_TTL_SECONDS],
  ] as const;

  it.each(ttls)('%s is a positive integer (required by Cloudflare KV)', (_name, ttl) => {
    expect(Number.isInteger(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(0);
  });

  it.each(ttls)('%s exceeds the default 30-day query window', (_name, ttl) => {
    expect(ttl).toBeGreaterThan(DEFAULT_QUERY_WINDOW_DAYS * SECONDS.DAY);
  });

  it.each(ttls)('%s is exactly 90 days in seconds', (_name, ttl) => {
    expect(ttl).toBe(TTL_DAYS * SECONDS.DAY);
  });
});

describe('org-scoped key helpers (P4)', () => {
  const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';

  it('orgPrefixedKey builds org:<uuid>:<key>', () => {
    expect(orgPrefixedKey(ORG, 'dashboard:7d')).toBe(`org:${ORG}:dashboard:7d`);
  });

  it('stripOrgPrefix removes exactly one org prefix and leaves bare keys alone', () => {
    expect(stripOrgPrefix(orgPrefixedKey(ORG, 'trend:relevance:7d'))).toBe('trend:relevance:7d');
    expect(stripOrgPrefix('dashboard:7d')).toBe('dashboard:7d');
    // A non-uuid "org:" segment is data, not a scope prefix — must not be stripped.
    expect(stripOrgPrefix('org:not-a-uuid:dashboard:7d')).toBe('org:not-a-uuid:dashboard:7d');
  });

  it('system:lastSync is a bare global key, never org-prefixed', () => {
    expect(ORG_KEY_PREFIX_RE.test(SYSTEM_LAST_SYNC_KEY)).toBe(false);
  });
});

describe('buildTraceEntries with bigint timestamps (SYNC-KV-BIGINT)', () => {
  const TRACE_ID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';

  // Typed off the backend contract: CloudBackend builds these fields with
  // BigInt(...) — plain-number fixtures are exactly how this bug stayed hidden.
  const span: TraceSpan = {
    traceId: TRACE_ID,
    spanId: 'a1b2c3d4e5f60718',
    name: 'test-span',
    kind: 'INTERNAL',
    startTimeUnixNano: 1755450000000000000n,
    endTimeUnixNano: 1755450001000000000n,
  };
  const evaluation: EvaluationResult = {
    timestamp: 1755450000500000000n,
    evaluationName: 'relevance',
    scoreValue: 0.9,
    traceId: TRACE_ID,
  };

  it('serializes spans and evaluations without throwing', () => {
    const entries = buildTraceEntries(
      [TRACE_ID],
      new Map([[TRACE_ID, [evaluation]]]),
      new Map([[TRACE_ID, [span]]]),
    );

    expect(entries.map(e => e.key)).toEqual([
      `evaluations:trace:${TRACE_ID}`,
      `trace:${TRACE_ID}`,
    ]);
    const trace = JSON.parse(entries[1]!.value) as {
      traceId: string;
      spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }>;
      evaluations: Array<{ timestamp: string }>;
    };
    // bigints land as their decimal-string wire form, which timestampToMs accepts
    expect(trace.spans[0]!.startTimeUnixNano).toBe('1755450000000000000');
    expect(trace.spans[0]!.endTimeUnixNano).toBe('1755450001000000000');
    expect(trace.evaluations[0]!.timestamp).toBe('1755450000500000000');

    const evalsOnly = JSON.parse(entries[0]!.value) as { evaluations: Array<{ timestamp: string }> };
    expect(evalsOnly.evaluations[0]!.timestamp).toBe('1755450000500000000');
  });

  it('toKVValue converts nested bigints anywhere in an entry value', () => {
    expect(JSON.parse(toKVValue({ rows: [{ timestamp: 42n }] }))).toEqual({
      rows: [{ timestamp: '42' }],
    });
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('kv')],
  ])('toKVValue throws on %s, which has no JSON form', (_label, value) => {
    expect(() => toKVValue(value)).toThrow(TypeError);
  });

  it('toKVValue keeps null, which is valid JSON', () => {
    expect(toKVValue(null)).toBe('null');
  });
});

describe('loadCalibrationEntry', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  it("builds meta:calibration from the file derive's own writer produced", () => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    saveCalibrationState(dir, makeCalibrationState({ lastCalibrated: '2026-09-29T00:01:18.387Z' }));

    const entry = loadCalibrationEntry(dir);

    expect(entry?.key).toBe('meta:calibration');
    expect(JSON.parse(entry?.value ?? '{}')).toMatchObject({ lastCalibrated: '2026-09-29T00:01:18.387Z' });
  });

  it('warns and writes nothing when the file is missing, instead of failing silently', () => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadCalibrationEntry(dir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('.calibration-state.json'));
  });

  it('reads from the directory derive writes to by default', () => {
    vi.mocked(loadCalibrationState).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    loadCalibrationEntry();

    expect(vi.mocked(loadCalibrationState)).toHaveBeenCalledWith(CALIBRATION_STATE_DIR);
  });
});
