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

export const BEARER_PREFIX = 'Bearer ';

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
    'Authorization': `${BEARER_PREFIX}${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

export type AuditAction = 'role.assign' | 'role.revoke' | 'member.role_change' | 'member.remove' | 'key.rotate' | 'judge_config.set' | 'judge_config.clear';

type AuditDetails = { roleId?: string; keyId?: string; organizationId?: string };

// Callers fire it only on success. Org-admin mutations pass session.activeOrgId as
// organizationId, so an audit row can never claim a scope the mutation did not have.
export function logAuditEvent(c: AppContext, action: AuditAction, targetUserId: string, { roleId, keyId, organizationId }: AuditDetails = {}): void {
  const actorUserId = c.get('session').appUserId;
  const metadata = {
    ...(roleId !== undefined && { role_id: roleId }),
    ...(keyId !== undefined && { key_id: keyId }),
  };
  c.executionCtx.waitUntil(insertAndForget(c.env, 'audit_log', {
    actor_user_id: actorUserId,
    action,
    // target_type and target_id are NOT NULL columns; role_id and key_id are not
    // columns, so they ride in metadata.
    target_type: 'user',
    target_id: targetUserId,
    ...(Object.keys(metadata).length > 0 && { metadata }),
    ...(organizationId !== undefined && { organization_id: organizationId }),
  }));
}

// waitUntil keeps the Worker runtime from cancelling the in-flight write after the response is sent.
export function logActivity(c: AppContext, activityType: UserActivityEvent): void {
  const appUserId = c.get('session').appUserId;
  c.executionCtx.waitUntil(insertAndForget(c.env, 'user_activity', { user_id: appUserId, activity_type: activityType }));
}
