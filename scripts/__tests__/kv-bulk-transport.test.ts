/**
 * Transport-layer tests for kvSdkFetch (sync-to-kv.ts).
 *
 * These tests use a real loopback HTTP server and the real kvSdkFetch wrapper
 * (no cloudflare SDK mock) to pin the 204-to-200 conversion at the fetch boundary.
 * The Cloudflare SDK is NOT used here; we test the wrapper in isolation.
 *
 * kvSdkFetch:
 *  - HTTP 204 → 200 with {"result":null} body and application/json content-type
 *  - Non-204 responses pass through unchanged (status, headers, body)
 *  - The original 204 body (if any) is replaced, not forwarded
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { kvSdkFetch } from '../sync-to-kv.js';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;

describe('kvSdkFetch: 204 conversion', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(HTTP_NO_CONTENT);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('converts HTTP 204 to 200 with {"result":null} body', async () => {
    const response = await kvSdkFetch(`${baseURL}/bulk`);

    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toEqual({ result: null });
  });

  it('sets application/json content-type on the synthetic response', async () => {
    const response = await kvSdkFetch(`${baseURL}/bulk`);

    expect(response.headers.get('content-type')).toBe('application/json');
  });
});

describe('kvSdkFetch: pass-through for non-204 responses', () => {
  let server: Server;
  let baseURL: string;
  const BODY = '{"result":{"unsuccessful_keys":[]}}';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(HTTP_OK, { 'content-type': 'application/json' });
      res.end(BODY);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('returns the original response for non-204 status', async () => {
    const response = await kvSdkFetch(`${baseURL}/bulk`);

    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toEqual({ result: { unsuccessful_keys: [] } });
  });
});

describe('kvSdkFetch: pass-through for error responses', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(HTTP_BAD_REQUEST, { 'content-type': 'application/json' });
      res.end('{"errors":[{"code":10000,"message":"Authentication error"}]}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('passes error responses through unchanged', async () => {
    const response = await kvSdkFetch(`${baseURL}/bulk`);

    expect(response.status).toBe(HTTP_BAD_REQUEST);
  });
});
