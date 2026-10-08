/**
 * Shared Supabase REST client helpers for worker and server-side code.
 * Provides consistent header construction for authenticated Supabase REST calls.
 */

const SUPABASE_POST_TIMEOUT_MS = 3000;

/**
 * Performs a fire-and-forget POST to a Supabase REST endpoint using a service role key.
 * Failures are intentionally swallowed — use for non-critical audit writes only.
 * A 3-second timeout prevents hung fetches from blocking worker execution.
 */
export function supabasePost(
  url: string,
  body: unknown,
  key: string,
): Promise<void> {
  // Fetch errors are intentionally swallowed. Failures are visible
  // at the network level; this function is fire-and-forget for non-critical writes.
  return fetch(url, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUPABASE_POST_TIMEOUT_MS),
  }).then(() => undefined).catch(() => undefined);
}
