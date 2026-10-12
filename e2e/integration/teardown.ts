/**
 * Integration test teardown — cleans up DB rows created by setup.ts.
 * Deletes: user_roles, user_activity, public.users row.
 * Does NOT delete the Auth0 user — it is a permanent test account.
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

  for (const [table, column] of deletions) {
    const { error } = await db.from(table).delete().eq(column, userId);
    if (error) console.warn(`[integration teardown] ${table} cleanup failed: ${error.message}`);
  }

  // Clean up state file
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }

  console.log(`[integration teardown] Cleaned up test user ${state.email} (${userId})`);
}

export default teardown;
