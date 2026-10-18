/**
 * Integration test teardown — cleans up DB rows created by setup.ts.
 * Deletes: user_roles, user_activity, public.users row.
 * Does NOT delete the Auth0 user — it is a permanent test account.
 *
 * The `users` row outlives the run whenever a table this suite does not own
 * still references it — an `api_keys` row from the provisioning e2e, say. That
 * is expected, not a failure: `setup.ts` upserts the row, so the next run is
 * unaffected, and deleting another suite's rows to force it through would
 * revoke credentials this one never issued.
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceClient } from './supabase-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Must match setup.ts STATE_FILE path
const STATE_FILE = join(__dirname, '.integration-state.json');

interface IntegrationState {
  jwt: string;
  userId: string;
  email: string;
  workerUrl: string;
}

const TEARDOWN_TIMEOUT_MS = 15_000;

/** Postgres `foreign_key_violation` — the row is still referenced elsewhere. */
const FOREIGN_KEY_VIOLATION = '23503';

async function teardown(): Promise<void> {
  let state: IntegrationState;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as IntegrationState;
  } catch {
    console.warn('[integration teardown] No state file found — skipping cleanup');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.warn('[integration teardown] Missing env vars — skipping cleanup');
    return;
  }

  const db = serviceClient(supabaseUrl, serviceKey, TEARDOWN_TIMEOUT_MS);
  const { userId } = state;

  // Best-effort cleanup in dependency order (Auth0 user is permanent — DB rows only).
  // The client returns failures as `error` rather than throwing, so one miss does not stop the rest.
  const deletions = [
    ['user_roles', 'user_id'],
    ['user_activity', 'user_id'],
    ['users', 'id'],
  ] as const;

  let userRowKept = false;
  for (const [table, column] of deletions) {
    const { error } = await db.from(table).delete().eq(column, userId);
    if (!error) continue;
    if (error.code === FOREIGN_KEY_VIOLATION) {
      userRowKept ||= table === 'users';
      console.log(`[integration teardown] ${table} row kept — still referenced by rows this suite did not create`);
      continue;
    }
    console.warn(`[integration teardown] ${table} cleanup failed: ${error.message}`);
  }

  // Clean up state file
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }

  const what = userRowKept ? "this suite's rows for" : 'test user';
  console.log(`[integration teardown] Cleaned up ${what} ${state.email} (${userId})`);
}

export default teardown;
