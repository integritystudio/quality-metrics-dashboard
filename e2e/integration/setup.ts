/**
 * Integration test setup — creates a test user against real Supabase,
 * assigns dashboard.read role, signs in, and writes the JWT to a shared file.
 *
 * Requires Doppler env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DEV_WORKER_URL
 *
 * Run: doppler run --project integrity-studio --config dev -- npx playwright test --project integration
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 15_000;

interface SupabaseAdminUserResponse {
  id?: string;
  error?: { message: string };
}

interface SupabaseSignInResponse {
  access_token?: string;
  error?: { message: string };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}. Run with: doppler run --project integrity-studio --config dev`);
  return val;
}

export const STATE_FILE = join(__dirname, '.integration-state.json');

export interface IntegrationState {
  jwt: string;
  userId: string;
  email: string;
  workerUrl: string;
}

const E2E_EMAIL_PATTERN = 'test+e2e';
const E2E_INTEGRATION_EMAIL_DOMAIN = '@integritystudio.ai';

async function purgeOrphanedE2eUsers(
  supabaseUrl: string,
  serviceHeaders: Record<string, string>,
): Promise<void> {
  // Find stale test users from prior runs (pattern: test+e2e<timestamp>@integritystudio.ai)
  const listRes = await fetch(
    `${supabaseUrl}/rest/v1/users?select=id,email&email=like.${E2E_EMAIL_PATTERN}*${E2E_INTEGRATION_EMAIL_DOMAIN}`,
    { headers: serviceHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!listRes.ok) return;

  const orphans = await listRes.json() as Array<{ id: string; email: string }>;
  if (!orphans.length) return;

  console.log(`[integration setup] Purging ${orphans.length} orphaned e2e user(s)…`);
  for (const { id, email } of orphans) {
    await fetch(`${supabaseUrl}/rest/v1/user_roles?user_id=eq.${id}`, {
      method: 'DELETE', headers: serviceHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
    await fetch(`${supabaseUrl}/rest/v1/user_activity?user_id=eq.${id}`, {
      method: 'DELETE', headers: serviceHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
    await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${id}`, {
      method: 'DELETE', headers: serviceHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: serviceHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
    console.log(`[integration setup] Purged orphan: ${email}`);
  }
}

async function setup(): Promise<void> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const workerUrl = requireEnv('DEV_WORKER_URL');

  const uniqueSuffix = Math.random().toString(36).substring(2, 8);
  const email = `test+e2e${Date.now()}${uniqueSuffix}@integritystudio.ai`;
  const password = `E2ePass!${Date.now()}`;

  const headers = {
    'apikey': anonKey,
    'Content-Type': 'application/json',
  };

  const serviceHeaders = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  // 0. Purge stale test users from prior failed runs
  await purgeOrphanedE2eUsers(supabaseUrl, serviceHeaders);

  // 1. Create user via admin API (bypasses signup rate limits)
  const createUserRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const createUserData = await createUserRes.json() as SupabaseAdminUserResponse;
  const userId = createUserData.id;
  if (!userId) throw new Error(`admin user create failed: ${createUserData.error?.message ?? createUserRes.status}`);

  // 3. Insert into public.users
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/users`, {
    method: 'POST',
    headers: { ...serviceHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ id: userId, email, auth0_id: userId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    throw new Error(`public.users insert failed: ${insertRes.status} ${errText}`);
  }

  // 4. Assign dashboard reader role — find or create
  const E2E_ROLE_NAME = 'e2e-dashboard-reader';
  const E2E_PERMISSIONS = [
    'dashboard.read',
    'dashboard.executive',
    'dashboard.operator',
    'dashboard.auditor',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
  ];

  const rolesRes = await fetch(
    `${supabaseUrl}/rest/v1/roles?select=id,name,permissions&name=eq.${E2E_ROLE_NAME}`,
    { headers: serviceHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  let roles = await rolesRes.json() as Array<{ id: string; name: string; permissions: string[] }>;

  if (!roles.length) {
    // Create the e2e role with dashboard permissions
    const createRoleRes = await fetch(`${supabaseUrl}/rest/v1/roles`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: E2E_ROLE_NAME, permissions: E2E_PERMISSIONS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!createRoleRes.ok) {
      const errText = await createRoleRes.text();
      throw new Error(`role create failed: ${createRoleRes.status} ${errText}`);
    }
    roles = await createRoleRes.json() as Array<{ id: string; name: string; permissions: string[] }>;
  }

  const roleId = roles[0].id;
  const assignRes = await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { ...serviceHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, role_id: roleId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!assignRes.ok) {
    const errText = await assignRes.text();
    throw new Error(`role assignment failed: ${assignRes.status} ${errText}`);
  }

  // 5. Sign in to get JWT
  const signInRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const signInData = await signInRes.json() as SupabaseSignInResponse;
  const jwt = signInData.access_token;
  if (!jwt) throw new Error(`signin failed: ${signInData.error?.message ?? signInRes.status}`);

  // Write state to file for tests and teardown
  const state: IntegrationState = { jwt, userId, email, workerUrl };
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));

  console.log(`[integration setup] Created test user ${email} (${userId}), role: ${roles[0].name}`);
}

export default setup;
