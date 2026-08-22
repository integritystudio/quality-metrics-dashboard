import { describe, it, expect } from 'vitest';
import { importMetaDirname } from '../lib/dashboard-file-utils.js';

describe('importMetaDirname', () => {
  it('returns the directory when the runtime provides a string dirname', () => {
    expect(importMetaDirname({ dirname: '/repo/scripts' })).toBe('/repo/scripts');
  });

  it('returns undefined when the runtime omits dirname', () => {
    expect(importMetaDirname({})).toBeUndefined();
  });

  it('returns undefined when dirname is present but not a string', () => {
    expect(importMetaDirname({ dirname: null })).toBeUndefined();
  });
});
