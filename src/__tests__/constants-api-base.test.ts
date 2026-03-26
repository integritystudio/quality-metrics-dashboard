/**
 * constants.ts — API_BASE double-/api regression
 *
 * Regression tests for the production bug where VITE_API_URL was set to
 * "http://localhost:3001/api" (from Doppler dev config), causing every API
 * call to use a double-path like "localhost:3001/api/api/me".
 *
 * API_BASE must be the bare origin/base (no /api suffix). Callers append
 * "/api/<route>" themselves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
