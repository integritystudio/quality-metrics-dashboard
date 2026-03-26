/**
 * Integration test teardown — cleans up the test user created by setup.ts.
 * Deletes: user_roles, user_activity, public.users, auth.users entry.
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const { userId } = state;

  // Best-effort cleanup in dependency order
  const deletions = [
    ['user_roles', `user_id=eq.${userId}`],
    ['user_activity', `user_id=eq.${userId}`],
    ['users', `id=eq.${userId}`],
  ] as const;

  for (const [table, filter] of deletions) {
    await fetch(`${supabaseUrl}/rest/v1/${table}?${filter}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  // Delete auth user
  await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS),
  }).catch(() => undefined);

  // Clean up state file
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }

  console.log(`[integration teardown] Cleaned up test user ${state.email} (${userId})`);
}

export default teardown;
