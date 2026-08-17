import { describe, it, expect } from 'vitest';

/**
 * `web-worker` has no types — it is a bare specifier resolved by the vite alias
 * in `vite.config.ts`, not a real package. Narrowing the dynamic import to the
 * shape being asserted keeps the module out of `any`, so a later assertion on a
 * property this stub does not have is a typecheck failure rather than a silent
 * `undefined`.
 */
async function importWebWorkerStub(): Promise<{ default: unknown }> {
  // @ts-expect-error — resolved by vite alias, not tsc
  return import('web-worker') as Promise<{ default: unknown }>;
}

describe('web-worker stub', () => {
  it('resolves web-worker import without throwing', async () => {
    const mod = await importWebWorkerStub();
    expect(mod).toBeDefined();
    expect(mod.default).toBeDefined();
  });

  it('exports a Worker-compatible constructor', async () => {
    const mod = await importWebWorkerStub();
    expect(typeof mod.default).toBe('function');
  });
});
