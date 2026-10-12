/**
 * Integration test setup — obtains a real Auth0 JWT via ROPC for the permanent
 * test user, upserts them into public.users, assigns the e2e role, and writes
 * the JWT + user metadata to a shared state file for tests and teardown.
 *
 * Requires Doppler env vars:
 *   VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE
 *   AUTH0_TEST_EMAIL, AUTH0_TEST_PASSWORD, AUTH0_TEST_USER_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, METRICS_API_URL
 *
 * Run: doppler run --project integrity-studio --config dev -- npx playwright test --project integration
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PostgrestClient } from '@supabase/postgrest-js';
import { serviceClient } from './supabase-service.js';

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

/** The test user's `public.users` id, inserting the row when it is absent. */
async function upsertPublicUser(db: PostgrestClient, auth0Id: string, email: string): Promise<string> {
  const { error: insertError } = await db.from('users')
    .upsert({ id: randomUUID(), email, auth0_id: auth0Id }, { onConflict: 'auth0_id', ignoreDuplicates: true });
  if (insertError) throw new Error(`public.users upsert failed: ${insertError.message}`);

  const { data, error } = await db.from('users').select('id').eq('auth0_id', auth0Id).single<{ id: string }>();
  if (error) throw new Error(`public.users lookup failed: ${error.message}`);
  return data.id;
}

/** Create the e2e role when absent and assign it to `userId`; an existing role keeps its permissions. */
async function ensureE2eRole(db: PostgrestClient, userId: string): Promise<void> {
  const { error: createError } = await db.from('roles')
    .upsert({ name: E2E_ROLE_NAME, permissions: E2E_PERMISSIONS }, { onConflict: 'name', ignoreDuplicates: true });
  if (createError) throw new Error(`role create failed: ${createError.message}`);

  const { data: role, error: roleError } = await db.from('roles').select('id').eq('name', E2E_ROLE_NAME).single<{ id: string }>();
  if (roleError) throw new Error(`role lookup failed: ${roleError.message}`);

  const { error: assignError } = await db.from('user_roles')
    .upsert({ user_id: userId, role_id: role.id }, { onConflict: 'user_id,role_id', ignoreDuplicates: true });
  if (assignError) throw new Error(`role assignment failed: ${assignError.message}`);
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
  const workerUrl = requireEnv('METRICS_API_URL');

  const db = serviceClient(supabaseUrl, serviceKey, REQUEST_TIMEOUT_MS);

  // 1. Get real Auth0 JWT via ROPC
  const jwt = await getAuth0Jwt(auth0Domain, auth0ClientId, auth0Audience, testEmail, testPassword);

  // 2. Upsert test user into public.users
  const userId = await upsertPublicUser(db, testAuth0Id, testEmail);

  // 3. Ensure e2e role is assigned
  await ensureE2eRole(db, userId);

  // Write state for tests and teardown
  const state: IntegrationState = { jwt, userId, email: testEmail, workerUrl };
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));

  console.log(`[integration setup] Auth0 JWT acquired for ${testEmail} (userId: ${userId})`);
}

export default setup;
