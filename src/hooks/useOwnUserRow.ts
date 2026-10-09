import { useQuery } from '@tanstack/react-query';
import { useAuth0 } from '../lib/auth0.js';
import { STALE_TIME } from '../lib/constants.js';
import { OWN_USER_PATH, postgrestFetch, supabaseConfigFromEnv } from '../lib/postgrest-client.js';
import { OwnUserRowsSchema, type OwnUserRow } from '../lib/validation/auth-schemas.js';

export const OWN_USER_ROW_QUERY_KEY = ['supabase', 'users', 'me'] as const;
const ERR_SUPABASE_UNCONFIGURED = 'SUPABASE_UNCONFIGURED';
const ERR_NO_ID_TOKEN = 'NO_ID_TOKEN';

/**
 * The signed-in user's own `users` row, read from Supabase with the Auth0 ID token (CR62).
 *
 * Disabled, with `data` undefined, until Auth0 reports a session and the build carries
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Never retried: a 401 means the token
 * has no `role` claim (this client is not listed in the Action's secret) and will not
 * acquire one by asking again. `null` means the read worked and found no row.
 */
export function useOwnUserRow() {
  const { isAuthenticated, getIdTokenClaims } = useAuth0();
  const config = supabaseConfigFromEnv(import.meta.env);
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- config is build-time env, constant for the page's life
  return useQuery<OwnUserRow | null, Error>({
    queryKey: OWN_USER_ROW_QUERY_KEY,
    enabled: config !== null && isAuthenticated,
    staleTime: STALE_TIME.DEFAULT,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!config) throw new Error(ERR_SUPABASE_UNCONFIGURED);
      const idToken = (await getIdTokenClaims())?.__raw;
      if (!idToken) throw new Error(ERR_NO_ID_TOKEN);
      const res = await postgrestFetch(config, OWN_USER_PATH, idToken, { signal });
      if (!res.ok) throw new Error(`PostgREST error: ${res.status}`);
      const rows = OwnUserRowsSchema.parse(await res.json());
      return rows[0] ?? null;
    },
  });
}
