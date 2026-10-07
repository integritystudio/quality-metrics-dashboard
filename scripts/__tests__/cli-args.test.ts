import { describe, it, expect } from 'vitest';
import {
  CliArgError,
  nonNegativeNumberArg,
  parseCli,
  positiveIntArg,
  positiveNumberArg,
} from '../cli-args.js';

const SPEC = { values: ['--limit', '--source='], switches: ['--dry-run'] };

describe('parseCli', () => {
  it('reads a value given inline or as the next argument', () => {
    expect(parseCli(['--limit=5'], SPEC).value('--limit')).toBe('5');
    expect(parseCli(['--limit', '5'], SPEC).value('--limit')).toBe('5');
  });

  it('accepts a flag constant spelled with a trailing =', () => {
    expect(parseCli(['--source', 'cloud'], SPEC).value('--source=')).toBe('cloud');
  });

  it('reports absent flags as undefined and false', () => {
    const args = parseCli([], SPEC);

    expect(args.value('--limit')).toBeUndefined();
    expect(args.has('--dry-run')).toBe(false);
  });

  it('reads switches and keeps positionals', () => {
    const args = parseCli(['file.json', '--dry-run'], SPEC);

    expect(args.has('--dry-run')).toBe(true);
    expect(args.positionals).toEqual(['file.json']);
  });

  it('ignores undeclared flags by default, so scripts can share a command line', () => {
    const args = parseCli(['--batch', '--limit', '3', '--other=x'], SPEC);

    expect(args.value('--limit')).toBe('3');
  });

  it.each([
    ['at the end of the line', ['--limit']],
    ['followed by another flag', ['--limit', '--dry-run']],
  ])('rejects a value flag with no value %s', (_label, argv) => {
    expect(() => parseCli(argv, SPEC)).toThrow(new CliArgError('--limit needs a value'));
  });

  it('rejects a switch given a value rather than silently ignoring it', () => {
    expect(() => parseCli(['--dry-run=yes'], SPEC)).toThrow('--dry-run takes no value');
  });

  it('rejects an undeclared flag when asked to', () => {
    expect(() => parseCli(['--force'], SPEC, { allowUnknown: false })).toThrow('Unknown argument: --force');
  });

  it('throws a programming error when reading a flag the spec does not declare', () => {
    expect(() => parseCli([], SPEC).value('--days')).toThrow('not declared');
  });
});

describe('number arguments', () => {
  it('pass an absent argument through as undefined', () => {
    expect(positiveIntArg('--limit', undefined)).toBeUndefined();
    expect(positiveNumberArg('--hours', undefined)).toBeUndefined();
    expect(nonNegativeNumberArg('--settle', undefined)).toBeUndefined();
  });

  it('positiveIntArg accepts whole numbers from 1', () => {
    expect(positiveIntArg('--limit', '1')).toBe(1);
    expect(positiveIntArg('--limit', '250')).toBe(250);
  });

  it.each(['0', '-3', '1.5', '7d', 'ten', ''])('positiveIntArg rejects %j', (raw) => {
    expect(() => positiveIntArg('--limit', raw)).toThrow(`--limit must be a positive integer, got "${raw}"`);
  });

  it('positiveNumberArg accepts fractions but not zero', () => {
    expect(positiveNumberArg('--hours', '1.5')).toBe(1.5);
    expect(() => positiveNumberArg('--hours', '0')).toThrow('--hours must be a positive number');
  });

  it('nonNegativeNumberArg accepts zero but not negatives', () => {
    expect(nonNegativeNumberArg('--settle', '0')).toBe(0);
    expect(() => nonNegativeNumberArg('--settle', '-1')).toThrow('--settle must be a non-negative number');
  });

  it('throws CliArgError, so callers can tell a bad command line from a bug', () => {
    expect(() => positiveIntArg('--limit', 'x')).toThrow(CliArgError);
  });
});
