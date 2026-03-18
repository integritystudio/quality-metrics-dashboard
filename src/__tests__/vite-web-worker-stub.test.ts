import { describe, it, expect } from 'vitest';

describe('web-worker stub', () => {
  it('resolves web-worker import without throwing', async () => {
    // @ts-expect-error — resolved by vite alias, not tsc
    const mod = await import('web-worker');
    expect(mod).toBeDefined();
    expect(mod.default).toBeDefined();
  });

  it('exports a Worker-compatible constructor', async () => {
    // @ts-expect-error — resolved by vite alias, not tsc
    const mod = await import('web-worker');
    expect(typeof mod.default).toBe('function');
  });
});
