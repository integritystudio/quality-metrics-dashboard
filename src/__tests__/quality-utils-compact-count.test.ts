/**
 * formatCompactCount renders token and evaluation counts on the session, agent and
 * health views.
 */
import { describe, expect, it } from 'vitest';
import { formatCompactCount } from '../lib/quality-utils.js';

describe('formatCompactCount', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [1_000, '1K'],
    [1_500, '1.5K'],
    [999_950, '1M'],
    [2_340_000, '2.3M'],
    [523.46, '523.5'],
  ])('formats %d as %s', (n, expected) => {
    expect(formatCompactCount(n)).toBe(expected);
  });
});
