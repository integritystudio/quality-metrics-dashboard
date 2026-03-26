/**
 * Shared Supabase REST client helpers for worker and server-side code.
 * Provides consistent header construction for authenticated Supabase REST calls.
 */

/**
 * Returns headers for Supabase REST calls authenticated with a user JWT.
 * Uses the anon key as the apikey (required by Supabase PostgREST for RLS).
 */
export function userAuthHeaders(
  env: { SUPABASE_ANON_KEY: string },
  jwt: string,
): Record<string, string> {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Performs a fire-and-forget POST to a Supabase REST endpoint with a user JWT.
 * Failures are intentionally swallowed — use for non-critical audit writes only.
 * A 3-second timeout prevents hung fetches from blocking worker execution.
 */
export function supabasePost(
  url: string,
  body: unknown,
  env: { SUPABASE_ANON_KEY: string },
  jwt: string,
): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  void fetch(url, {
    method: 'POST',
    headers: {
      ...userAuthHeaders(env, jwt),
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch(() => undefined).finally(() => clearTimeout(timeout));
}
