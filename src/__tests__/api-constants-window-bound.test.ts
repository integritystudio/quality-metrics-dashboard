/**
 * Unit tests for `toIsoWindowBound`.
 *
 * `queryTraces` declares its date bounds as `string | bigint` but validates the
 * string arm as an ISO datetime, so a date-only value type-checks and then
 * fails Zod at request time — the defect that made /api/agents a guaranteed
 * 500. These assert the widening, including that a value which already carries
 * a time is left alone.
 */

import { describe, it, expect } from 'vitest';

import { toIsoWindowBound } from '../api/api-constants.js';

describe('toIsoWindowBound', () => {
  it('opens the named UTC day for a date-only start bound', () => {
    expect(toIsoWindowBound('2026-09-13', 'start')).toBe('2026-09-13T00:00:00.000Z');
  });

  it('closes the named UTC day for a date-only end bound', () => {
    expect(toIsoWindowBound('2026-09-13', 'end')).toBe('2026-09-13T23:59:59.999Z');
  });

  it('produces bounds a Date can parse back to the same day', () => {
    const start = new Date(toIsoWindowBound('2026-09-13', 'start'));
    const end = new Date(toIsoWindowBound('2026-09-13', 'end'));
    expect(start.toISOString().startsWith('2026-09-13')).toBe(true);
    expect(end.toISOString().startsWith('2026-09-13')).toBe(true);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('leaves a value that already carries a time unchanged', () => {
    const withTime = '2026-09-13T08:30:00.000Z';
    expect(toIsoWindowBound(withTime, 'start')).toBe(withTime);
    expect(toIsoWindowBound(withTime, 'end')).toBe(withTime);
  });

  it('leaves a non-date string unchanged rather than fabricating a bound', () => {
    expect(toIsoWindowBound('not-a-date', 'start')).toBe('not-a-date');
  });
});
