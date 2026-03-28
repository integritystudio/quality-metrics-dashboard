/**
 * auth0.ts — env var validation
 *
 * Regression tests for the missing-env-vars bug: the GitHub Pages build was
 * deployed without VITE_AUTH0_* vars embedded, causing a module-level throw
 * on every page load. These tests pin the throw/no-throw boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('auth0.ts env var validation', () => {
  it('throws when all three vars are missing', async () => {
    vi.stubEnv('VITE_AUTH0_DOMAIN', '');
    vi.stubEnv('VITE_AUTH0_CLIENT_ID', '');
    vi.stubEnv('VITE_AUTH0_AUDIENCE', '');

    await expect(import('../lib/auth0.js')).rejects.toThrow(
      'Missing required env vars: VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE',
    );
  });

  it('throws when only VITE_AUTH0_DOMAIN is set', async () => {
    vi.stubEnv('VITE_AUTH0_DOMAIN', 'test.auth0.com');
    vi.stubEnv('VITE_AUTH0_CLIENT_ID', '');
    vi.stubEnv('VITE_AUTH0_AUDIENCE', '');

    await expect(import('../lib/auth0.js')).rejects.toThrow(
      'Missing required env vars',
    );
  });

  it('throws when only VITE_AUTH0_CLIENT_ID is missing', async () => {
    vi.stubEnv('VITE_AUTH0_DOMAIN', 'test.auth0.com');
    vi.stubEnv('VITE_AUTH0_CLIENT_ID', '');
    vi.stubEnv('VITE_AUTH0_AUDIENCE', 'https://api.test.dev');

    await expect(import('../lib/auth0.js')).rejects.toThrow(
      'Missing required env vars',
    );
  });

  it('does not throw and exports correct values when all vars are set', async () => {
    vi.stubEnv('VITE_AUTH0_DOMAIN', 'integritystudio.us.auth0.com');
    vi.stubEnv('VITE_AUTH0_CLIENT_ID', 'test-client-id');
    vi.stubEnv('VITE_AUTH0_AUDIENCE', 'https://api.integritystudio.dev');

    const mod = await import('../lib/auth0.js');

    expect(mod.AUTH0_DOMAIN).toBe('integritystudio.us.auth0.com');
    expect(mod.AUTH0_CLIENT_ID).toBe('test-client-id');
    expect(mod.AUTH0_AUDIENCE).toBe('https://api.integritystudio.dev');
    expect(mod.AUTH0_CALLBACK_URI).toBe(`${window.location.origin}/callback`);
    expect(mod.AUTH0_LOGIN_PARAMS).toEqual({
      audience: 'https://api.integritystudio.dev',
      redirect_uri: `${window.location.origin}/callback`,
    });
  });
});
