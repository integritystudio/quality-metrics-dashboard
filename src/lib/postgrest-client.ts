/**
 * Browser-side PostgREST reads with the signed-in user's Auth0 ID token (CR62).
 *
 * The Supabase project trusts the Auth0 tenant as a third-party issuer, and the post-login
 * Action puts `role = authenticated` on the ID token for this client only, so a request
 * carrying it runs as the `authenticated` database role and sees exactly what RLS allows:
 * the caller's own `users` row and the rows of its active organizations (read policies
 * over `current_app_user_id()`; no write policy exists for a non-service caller). The
 * publishable key goes in `apikey` for the gateway; it grants nothing by itself.
 *
 * The access token is the wrong credential here: Auth0 strips the bare `role` claim from
 * it, so PostgREST treats it as anon and answers `200 []`.
 *
 * No `import.meta` in this module, so a Node script can import it to prove the read.
 */

export const SUPABASE_REST_PATH = '/rest/v1';
export const SUPABASE_API_KEY_HEADER = 'apikey';
/** Columns of the caller's own `users` row the dashboard reads. */
export const OWN_USER_SELECT = 'id,email,name,email_verified,login_count,last_login';
/** The PostgREST query for the caller's own row: RLS supplies the `where`. */
export const OWN_USER_PATH = `users?select=${OWN_USER_SELECT}&limit=1`;

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * The project this build talks to, or null when either value is absent — then every
 * consumer stays off, which is what a local or e2e build without Supabase wants.
 */
export function supabaseConfigFromEnv(env: Record<string, string | undefined>): SupabaseConfig | null {
  const url = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? '';
  return url && anonKey ? { url, anonKey } : null;
}

/** A read-only PostgREST request authenticated with the Auth0 ID token. */
export function postgrestFetch(
  config: SupabaseConfig,
  path: string,
  idToken: string,
  init?: { signal?: AbortSignal },
): Promise<Response> {
  return fetch(`${config.url}${SUPABASE_REST_PATH}/${path}`, {
    method: 'GET',
    headers: {
      [SUPABASE_API_KEY_HEADER]: config.anonKey,
      Authorization: `Bearer ${idToken}`,
      Accept: 'application/json',
    },
    signal: init?.signal,
  });
}
