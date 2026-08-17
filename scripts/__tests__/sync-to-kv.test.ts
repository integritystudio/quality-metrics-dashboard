import { describe, it, expect } from 'vitest';
import { buildCalibrationEntry, TRACE_KEY_TTL_SECONDS, SESSION_KEY_TTL_SECONDS } from '../sync-to-kv.js';
import type { CalibrationState } from '@parent/lib/quality/qfe-percentiles.js';
import type { CalibrationResponse } from '../../src/lib/validation/dashboard-schemas.js';
import { SECONDS } from '../../../src/lib/core/units.js';

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
    expect(Object.keys(response.distributions.relevance).sort())
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
  it('TRACE_KEY_TTL_SECONDS is a positive integer (required by Cloudflare KV)', () => {
    expect(Number.isInteger(TRACE_KEY_TTL_SECONDS)).toBe(true);
    expect(TRACE_KEY_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('SESSION_KEY_TTL_SECONDS is a positive integer (required by Cloudflare KV)', () => {
    expect(Number.isInteger(SESSION_KEY_TTL_SECONDS)).toBe(true);
    expect(SESSION_KEY_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('TRACE_KEY_TTL_SECONDS exceeds the default 30-day query window', () => {
    // Default --days=30 window; TTL must be longer than the query window so entries
    // are not expired before the next sync rewrites them.
    const DEFAULT_QUERY_WINDOW_DAYS = 30;
    expect(TRACE_KEY_TTL_SECONDS).toBeGreaterThan(DEFAULT_QUERY_WINDOW_DAYS * SECONDS.DAY);
  });

  it('SESSION_KEY_TTL_SECONDS exceeds the default 30-day query window', () => {
    const DEFAULT_QUERY_WINDOW_DAYS = 30;
    expect(SESSION_KEY_TTL_SECONDS).toBeGreaterThan(DEFAULT_QUERY_WINDOW_DAYS * SECONDS.DAY);
  });

  it('TRACE_KEY_TTL_SECONDS is exactly 90 days in seconds', () => {
    expect(TRACE_KEY_TTL_SECONDS).toBe(90 * SECONDS.DAY);
  });

  it('SESSION_KEY_TTL_SECONDS is exactly 90 days in seconds', () => {
    expect(SESSION_KEY_TTL_SECONDS).toBe(90 * SECONDS.DAY);
  });
});

describe('org-scoped key helpers (P4)', () => {
  const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';

  it('orgPrefixedKey builds org:<uuid>:<key>', async () => {
    const { orgPrefixedKey } = await import('../sync-to-kv.js');
    expect(orgPrefixedKey(ORG, 'dashboard:7d')).toBe(`org:${ORG}:dashboard:7d`);
  });

  it('stripOrgPrefix removes exactly one org prefix and leaves bare keys alone', async () => {
    const { orgPrefixedKey, stripOrgPrefix } = await import('../sync-to-kv.js');
    expect(stripOrgPrefix(orgPrefixedKey(ORG, 'trend:relevance:7d'))).toBe('trend:relevance:7d');
    expect(stripOrgPrefix('dashboard:7d')).toBe('dashboard:7d');
    // A non-uuid "org:" segment is data, not a scope prefix — must not be stripped.
    expect(stripOrgPrefix('org:not-a-uuid:dashboard:7d')).toBe('org:not-a-uuid:dashboard:7d');
  });

  it('system:lastSync is a bare global key, never org-prefixed', async () => {
    const { SYSTEM_LAST_SYNC_KEY, ORG_KEY_PREFIX_RE } = await import('../sync-to-kv.js');
    expect(ORG_KEY_PREFIX_RE.test(SYSTEM_LAST_SYNC_KEY)).toBe(false);
  });
});

describe('prioritizeTraces with org-prefixed keys (P4)', () => {
  const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';

  it('groups the org-prefixed and bare entries of one trace as a single unit', async () => {
    const { prioritizeTraces } = await import('../sync-to-kv.js');
    const entries = [
      { key: `org:${ORG}:evaluations:trace:t1`, value: '{}' },
      { key: `org:${ORG}:trace:t1`, value: '{}' },
      { key: 'evaluations:trace:t1', value: '{}' },
      { key: 'trace:t1', value: '{}' },
    ];
    const result = prioritizeTraces(entries, new Map(), new Set());
    // All four entries survive, contiguously — one trace, one priority group.
    expect(result).toHaveLength(4);
    expect(new Set(result.map(e => e.key))).toEqual(new Set(entries.map(e => e.key)));
  });
});
