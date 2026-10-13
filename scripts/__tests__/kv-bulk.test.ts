/**
 * kvBulkPut, chunkKvPairs and kvBulkDelete (dashboard/scripts/sync-to-kv.ts),
 * driven through the real Cloudflare SDK and HTTP/1.1 fetch against a local
 * server that answers with Cloudflare's own response envelopes.
 *
 * The SDK client is built once per process from CLOUDFLARE_BASE_URL and
 * CLOUDFLARE_API_TOKEN, so both are set before the first request and the
 * server keeps one port for the whole file. It serves TLS offering h2, so the
 * negotiated protocol shows the client really sends through `http1Fetch`.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import {
  DROP_CONNECTION,
  inOrder,
  startRecordingServer,
  type HttpReply,
  type RecordedRequest,
  type RecordingServer,
} from './support/recording-server.js';
import { ALPN_HTTP1_1 } from '../../../src/test-helpers/alpn-server.js';
import { kvBulkPut, kvBulkDelete, chunkKvPairs, KV_BATCH_SIZE, KV_BATCH_MAX_BYTES, type KVEntry } from '../sync-to-kv.js';

const TEST_NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';
const TEST_ACCOUNT_ID = 'test-account-id';
// Placeholder, not a credential: only the local server sees it.
const TEST_API_TOKEN = 'test-api-token';
const NAMESPACE_PATH = `/accounts/${TEST_ACCOUNT_ID}/storage/kv/namespaces/${TEST_NAMESPACE_ID}`;
const BULK_PUT_PATH = `${NAMESPACE_PATH}/bulk`;
const BULK_DELETE_PATH = `${NAMESPACE_PATH}/bulk/delete`;

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const KV_DAILY_WRITE_LIMIT_CODE = 10048;
const AUTHENTICATION_ERROR_CODE = 10000;
const AUTHENTICATION_ERROR_MESSAGE = 'Authentication error';
/** The SDK's default `maxRetries` (2) plus the first attempt. */
const SDK_ATTEMPTS_PER_REQUEST = 3;
/** Covers the SDK's backoff between connection retries (about 0.5 s, then 1 s). */
const CONNECTION_RETRY_TIMEOUT_MS = 10_000;

const JSON_HEADERS = { 'content-type': 'application/json' };
/** Ambient SDK settings that would add credentials or headers to the recorded requests. */
const AMBIENT_SDK_ENV = [
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'CLOUDFLARE_CUSTOM_HEADERS',
  'CLOUDFLARE_LOG',
] as const;

function cloudflareOk(result: unknown): HttpReply {
  return {
    status: HTTP_OK,
    headers: JSON_HEADERS,
    body: JSON.stringify({ success: true, errors: [], messages: [], result }),
  };
}

function cloudflareError(status: number, code: number, message: string, headers: Record<string, string> = {}): HttpReply {
  return {
    status,
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
  };
}

function bulkResult(keyCount: number, unsuccessfulKeys: string[] = []) {
  return cloudflareOk({ successful_key_count: keyCount - unsuccessfulKeys.length, unsuccessful_keys: unsuccessfulKeys });
}

/** Cloudflare's daily-limit refusal; `retry-after: 0` keeps the SDK's retries of it instant. */
const DAILY_LIMIT_REPLY = cloudflareError(
  HTTP_TOO_MANY_REQUESTS, KV_DAILY_WRITE_LIMIT_CODE, 'KV daily write limit exceeded', { 'retry-after': '0' },
);
const AUTHENTICATION_ERROR_REPLY = cloudflareError(HTTP_FORBIDDEN, AUTHENTICATION_ERROR_CODE, AUTHENTICATION_ERROR_MESSAGE);

function entry(key: string): KVEntry {
  return { key, value: JSON.stringify({ metric: key }) };
}

/** An entry whose stored value is `bytes` long, so byte-capped chunking can be driven. */
function sizedEntry(key: string, bytes: number): KVEntry {
  return { key, value: JSON.stringify('x'.repeat(bytes)) };
}

function putPairs(request: RecordedRequest): Array<{ key: string; value: string }> {
  return JSON.parse(request.body) as Array<{ key: string; value: string }>;
}

function deletedKeys(request: RecordedRequest): string[] {
  return JSON.parse(request.body) as string[];
}

function requestKeys(request: RecordedRequest): string[] {
  return request.path === BULK_DELETE_PATH ? deletedKeys(request) : putPairs(request).map(p => p.key);
}

/** Answer every bulk request as fully written. */
function answerAllWritten(request: RecordedRequest): HttpReply {
  return bulkResult(requestKeys(request).length);
}

let cloudflare: RecordingServer;

beforeAll(async () => {
  cloudflare = await startRecordingServer({ tls: true });
  for (const name of AMBIENT_SDK_ENV) vi.stubEnv(name, undefined);
  vi.stubEnv('CLOUDFLARE_BASE_URL', cloudflare.url);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', TEST_API_TOKEN);
  vi.stubEnv('KV_NAMESPACE_ID', TEST_NAMESPACE_ID);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', TEST_ACCOUNT_ID);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await cloudflare.close();
});

beforeEach(() => {
  cloudflare.reset();
  cloudflare.respondWith(answerAllWritten);
  // Both functions report through the console; tests that assert on it read `vi.mocked(console.*)`.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kvBulkPut: empty guard', () => {
  it('returns an empty Set without calling the API', async () => {
    const written = await kvBulkPut([]);

    expect(cloudflare.requests).toHaveLength(0);
    expect(written).toBeInstanceOf(Set);
    expect(written.size).toBe(0);
  });
});

describe('kvBulkPut: successful write', () => {
  it('returns all keys when API reports no failures', async () => {
    const written = await kvBulkPut([entry('metric:a'), entry('metric:b')]);

    expect([...written].sort()).toEqual(['metric:a', 'metric:b']);
  });

  it('returns all keys when the API result is null', async () => {
    cloudflare.respondWith(() => cloudflareOk(null));

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b')]);

    expect(written.size).toBe(2);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('no response body'));
  });
});

describe('kvBulkPut: partial failure via unsuccessful_keys', () => {
  it('excludes failed keys from the returned Set', async () => {
    cloudflare.respondWith(() => bulkResult(3, ['metric:b']));

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b'), entry('metric:c')]);

    expect([...written].sort()).toEqual(['metric:a', 'metric:c']);
  });

  it('emits a warning that names the failed key', async () => {
    cloudflare.respondWith(() => bulkResult(2, ['trace:bad']));

    await kvBulkPut([entry('trace:bad'), entry('trace:good')]);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('trace:bad'));
  });
});

describe('failed-key warnings', () => {
  const failedKeys = ['k:1', 'k:2', 'k:3', 'k:4', 'k:5', 'k:6'];

  it.each([
    ['kvBulkPut', () => kvBulkPut(failedKeys.map(entry))],
    ['kvBulkDelete', () => kvBulkDelete(failedKeys)],
  ])('%s names the first five failed keys and elides the rest', async (_name, run) => {
    cloudflare.respondWith(() => bulkResult(failedKeys.length, failedKeys));

    await run();

    const warning = vi.mocked(console.warn).mock.calls.flat().join('\n');
    expect(warning).toContain('k:1, k:2, k:3, k:4, k:5…');
    expect(warning).not.toContain('k:6');
  });
});

describe('kvBulkPut: daily write limit', () => {
  it('returns the keys of the batches written before the limit and does not throw', async () => {
    const allEntries = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => entry(`metric:${i}`));
    cloudflare.respondWith(inOrder(bulkResult(KV_BATCH_SIZE), DAILY_LIMIT_REPLY));

    const written = await kvBulkPut(allEntries);

    expect(written.size).toBe(KV_BATCH_SIZE);
    expect(written.has(allEntries[KV_BATCH_SIZE]!.key)).toBe(false);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('write limit'));
  });
});

describe('kvBulkPut: request shape', () => {
  it('PUTs to the namespace bulk endpoint with the API token', async () => {
    await kvBulkPut([entry('metric:y')]);

    const [request] = cloudflare.requests;
    expect(request!.method).toBe('PUT');
    expect(request!.path).toBe(BULK_PUT_PATH);
    expect(request!.headers.authorization).toBe(`Bearer ${TEST_API_TOKEN}`);
  });

  it('wraps each value in a version envelope', async () => {
    await kvBulkPut([{ key: 'metric:x', value: '"raw-value"' }]);

    const [pair] = putPairs(cloudflare.requests[0]!);
    expect(pair!.key).toBe('metric:x');
    expect(pair!.value).toMatch(/^\{"v":/);
    expect(pair!.value).toContain('"raw-value"');
  });

  it('negotiates HTTP/1.1 with a server that also offers h2', async () => {
    await kvBulkPut([entry('metric:a')]);

    expect(cloudflare.requests.map(r => r.alpnProtocol)).toEqual([ALPN_HTTP1_1]);
  });
});

describe('kvBulkPut: batching', () => {
  it('issues one request per batch when entries exceed KV_BATCH_SIZE', async () => {
    const entries = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => entry(`metric:${i}`));

    await kvBulkPut(entries);

    expect(cloudflare.requests.map(r => putPairs(r).length)).toEqual([KV_BATCH_SIZE, 1]);
  });

  it('accumulates written keys across multiple batches', async () => {
    const entries = Array.from({ length: KV_BATCH_SIZE + 3 }, (_, i) => entry(`metric:${i}`));

    const written = await kvBulkPut(entries);

    expect(written.size).toBe(entries.length);
  });

  it('excludes failed keys from the correct batch in a multi-batch run', async () => {
    const remainder = 2;
    const entries = Array.from({ length: KV_BATCH_SIZE + remainder }, (_, i) => entry(`metric:${i}`));
    const failedKey = entries[KV_BATCH_SIZE]!.key;
    cloudflare.respondWith(inOrder(bulkResult(KV_BATCH_SIZE), bulkResult(remainder, [failedKey])));

    const written = await kvBulkPut(entries);

    expect(written.has(failedKey)).toBe(false);
    expect(written.size).toBe(entries.length - 1);
  });
});

describe('chunkKvPairs', () => {
  const pair = (key: string, bytes: number) => ({ key, value: 'x'.repeat(bytes) });

  it('starts a new chunk when the next pair would exceed the byte cap', () => {
    const pairs = [pair('a', 40), pair('b', 40), pair('c', 40)];

    const chunks = chunkKvPairs(pairs, 10, 100);

    expect(chunks.map(c => c.map(p => p.key))).toEqual([['a', 'b'], ['c']]);
  });

  it('puts a pair larger than the byte cap in a chunk of its own', () => {
    const pairs = [pair('small', 10), pair('huge', 500), pair('tail', 10)];

    const chunks = chunkKvPairs(pairs, 10, 100);

    expect(chunks.map(c => c.map(p => p.key))).toEqual([['small'], ['huge'], ['tail']]);
  });

  it('still caps chunks by pair count', () => {
    const pairs = Array.from({ length: 5 }, (_, i) => pair(`k${i}`, 1));

    const chunks = chunkKvPairs(pairs, 2, 1_000);

    expect(chunks.map(c => c.length)).toEqual([2, 2, 1]);
  });

  it('counts key bytes toward the cap', () => {
    const pairs = [pair('k'.repeat(60), 0), pair('j'.repeat(60), 0)];

    const chunks = chunkKvPairs(pairs, 10, 100);

    expect(chunks).toHaveLength(2);
  });
});

describe('kvBulkPut: byte-capped requests', () => {
  it('splits entries whose values together exceed KV_BATCH_MAX_BYTES', async () => {
    const half = Math.ceil(KV_BATCH_MAX_BYTES / 2);
    const entries = [sizedEntry('trace:a', half), sizedEntry('trace:b', half), sizedEntry('trace:c', half)];

    const written = await kvBulkPut(entries);

    expect(cloudflare.requests.map(r => putPairs(r).map(p => p.key))).toEqual([['trace:a'], ['trace:b'], ['trace:c']]);
    expect(written.size).toBe(entries.length);
  });
});

describe('kvBulkPut: connection failures', () => {
  it('defers only the chunk that could not connect and writes the rest', async () => {
    const half = Math.ceil(KV_BATCH_MAX_BYTES / 2);
    const entries = [sizedEntry('trace:a', half), sizedEntry('trace:b', half), sizedEntry('trace:c', half)];
    cloudflare.respondWith(request =>
      requestKeys(request).includes('trace:b') ? DROP_CONNECTION : answerAllWritten(request));

    const written = await kvBulkPut(entries);

    expect([...written].sort()).toEqual(['trace:a', 'trace:c']);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('could not connect'));
  }, CONNECTION_RETRY_TIMEOUT_MS);

  it('throws when every request fails to connect, after the SDK retried it', async () => {
    cloudflare.respondWith(() => DROP_CONNECTION);

    await expect(kvBulkPut([entry('metric:a')])).rejects.toThrow('could not connect for any');
    expect(cloudflare.requests).toHaveLength(SDK_ATTEMPTS_PER_REQUEST);
  }, CONNECTION_RETRY_TIMEOUT_MS);

  it('still throws on an API error that is not a connection failure', async () => {
    cloudflare.respondWith(() => AUTHENTICATION_ERROR_REPLY);

    await expect(kvBulkPut([entry('metric:a')])).rejects.toThrow('bulk put failed');
  });
});

describe('kvBulkDelete: empty guard', () => {
  it('does nothing when given an empty key list and returns an empty set', async () => {
    const failed = await kvBulkDelete([]);

    expect(cloudflare.requests).toHaveLength(0);
    expect(failed).toBeInstanceOf(Set);
    expect(failed.size).toBe(0);
  });
});

describe('kvBulkDelete: dry-run', () => {
  it('logs, sends nothing, and returns an empty Set', async () => {
    const failed = await kvBulkDelete(['trace:abc', 'session:xyz'], { dryRun: true });

    expect(cloudflare.requests).toHaveLength(0);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
    expect(failed).toBeInstanceOf(Set);
    expect(failed.size).toBe(0);
  });

  it('dry-run log mentions the batch size and returns empty Set', async () => {
    const failed = await kvBulkDelete(['key:a', 'key:b'], { dryRun: true });

    expect(vi.mocked(console.log)).toHaveBeenCalledWith(expect.stringContaining('2'));
    expect(failed.size).toBe(0);
  });
});

describe('kvBulkDelete: warn-on-failure', () => {
  it('does not throw when the API refuses the request, and returns the batch keys', async () => {
    cloudflare.respondWith(() => AUTHENTICATION_ERROR_REPLY);

    const failed = await kvBulkDelete(['trace:abc']);

    expect([...failed]).toEqual(['trace:abc']);
  });

  it('emits a console.warn that includes the API error message', async () => {
    cloudflare.respondWith(() => AUTHENTICATION_ERROR_REPLY);

    await kvBulkDelete(['trace:abc']);

    const warning = vi.mocked(console.warn).mock.calls.flat().join('\n');
    expect(warning).toContain('bulk delete failed');
    expect(warning).toContain(AUTHENTICATION_ERROR_MESSAGE);
  });
});

describe('kvBulkDelete: partial failure via unsuccessful_keys', () => {
  it('returns only the keys listed in unsuccessful_keys', async () => {
    cloudflare.respondWith(() => bulkResult(2, ['trace:bad']));

    const failed = await kvBulkDelete(['trace:good', 'trace:bad']);

    expect([...failed]).toEqual(['trace:bad']);
  });

  it('returns an empty set when all keys are deleted', async () => {
    const failed = await kvBulkDelete(['trace:good']);

    expect(failed.size).toBe(0);
  });
});

describe('kvBulkDelete: request shape', () => {
  it('POSTs the key array to the namespace bulk-delete endpoint', async () => {
    const keys = ['trace:abc123', 'session:xyz789'];

    await kvBulkDelete(keys);

    expect(cloudflare.requests).toHaveLength(1);
    const [request] = cloudflare.requests;
    expect(request!.method).toBe('POST');
    expect(request!.path).toBe(BULK_DELETE_PATH);
    expect(deletedKeys(request!)).toEqual(keys);
  });
});

describe('kvBulkDelete: batching', () => {
  it('first batch is exactly KV_BATCH_SIZE keys; remainder goes in the second', async () => {
    const remainder = 7;
    const keys = Array.from({ length: KV_BATCH_SIZE + remainder }, (_, i) => `trace:${i}`);

    await kvBulkDelete(keys);

    expect(cloudflare.requests.map(r => deletedKeys(r).length)).toEqual([KV_BATCH_SIZE, remainder]);
  });

  it('accumulates failed keys from both batches when each has failures', async () => {
    const failedInFirst = `trace:${KV_BATCH_SIZE - 1}`;
    const failedInSecond = 'trace:extra';
    const keys = [
      ...Array.from({ length: KV_BATCH_SIZE }, (_, i) => `trace:${i}`),
      failedInSecond,
    ];
    cloudflare.respondWith(inOrder(bulkResult(KV_BATCH_SIZE, [failedInFirst]), bulkResult(1, [failedInSecond])));

    const failed = await kvBulkDelete(keys);

    expect([...failed].sort()).toEqual([failedInFirst, failedInSecond].sort());
  });
});
