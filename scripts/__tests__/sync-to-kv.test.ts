import { describe, it, expect } from 'vitest';
import { buildCalibrationEntry } from '../sync-to-kv.js';
import type { CalibrationState } from '../../../dist/lib/quality/quality-feature-engineering.js';

type KVEntry = { key: string; value: string };


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
    expect((entry as KVEntry).key).toBe('meta:calibration');
  });

  it('entry value is valid JSON', () => {
    const state = makeCalibrationState();

    const entry = buildCalibrationEntry(state) as KVEntry;
    const parsed = JSON.parse(entry.value);

    expect(parsed).toBeDefined();
  });

  it('transforms distributions to flat PercentileDistribution records (drops window metadata)', () => {
    const state = makeCalibrationState();

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

    // distributions should map metricName → PercentileDistribution (no sampleSize/windowStart/windowEnd)
    expect(response.distributions).toBeDefined();
    expect(response.distributions.relevance).toEqual({
      p10: 0.3, p25: 0.5, p50: 0.7, p75: 0.85, p90: 0.95,
    });
    expect(response.distributions.faithfulness).toEqual({
      p10: 0.4, p25: 0.6, p50: 0.75, p75: 0.88, p90: 0.96,
    });
    // sampleSize and window metadata must NOT be on the distribution objects
    expect((response.distributions.relevance as Record<string, unknown>).sampleSize).toBeUndefined();
    expect((response.distributions.relevance as Record<string, unknown>).windowStart).toBeUndefined();
  });

  it('extracts sampleCounts as a flat Record<string, number>', () => {
    const state = makeCalibrationState();

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

    expect(response.sampleCounts).toBeDefined();
    expect(response.sampleCounts.relevance).toBe(120);
    expect(response.sampleCounts.faithfulness).toBe(85);
  });

  it('preserves lastCalibrated timestamp verbatim', () => {
    const state = makeCalibrationState({
      lastCalibrated: '2026-03-10T08:30:00.000Z',
    });

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

    expect(response.lastCalibrated).toBe('2026-03-10T08:30:00.000Z');
  });

  it('drops rawScores from the response payload', () => {
    const state = makeCalibrationState({
      rawScores: { relevance: [0.5, 0.7, 0.8] },
    });

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

    expect(response.rawScores).toBeUndefined();
  });

  it('drops psiValues from the response payload', () => {
    const state = makeCalibrationState({
      psiValues: { relevance: 0.04 },
    });

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

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

    const entry = buildCalibrationEntry(state) as KVEntry;
    const response = JSON.parse(entry.value);

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
