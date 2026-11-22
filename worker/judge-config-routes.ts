/**
 * `/api/admin/judge`: the active org's specified judge (parent docs/roadmap/judge-model-tiers.md,
 * Phase 4). A read comes straight from Supabase `org_judge_configs`; a save or removal is
 * forwarded, signed and with the caller's own Auth0 token, to the parent's
 * api-provisioning-receiver, which checks the caller's membership again and alone holds the
 * credential that writes keys into AI Gateway. The provider key passes through in the save
 * request and is never stored, logged or echoed here.
 */
import type { Hono } from 'hono';
import { HttpStatus } from '../src/lib/http-constants.js';
import { JUDGE_CONFIG_API_PATH, JudgeConfigRowSchema, SetJudgeConfigRequestSchema, type JudgeConfig } from '../src/lib/validation/judge-config-schemas.js';
import { requireOrgAdmin } from './admin-routes.js';
import { internalError, parseRows, readJsonBody, unauthorized, type AppContext, type AppEnv } from './app-context.js';
import { bearerToken } from './auth.js';
import { postToReceiver, receiverAccess } from './receiver-client.js';
import { db, logAuditEvent } from './supabase.js';
import {
  ERR_FETCH_JUDGE_CONFIG,
  ERR_JUDGE_CONFIG_FAILED,
  ERR_JUDGE_CONFIG_OWNER_OR_ADMIN,
  ERR_JUDGE_CONFIG_UNAVAILABLE,
  NO_RESPONSE_STATUS,
} from './error-messages.js';

const JUDGE_CONFIGS_TABLE = 'org_judge_configs';

const RECEIVER_ACTION = {
  SET: 'set_judge_config',
  CLEAR: 'clear_judge_config',
} as const;

type ReceiverOutcome = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Sends one judge action to the receiver and maps its answer: its 403 (not an owner or admin)
 * and 503 (gateway unconfigured) pass through with this worker's wording; anything else that
 * is not a 200 is a 502, never the receiver's body.
 */
async function forward(c: AppContext, action: string, fields: Record<string, unknown>): Promise<ReceiverOutcome> {
  const access = receiverAccess(c.env);
  if (!access) return { ok: false, response: c.json({ error: ERR_JUDGE_CONFIG_UNAVAILABLE }, HttpStatus.ServiceUnavailable) };
  const jwt = bearerToken(c);
  if (!jwt) return { ok: false, response: unauthorized(c) };

  const res = await postToReceiver(access, { action, jwt, organization_id: c.get('orgId'), ...fields });
  if (res?.status === HttpStatus.Ok) return { ok: true, body: await res.json().catch(() => null) };
  if (res?.status === HttpStatus.Forbidden) return { ok: false, response: c.json({ error: ERR_JUDGE_CONFIG_OWNER_OR_ADMIN }, HttpStatus.Forbidden) };
  if (res?.status === HttpStatus.ServiceUnavailable) return { ok: false, response: c.json({ error: ERR_JUDGE_CONFIG_UNAVAILABLE }, HttpStatus.ServiceUnavailable) };
  console.error(`[judge-config] receiver ${action} returned ${res?.status ?? NO_RESPONSE_STATUS}`);
  return { ok: false, response: c.json({ error: ERR_JUDGE_CONFIG_FAILED }, HttpStatus.BadGateway) };
}

async function readJudgeConfig(c: AppContext): Promise<JudgeConfig | null> {
  const { data, error } = await db(c.env).from(JUDGE_CONFIGS_TABLE)
    .select('provider,model,key_preview,updated_at')
    .eq('organization_id', c.get('orgId'))
    .limit(1);
  if (error) return null;
  const [row] = parseRows(JudgeConfigRowSchema, data);
  if (!row) return { configured: false };
  return { configured: true, provider: row.provider, model: row.model, keyPreview: row.key_preview, updatedAt: row.updated_at };
}

export function registerJudgeConfigRoutes(app: Hono<AppEnv>): void {
  app.get(JUDGE_CONFIG_API_PATH, requireOrgAdmin, async (c) => {
    const config = await readJudgeConfig(c);
    return config ? c.json(config) : internalError(c, ERR_FETCH_JUDGE_CONFIG);
  });

  app.put(JUDGE_CONFIG_API_PATH, requireOrgAdmin, async (c) => {
    const { provider, model, apiKey } = await readJsonBody(c, SetJudgeConfigRequestSchema);
    const outcome = await forward(c, RECEIVER_ACTION.SET, { provider, model, api_key: apiKey });
    if (!outcome.ok) return outcome.response;
    logAuditEvent(c, 'judge_config.set', c.get('session').appUserId, { organizationId: c.get('orgId') });
    const config = await readJudgeConfig(c);
    return config ? c.json(config) : internalError(c, ERR_FETCH_JUDGE_CONFIG);
  });

  app.delete(JUDGE_CONFIG_API_PATH, requireOrgAdmin, async (c) => {
    const outcome = await forward(c, RECEIVER_ACTION.CLEAR, {});
    if (!outcome.ok) return outcome.response;
    logAuditEvent(c, 'judge_config.clear', c.get('session').appUserId, { organizationId: c.get('orgId') });
    return c.body(null, HttpStatus.NoContent);
  });
}
