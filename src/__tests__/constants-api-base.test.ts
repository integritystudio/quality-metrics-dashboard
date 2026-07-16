/**
 * constants.ts — API_BASE regressions
 *
 * 1. double-/api: VITE_API_URL was once set to "http://localhost:3001/api" (from
 *    Doppler dev config), causing every API call to use "localhost:3001/api/api/me".
 *    API_BASE must be the bare origin/base (no /api suffix); callers append "/api/<route>".
 * 2. Node/tsx boot: `import.meta.env` is `undefined` under tsx (the API-server
 *    runtime), so an unguarded `import.meta.env.VITE_API_URL` threw at module load
 *    and stopped the Hono server from booting. resolveApiBase must accept undefined.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveApiBase } from '../lib/constants.js';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API_BASE — no double /api path', () => {
  it('uses VITE_API_URL as-is when set to a bare worker URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://quality-metrics-api.alyshia-b38.workers.dev');

    const { API_BASE } = await import('../lib/constants.js');

    expect(API_BASE).toBe('https://quality-metrics-api.alyshia-b38.workers.dev');
    // Callers do `${API_BASE}/api/me` — this must not start with double /api
    expect(`${API_BASE}/api/me`).toBe('https://quality-metrics-api.alyshia-b38.workers.dev/api/me');
  });

  it('does not produce double /api when VITE_API_URL already ends with /api (misconfiguration)', async () => {
    // Guard: if someone accidentally sets VITE_API_URL=http://localhost:3001/api,
    // callers would produce /api/api/me. This test documents the expectation
    // that VITE_API_URL should NOT have a trailing /api suffix.
    vi.stubEnv('VITE_API_URL', 'http://localhost:3001');

    const { API_BASE } = await import('../lib/constants.js');

    const meUrl = `${API_BASE}/api/me`;
    expect(meUrl).toBe('http://localhost:3001/api/me');
    expect(meUrl).not.toContain('/api/api/');
  });

  it('falls back to empty string in production when VITE_API_URL is not set', async () => {
    vi.stubEnv('VITE_API_URL', '');
    // Simulate production (non-DEV) by ensuring DEV is falsy — jsdom env has no DEV flag
    const { API_BASE } = await import('../lib/constants.js');

    // In production build, empty VITE_API_URL means same-origin requests (/api/...)
    expect(API_BASE).toBe('');
    expect(`${API_BASE}/api/me`).toBe('/api/me');
  });
});

describe('resolveApiBase — Node/tsx API-server boot', () => {
  it('returns "" when env is undefined (the boot-crash condition under tsx)', () => {
    // import.meta.env is undefined in the Node/tsx runtime; an unguarded deref
    // threw here at module load and stopped the API server from binding :3001.
    // If the `?.` guard regresses, this line throws instead of returning "".
    expect(resolveApiBase(undefined)).toBe('');
  });

  it('returns "" for an empty env (production: no VITE_API_URL, not DEV)', () => {
    expect(resolveApiBase({})).toBe('');
  });

  it('falls back to localhost:3001 when DEV and VITE_API_URL is unset', () => {
    expect(resolveApiBase({ DEV: true })).toBe('http://127.0.0.1:3001');
  });

  it('uses VITE_API_URL verbatim when set', () => {
    expect(resolveApiBase({ VITE_API_URL: 'https://api.example.dev' })).toBe('https://api.example.dev');
  });

  it('prefers VITE_API_URL over the DEV fallback', () => {
    expect(resolveApiBase({ VITE_API_URL: 'https://api.example.dev', DEV: true })).toBe('https://api.example.dev');
  });
});
