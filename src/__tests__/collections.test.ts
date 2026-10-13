import { describe, it, expect } from 'vitest';
import { getOrThrow } from '../lib/collections.js';

describe('getOrThrow', () => {
  it('returns the stored value', () => {
    const map = new Map([['a', 1]]);

    expect(getOrThrow(map, 'a')).toBe(1);
  });

  it('returns falsy values that are present', () => {
    const map = new Map<string, number | null>([['zero', 0], ['null', null]]);

    expect(getOrThrow(map, 'zero')).toBe(0);
    expect(getOrThrow(map, 'null')).toBeNull();
  });

  it('throws naming the missing key', () => {
    const map = new Map([['a', 1]]);

    expect(() => getOrThrow(map, 'missing')).toThrow('No entry for key missing');
  });
});
