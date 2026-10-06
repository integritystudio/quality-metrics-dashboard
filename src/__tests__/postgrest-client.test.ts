/**
 * postgrest-client — the browser's direct Supabase read path (CR62).
 *
 * Config resolution turns the feature off when either value is missing, and the request
 * carries the publishable key as `apikey` and the ID token as the bearer, nothing else.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OWN_USER_PATH,
  SUPABASE_API_KEY_HEADER,
  postgrestFetch,
  supabaseConfigFromEnv,
} from '../lib/postgrest-client.js';

const URL = 'https://project.supabase.co';
const ANON_KEY = 'sb_publishable_test';
const ID_TOKEN = 'id-token';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supabaseConfigFromEnv', () => {
  it('resolves both values and strips a trailing slash from the URL', () => {
    expect(supabaseConfigFromEnv({ VITE_SUPABASE_URL: `${URL}/`, VITE_SUPABASE_ANON_KEY: ANON_KEY }))
      .toEqual({ url: URL, anonKey: ANON_KEY });
  });

  it.each([
    ['no URL', { VITE_SUPABASE_ANON_KEY: ANON_KEY }],
    ['no key', { VITE_SUPABASE_URL: URL }],
    ['empty URL', { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: ANON_KEY }],
    ['nothing', {}],
  ])('is null with %s, so consumers stay off', (_case, env) => {
    expect(supabaseConfigFromEnv(env)).toBeNull();
  });
});

describe('postgrestFetch', () => {
  it('GETs the REST path with the publishable key and the ID token as bearer', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(Response.json([])));
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();

    await postgrestFetch({ url: URL, anonKey: ANON_KEY }, OWN_USER_PATH, ID_TOKEN, { signal: controller.signal });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL}/rest/v1/${OWN_USER_PATH}`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({
      [SUPABASE_API_KEY_HEADER]: ANON_KEY,
      Authorization: `Bearer ${ID_TOKEN}`,
      Accept: 'application/json',
    });
    expect(init.signal).toBe(controller.signal);
  });
});
