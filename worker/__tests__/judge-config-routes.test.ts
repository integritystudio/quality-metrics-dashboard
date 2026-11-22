/**
 * /api/admin/judge: the org's specified judge. Reads come from Supabase; saves and removals go,
 * signed, to the provisioning receiver, which is the network boundary stood in for here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../index.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../../src/lib/http-constants.js';
import { JUDGE_CONFIG_API_PATH } from '../../src/lib/validation/judge-config-schemas.js';
import { RECEIVER_HEADER, signReceiverMessage } from '../receiver-client.js';
import { serveSignedSession } from './support/signed-session.js';
import { NO_STAFF_USER_IDS, makeCtx, makeWorkerEnv } from './support/worker-env.js';

const AUTH0_ID = 'auth0|judge-config-admin';
const APP_USER_ID = 'a0000000-0000-4000-8000-0000000000c1';
const ORG_ID = 'b0000000-0000-4000-8000-0000000000c1';
const RECEIVER_URL = 'https://receiver.test';
const SIGNING_KEY_ID = 'dashboard-v1';
const SIGNING_SECRET = 'test-dashboard-signing-secret';
const PROVIDER_KEY = 'sk-ant-org-provider-key';
const MODEL = 'claude-haiku-5-5';
const UPDATED_AT = '2026-11-22T10:00:00.000000+00:00';

type ReceiverCall = { url: string; headers: Headers; body: Record<string, unknown> };

const { fetchMock, authHeaders, bearerToken } = serveSignedSession(AUTH0_ID);

const json = (body: unknown, status: number = HttpStatus.Ok): Response => new Response(JSON.stringify(body), { status });

/** Supabase as the auth middleware and the read route see it, and the receiver answering `receiverStatus`. Permissions follow the membership role. */
type ServeOptions = { membershipRole?: string; configRows?: unknown[]; receiverStatus?: number };

function serve({ membershipRole = 'admin', configRows = [], receiverStatus = HttpStatus.Ok }: ServeOptions = {}): { receiverCalls: ReceiverCall[]; configReads: string[] } {
  const receiverCalls: ReceiverCall[] = [];
  const configReads: string[] = [];
  fetchMock.mockImplementation((input: string | URL | Request, init?: RequestInit) => Promise.resolve(answer(input, init)));
  function answer(input: string | URL | Request, init?: RequestInit): Response {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(RECEIVER_URL)) {
      receiverCalls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as Record<string, unknown> });
      return json({ ok: true }, receiverStatus);
    }
    if (url.includes('/rest/v1/users')) return json([{ id: APP_USER_ID, email: 'admin@acme.com', default_organization_id: ORG_ID }]);
    if (url.includes('/rest/v1/user_roles')) return json([]);
    if (url.includes('/rest/v1/organization_memberships')) {
      return json([{ role: membershipRole, organization_id: ORG_ID, organizations: { id: ORG_ID, slug: 'acme', name: 'Acme' } }]);
    }
    if (url.includes('/rest/v1/org_judge_configs')) {
      configReads.push(decodeURIComponent(url));
      return json(configRows);
    }
    return json(null);
  }
  return { receiverCalls, configReads };
}

function env(overrides: Record<string, unknown> = {}) {
  return makeWorkerEnv({
    HOME_ORG_ID: ORG_ID,
    STAFF_USER_IDS: NO_STAFF_USER_IDS,
    PROVISIONING_RECEIVER_URL: RECEIVER_URL,
    PROVISIONING_SIGNING_KEY_ID: SIGNING_KEY_ID,
    PROVISIONING_SIGNING_SECRET: SIGNING_SECRET,
    ...overrides,
  });
}

async function request(method: string, body?: unknown, bindings = env()): Promise<Response> {
  return app.request(JUDGE_CONFIG_API_PATH, {
    method,
    headers: { ...authHeaders(), [CONTENT_TYPE_HEADER]: ContentType.Json },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }, bindings, makeCtx());
}

const SAVE = { provider: 'anthropic', model: MODEL, apiKey: PROVIDER_KEY };
const STORED_ROW = { provider: 'anthropic', model: MODEL, key_preview: 'sk-...-key', updated_at: UPDATED_AT };

beforeEach(() => {
  serve();
});

describe('signReceiverMessage', () => {
  it('produces lowercase hex HMAC-SHA256 (RFC 4231 test case 2)', async () => {
    expect(await signReceiverMessage('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe(`GET ${JUDGE_CONFIG_API_PATH}`, () => {
  it('reports no judge when the org has no row', async () => {
    const res = await request('GET');

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ configured: false });
  });

  it('reports the stored provider, model and masked preview, read for the active org only', async () => {
    const { configReads } = serve({ configRows: [STORED_ROW] });

    const res = await request('GET');

    expect(await res.json()).toEqual({ configured: true, provider: 'anthropic', model: MODEL, keyPreview: 'sk-...-key', updatedAt: UPDATED_AT });
    expect(configReads).toEqual([expect.stringContaining(`organization_id=eq.${ORG_ID}`)]);
  });

  it('refuses a session without dashboard.admin', async () => {
    serve({ membershipRole: 'member' });

    expect((await request('GET')).status).toBe(HttpStatus.Forbidden);
  });
});

describe(`PUT ${JUDGE_CONFIG_API_PATH}`, () => {
  it('forwards the save to the receiver, signed, with the caller\'s token and the active org', async () => {
    const { receiverCalls } = serve({ configRows: [STORED_ROW] });

    const res = await request('PUT', SAVE);

    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ configured: true, model: MODEL });
    expect(receiverCalls).toHaveLength(1);
    const [call] = receiverCalls;
    expect(call?.url).toBe(`${RECEIVER_URL}/inbox`);
    expect(call?.body).toEqual({ action: 'set_judge_config', jwt: bearerToken(), organization_id: ORG_ID, provider: 'anthropic', model: MODEL, api_key: PROVIDER_KEY });
    const timestamp = call?.headers.get(RECEIVER_HEADER.TIMESTAMP) ?? '';
    expect(call?.headers.get(RECEIVER_HEADER.KEY_ID)).toBe(SIGNING_KEY_ID);
    expect(call?.headers.get(RECEIVER_HEADER.SIGNATURE)).toBe(await signReceiverMessage(SIGNING_SECRET, `${timestamp}.${JSON.stringify(call?.body)}`));
  });

  it('never returns the provider key', async () => {
    serve({ configRows: [STORED_ROW] });

    const res = await request('PUT', SAVE);

    expect(await res.text()).not.toContain(PROVIDER_KEY);
  });

  it.each([
    ['an unknown provider', { ...SAVE, provider: 'gemini' }],
    ['a model id with spaces', { ...SAVE, model: 'claude haiku' }],
    ['an empty key', { ...SAVE, apiKey: '   ' }],
  ])('rejects %s before calling the receiver', async (_label, body) => {
    const { receiverCalls } = serve();

    expect((await request('PUT', body)).status).toBe(HttpStatus.BadRequest);
    expect(receiverCalls).toEqual([]);
  });

  it.each([
    [HttpStatus.Forbidden, HttpStatus.Forbidden],
    [HttpStatus.ServiceUnavailable, HttpStatus.ServiceUnavailable],
    [HttpStatus.InternalServerError, HttpStatus.BadGateway],
    [HttpStatus.Unauthorized, HttpStatus.BadGateway],
  ])('answers a receiver %i with %i', async (receiverStatus, expected) => {
    serve({ receiverStatus });

    expect((await request('PUT', SAVE)).status).toBe(expected);
  });

  it('answers 503 and sends nothing when the receiver is not configured', async () => {
    const { receiverCalls } = serve();

    const res = await request('PUT', SAVE, env({ PROVISIONING_SIGNING_SECRET: undefined }));

    expect(res.status).toBe(HttpStatus.ServiceUnavailable);
    expect(receiverCalls).toEqual([]);
  });

  it('refuses a session without dashboard.admin before reading the body', async () => {
    const { receiverCalls } = serve({ membershipRole: 'member' });

    expect((await request('PUT', SAVE)).status).toBe(HttpStatus.Forbidden);
    expect(receiverCalls).toEqual([]);
  });
});

describe(`DELETE ${JUDGE_CONFIG_API_PATH}`, () => {
  it('forwards the removal for the active org and answers 204', async () => {
    const { receiverCalls } = serve();

    const res = await request('DELETE');

    expect(res.status).toBe(HttpStatus.NoContent);
    expect(receiverCalls.map(({ body }) => body)).toEqual([{ action: 'clear_judge_config', jwt: bearerToken(), organization_id: ORG_ID }]);
  });
});
