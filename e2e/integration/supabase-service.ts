import { PostgrestClient } from '@supabase/postgrest-js';
import { SUPABASE_REST_PATH } from '../../src/lib/postgrest-client.js';

/** Service-role PostgREST client for integration setup and teardown; bypasses RLS. */
export function serviceClient(supabaseUrl: string, serviceKey: string, timeoutMs: number): PostgrestClient {
  return new PostgrestClient(`${supabaseUrl}${SUPABASE_REST_PATH}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    timeout: timeoutMs,
  });
}
