/**
 * Integration test setup — obtains a real Auth0 JWT via ROPC for the permanent
 * test user, upserts them into public.users, assigns the e2e role, and writes
 * the JWT + user metadata to a shared state file for tests and teardown.
 *
 * Requires Doppler env vars:
 *   VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE
 *   AUTH0_TEST_EMAIL, AUTH0_TEST_PASSWORD, AUTH0_TEST_USER_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEV_WORKER_URL
 *
 * Run: doppler run --project integrity-studio --config dev -- npx playwright test --project integration
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 15_000;

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

interface Auth0TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export const STATE_FILE = join(__dirname, '.integration-state.json');

export interface IntegrationState {
  jwt: string;
  userId: string;
  email: string;
  workerUrl: string;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}. Run with: doppler run --project integrity-studio --config dev`);
  return val;
}

async function getAuth0Jwt(
  domain: string,
  clientId: string,
  audience: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: email,
      password,
      client_id: clientId,
      audience,
      scope: 'openid profile email',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json() as Auth0TokenResponse;
  if (!data.access_token) {
    throw new Error(`Auth0 ROPC failed: ${data.error} — ${data.error_description}`);
  }
  return data.access_token;
}

async function upsertPublicUser(
  supabaseUrl: string,
  serviceHeaders: Record<string, string>,
  auth0Id: string,
  email: string,
): Promise<string> {
  // Check if user already exists
  const lookupRes = await fetch(
    `${supabaseUrl}/rest/v1/users?select=id&auth0_id=eq.${encodeURIComponent(auth0Id)}&limit=1`,
    { headers: serviceHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (lookupRes.ok) {
    const rows = await lookupRes.json() as Array<{ id: string }>;
    if (rows[0]?.id) return rows[0].id;
  }

  // Insert new row
  const id = randomUUID();
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/users`, {
    method: 'POST',
    headers: { ...serviceHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ id, email, auth0_id: auth0Id }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    throw new Error(`public.users insert failed: ${insertRes.status} ${errText}`);
  }
  return id;
}

async function ensureE2eRole(
  supabaseUrl: string,
  serviceHeaders: Record<string, string>,
  userId: string,
): Promise<void> {
  // Find or create e2e role
  const rolesRes = await fetch(
    `${supabaseUrl}/rest/v1/roles?select=id&name=eq.${E2E_ROLE_NAME}`,
    { headers: serviceHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const roles = await rolesRes.json() as Array<{ id: string }>;

  if (!roles.length) {
    const createRes = await fetch(`${supabaseUrl}/rest/v1/roles`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: E2E_ROLE_NAME, permissions: E2E_PERMISSIONS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`role create failed: ${createRes.status} ${errText}`);
    }
    roles = await createRes.json() as Array<{ id: string }>;
  }

  const roleId = roles[0].id;

  // Assign only if not already assigned
  const checkRes = await fetch(
    `${supabaseUrl}/rest/v1/user_roles?select=id&user_id=eq.${userId}&role_id=eq.${roleId}&limit=1`,
    { headers: serviceHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const existing = checkRes.ok ? await checkRes.json() as Array<{ id: string }> : [];
  if (existing.length) return;

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
}

async function setup(): Promise<void> {
  const auth0Domain = requireEnv('VITE_AUTH0_DOMAIN');
  const auth0ClientId = requireEnv('VITE_AUTH0_CLIENT_ID');
  const auth0Audience = requireEnv('VITE_AUTH0_AUDIENCE');
  const testEmail = requireEnv('AUTH0_TEST_EMAIL');
  const testPassword = requireEnv('AUTH0_TEST_PASSWORD');
  const testAuth0Id = requireEnv('AUTH0_TEST_USER_ID');
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const workerUrl = requireEnv('DEV_WORKER_URL');

  const serviceHeaders = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  // 1. Get real Auth0 JWT via ROPC
  const jwt = await getAuth0Jwt(auth0Domain, auth0ClientId, auth0Audience, testEmail, testPassword);

  // 2. Upsert test user into public.users
  const userId = await upsertPublicUser(supabaseUrl, serviceHeaders, testAuth0Id, testEmail);

  // 3. Ensure e2e role is assigned
  await ensureE2eRole(supabaseUrl, serviceHeaders, userId);

  // Write state for tests and teardown
  const state: IntegrationState = { jwt, userId, email: testEmail, workerUrl };
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));

  console.log(`[integration setup] Auth0 JWT acquired for ${testEmail} (userId: ${userId})`);
}

export default setup;
