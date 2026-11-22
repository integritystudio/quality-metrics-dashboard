import { describe, it, expect } from 'vitest';
import { getOrThrow, toggleInSet } from '../lib/collections.js';

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

describe('toggleInSet', () => {
  it('adds an absent value', () => {
    expect(toggleInSet(new Set(['a']), 'b')).toEqual(new Set(['a', 'b']));
  });

  it('removes a present value', () => {
    expect(toggleInSet(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']));
  });

  it('leaves the input set unchanged', () => {
    const original = new Set(['a']);

    toggleInSet(original, 'a');

    expect(original).toEqual(new Set(['a']));
  });
});
