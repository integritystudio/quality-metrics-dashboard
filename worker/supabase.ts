/**
 * Service-role Supabase access and the two fire-and-forget ledger writes. Every DB call in the
 * worker goes through `db`: Auth0 JWTs cannot satisfy Supabase RLS, so the service role key is
 * the only credential that reaches PostgREST.
 */

import { PostgrestClient } from '@supabase/postgrest-js';
import type { UserActivityEvent } from '../src/types/activity.js';
import { SUPABASE_API_KEY_HEADER, SUPABASE_REST_PATH } from '../src/lib/postgrest-client.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../src/lib/http-constants.js';
import type { AppContext } from './app-context.js';

export type SupabaseEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };

export const SUPABASE_REST_TIMEOUT_MS = 10_000;

/**
 * Service-role PostgREST client. Callers map every failure to their own response, so the
 * library's GET retry (1s/2s/4s backoff) would only delay it and is off. Built per call:
 * construction is cheap and captures `fetch`, which the tests stub per case.
 */
export function db(env: SupabaseEnv): PostgrestClient {
  return new PostgrestClient(`${env.SUPABASE_URL}${SUPABASE_REST_PATH}`, {
    headers: serviceRoleHeaders(env),
    retry: false,
    timeout: SUPABASE_REST_TIMEOUT_MS,
  });
}

// Both apikey and Authorization use the service role key — the anon key is for browser clients only.
export function serviceRoleHeaders(env: { SUPABASE_SERVICE_ROLE_KEY: string }): HeadersInit {
  return {
    [SUPABASE_API_KEY_HEADER]: env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    [CONTENT_TYPE_HEADER]: ContentType.Json,
  };
}

const FIRE_AND_FORGET_TIMEOUT_MS = 3000;

// Inserts one row for a non-critical write. Every failure, the timeout included, is
// swallowed: postgrest-js answers { error } rather than rejecting, and the catch takes
// the rest — including a malformed SUPABASE_URL, which `.from()` throws synchronously.
async function insertAndForget(env: SupabaseEnv, table: string, row: Record<string, unknown>): Promise<void> {
  try {
    await db(env).from(table).insert(row).abortSignal(AbortSignal.timeout(FIRE_AND_FORGET_TIMEOUT_MS));
  } catch {
    // Fire-and-forget: a failed audit or activity write must not fail the request.
  }
}

export type AuditAction = 'role.assign' | 'role.revoke' | 'member.role_change' | 'member.remove' | 'key.rotate';

type AuditDetails = { roleId?: string; organizationId?: string };

// Fire-and-forget: logs a sensitive admin mutation by the session user to audit_log without
// blocking the response. No-ops without an app user; callers fire it only on success.
// organizationId (P6): org-admin mutations always record session.activeOrgId, so an
// audit row can never claim a scope the mutation did not have. organization_id exists
// since 20260320020000_create_phase2_ledger_tables.sql.
export function logAuditEvent(c: AppContext, action: AuditAction, targetUserId: string, { roleId, organizationId }: AuditDetails = {}): void {
  const actorUserId = c.get('session').appUserId;
  if (!actorUserId) return;
  c.executionCtx.waitUntil(insertAndForget(c.env, 'audit_log', {
    actor_user_id: actorUserId,
    action,
    // target_type and target_id are NOT NULL columns; role_id is not a column —
    // carry it in metadata for role.assign / role.revoke actions.
    target_type: 'user',
    target_id: targetUserId,
    ...(roleId !== undefined && { metadata: { role_id: roleId } }),
    ...(organizationId !== undefined && { organization_id: organizationId }),
  }));
}

// Fire-and-forget: logs the session user's activity to user_activity without blocking the response.
// Auth: uses service role key (Auth0 JWTs are not valid Supabase session tokens for RLS).
// waitUntil keeps the Worker runtime from cancelling the in-flight write after the response is sent.
export function logActivity(c: AppContext, activityType: UserActivityEvent): void {
  const appUserId = c.get('session').appUserId;
  if (!appUserId) return;
  c.executionCtx.waitUntil(insertAndForget(c.env, 'user_activity', { user_id: appUserId, activity_type: activityType }));
}
