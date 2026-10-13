/**
 * Transport-layer tests for kvSdkFetch (sync-to-kv.ts).
 *
 * These tests send the requests production sends (`PUT …/bulk` and
 * `POST …/bulk/delete`, with bodies) through the real kvSdkFetch wrapper to a
 * loopback recording server. The Cloudflare SDK is NOT used here; we test the
 * wrapper in isolation.
 *
 * kvSdkFetch:
 *  - HTTP 204 → 200 with {"result":null}, the original headers kept, plus
 *    application/json content-type and KV_ORIGINAL_STATUS_HEADER
 *  - The daily-write-limit 429 → same response plus `x-should-retry: false`
 *  - Every other response passes through unchanged (status, headers, body)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startRecordingServer, type RecordingServer } from './support/recording-server.js';
import { kvSdkFetch, KV_ORIGINAL_STATUS_HEADER } from '../sync-to-kv.js';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;
const KV_DAILY_WRITE_LIMIT_CODE = 10048;
const RATE_LIMIT_CODE = 10013;
const AUTHENTICATION_ERROR_CODE = 10000;
const JSON_CONTENT_TYPE = 'application/json';
const SDK_SHOULD_RETRY_HEADER = 'x-should-retry';
const RAY_HEADER = 'cf-ray';
const RAY_ID = '8c1f0e2d3a4b5c6d-DFW';
const NON_JSON_BODY = '<html>Too Many Requests</html>';

const BULK_PUT = {
  method: 'PUT',
  path: '/bulk',
  body: JSON.stringify([{ key: 'metric:a', value: '{"v":1}' }]),
} as const;
const BULK_DELETE = {
  method: 'POST',
  path: '/bulk/delete',
  body: JSON.stringify(['trace:a', 'trace:b']),
} as const;

function errorBody(code: number, message: string): string {
  return JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null });
}

let cloudflare: RecordingServer;

function send(request: typeof BULK_PUT | typeof BULK_DELETE): Promise<Response> {
  return kvSdkFetch(`${cloudflare.url}${request.path}`, {
    method: request.method,
    headers: { 'content-type': JSON_CONTENT_TYPE },
    body: request.body,
  });
}

beforeAll(async () => {
  cloudflare = await startRecordingServer();
});

afterAll(async () => {
  await cloudflare.close();
});

beforeEach(() => {
  cloudflare.reset();
});

describe('kvSdkFetch: request pass-through', () => {
  it.each([
    ['bulk put', BULK_PUT],
    ['bulk delete', BULK_DELETE],
  ])('sends the %s method, path and body unchanged', async (_name, request) => {
    await send(request);

    expect(cloudflare.requests).toHaveLength(1);
    const [recorded] = cloudflare.requests;
    expect(recorded).toMatchObject({ method: request.method, path: request.path, body: request.body });
  });
});

describe('kvSdkFetch: 204 conversion', () => {
  beforeEach(() => {
    cloudflare.respondWith(() => ({ status: HTTP_NO_CONTENT, headers: { [RAY_HEADER]: RAY_ID } }));
  });

  it.each([
    ['bulk put', BULK_PUT],
    ['bulk delete', BULK_DELETE],
  ])('converts a %s 204 to 200 with {"result":null}', async (_name, request) => {
    const response = await send(request);

    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toEqual({ result: null });
  });

  it('sets application/json content-type and marks the original status', async () => {
    const response = await send(BULK_PUT);

    expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
    expect(response.headers.get(KV_ORIGINAL_STATUS_HEADER)).toBe(String(HTTP_NO_CONTENT));
  });

  it('keeps the original response headers', async () => {
    const response = await send(BULK_PUT);

    expect(response.headers.get(RAY_HEADER)).toBe(RAY_ID);
  });
});

describe('kvSdkFetch: daily write limit', () => {
  const body = errorBody(KV_DAILY_WRITE_LIMIT_CODE, 'KV daily write limit exceeded');

  beforeEach(() => {
    cloudflare.respondWith(() => ({
      status: HTTP_TOO_MANY_REQUESTS,
      headers: { 'content-type': JSON_CONTENT_TYPE, [RAY_HEADER]: RAY_ID },
      body,
    }));
  });

  it('marks the response not to be retried', async () => {
    const response = await send(BULK_PUT);

    expect(response.headers.get(SDK_SHOULD_RETRY_HEADER)).toBe('false');
  });

  it('keeps the status, headers and body', async () => {
    const response = await send(BULK_PUT);

    expect(response.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(response.headers.get(RAY_HEADER)).toBe(RAY_ID);
    await expect(response.text()).resolves.toBe(body);
  });
});

describe('kvSdkFetch: pass-through for other responses', () => {
  it.each([
    ['a 200 bulk result', HTTP_OK, '{"result":{"unsuccessful_keys":[]}}'],
    ['a 400 authentication error', HTTP_BAD_REQUEST, errorBody(AUTHENTICATION_ERROR_CODE, 'Authentication error')],
    ['a 429 that is not the daily limit', HTTP_TOO_MANY_REQUESTS, errorBody(RATE_LIMIT_CODE, 'Rate limited')],
    ['a 429 whose body is not JSON', HTTP_TOO_MANY_REQUESTS, NON_JSON_BODY],
  ])('returns %s unchanged', async (_name, status, body) => {
    cloudflare.respondWith(() => ({
      status,
      headers: { 'content-type': JSON_CONTENT_TYPE, [RAY_HEADER]: RAY_ID },
      body,
    }));

    const response = await send(BULK_PUT);

    expect(response.status).toBe(status);
    expect(response.headers.get(RAY_HEADER)).toBe(RAY_ID);
    expect(response.headers.get(SDK_SHOULD_RETRY_HEADER)).toBeNull();
    expect(response.headers.get(KV_ORIGINAL_STATUS_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe(body);
  });
});
