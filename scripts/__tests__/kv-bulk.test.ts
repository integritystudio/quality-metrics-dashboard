/**
 * Unit tests for kvBulkPut, chunkKvPairs and kvBulkDelete (dashboard/scripts/sync-to-kv.ts),
 * against one stubbed Cloudflare SDK.
 *
 * kvBulkPut:
 *  - empty-entry early return (returns empty Set)
 *  - partial failure via unsuccessful_keys: failed keys excluded from returned Set
 *  - null API result (204 No Content): credits all keys
 *  - KV daily write limit (code 10048): returns partial Set, does not throw
 *  - SDK call shape: body envelope includes version wrapper, credentials, namespace
 *  - batching: correct split, call count, and Set accumulation across KV_BATCH_SIZE
 *  - multi-batch partial failure: failed keys from all batches are excluded
 *  - byte-capped chunking (chunkKvPairs) and per-chunk connection failures
 *  - the SDK client is built on the HTTP/1.1 fetch
 *
 * kvBulkDelete:
 *  - empty-key early return
 *  - dry-run: logs, no SDK call
 *  - warn-on-failure: does not throw; includes error message in warning
 *  - KV_BATCH_SIZE batching: correct split and SDK call count
 *  - passes correct body and credentials to SDK bulkDelete
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockBulkUpdate = vi.fn().mockResolvedValue(null);
const mockBulkDelete = vi.fn().mockResolvedValue(null);
/** Constructor options of the (lazily built, cached) SDK client; not reset by clearAllMocks. */
const { clientOptions, http1FetchSentinel } = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  http1FetchSentinel: vi.fn(),
}));

vi.mock('../../../src/lib/core/http1-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/core/http1-fetch.js')>()),
  http1Fetch: http1FetchSentinel,
}));

vi.mock('cloudflare', () => {
  class APIError extends Error {
    status: number;
    errors: Array<{ code?: number }>;
    headers: Headers | undefined;
    error: object | undefined;
    constructor(status: number, errors: Array<{ code?: number }>, message: string) {
      super(message);
      this.status = status;
      this.errors = errors;
      this.headers = undefined;
      this.error = undefined;
    }
  }
  class APIConnectionError extends APIError {
    constructor({ cause }: { cause?: Error } = {}) {
      super(0, [], 'Connection error.');
      this.cause = cause;
    }
  }
  function CloudflareClass(this: Record<string, unknown>, options: unknown) {
    clientOptions.push(options);
    this['kv'] = { namespaces: { bulkUpdate: mockBulkUpdate, bulkDelete: mockBulkDelete } };
  }
  const CloudflareMock = vi.fn().mockImplementation(CloudflareClass);
  return {
    default: Object.assign(CloudflareMock, { APIError, APIConnectionError }),
    APIError,
    APIConnectionError,
  };
});

const TEST_NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';
const TEST_ACCOUNT_ID = 'test-account-id';

import { kvBulkPut, kvBulkDelete, chunkKvPairs, KV_BATCH_SIZE, KV_BATCH_MAX_BYTES, type KVEntry } from '../sync-to-kv.js';

function entry(key: string): KVEntry {
  return { key, value: JSON.stringify({ metric: key }) };
}

/** An entry whose stored value is `bytes` long, so byte-capped chunking can be driven. */
function sizedEntry(key: string, bytes: number): KVEntry {
  return { key, value: JSON.stringify('x'.repeat(bytes)) };
}

async function connectionError(): Promise<Error> {
  const { APIConnectionError } = await import('cloudflare');
  return new (APIConnectionError as unknown as new (o: { cause?: Error }) => Error)({
    cause: new TypeError('fetch failed'),
  });
}

beforeEach(() => {
  process.env.KV_NAMESPACE_ID = TEST_NAMESPACE_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = TEST_ACCOUNT_ID;
  // Both functions report through the console; tests that assert on it read `vi.mocked(console.*)`.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.KV_NAMESPACE_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  vi.restoreAllMocks();
  // clearAllMocks resets call history but keeps each SDK stub's implementation,
  // so the cached Cloudflare client stays callable across tests.
  vi.clearAllMocks();
});

describe('kvBulkPut: empty guard', () => {
  it('returns an empty Set without calling the API', async () => {
    const written = await kvBulkPut([]);

    expect(mockBulkUpdate).not.toHaveBeenCalled();
    expect(written).toBeInstanceOf(Set);
    expect(written.size).toBe(0);
  });
});

describe('kvBulkPut: successful write', () => {
  it('returns all keys when API reports no failures', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });
    const entries = [entry('metric:a'), entry('metric:b')];

    const written = await kvBulkPut(entries);

    expect(written.has('metric:a')).toBe(true);
    expect(written.has('metric:b')).toBe(true);
    expect(written.size).toBe(2);
  });

  it('returns all keys when API returns null (204 No Content)', async () => {
    mockBulkUpdate.mockResolvedValueOnce(null);

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b')]);

    expect(written.size).toBe(2);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('no response body'));
  });
});

describe('kvBulkPut: partial failure via unsuccessful_keys', () => {
  it('excludes failed keys from the returned Set', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: ['metric:b'] });

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b'), entry('metric:c')]);

    expect(written.has('metric:a')).toBe(true);
    expect(written.has('metric:b')).toBe(false);
    expect(written.has('metric:c')).toBe(true);
    expect(written.size).toBe(2);
  });

  it('emits a warning that names the failed key', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: ['trace:bad'] });

    await kvBulkPut([entry('trace:bad'), entry('trace:good')]);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('trace:bad'));
  });
});

describe('failed-key warnings', () => {
  const failedKeys = ['k:1', 'k:2', 'k:3', 'k:4', 'k:5', 'k:6'];

  it.each([
    ['kvBulkPut', async () => {
      mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: failedKeys });
      await kvBulkPut(failedKeys.map(entry));
    }],
    ['kvBulkDelete', async () => {
      mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: failedKeys });
      await kvBulkDelete(failedKeys);
    }],
  ])('%s names the first five failed keys and elides the rest', async (_name, run) => {
    await run();

    const warning = vi.mocked(console.warn).mock.calls.flat().join('\n');
    expect(warning).toContain('k:1, k:2, k:3, k:4, k:5…');
    expect(warning).not.toContain('k:6');
  });
});

describe('kvBulkPut: daily write limit', () => {
  it('returns a partial Set (first batch written) and does not throw', async () => {
    // Simulate: first batch writes one entry, then hits the limit.
    // With KV_BATCH_SIZE > 1, putting two entries in one batch means
    // the limit fires in the catch block before the second batch starts.
    // To force two batches, use KV_BATCH_SIZE + 1 entries.
    const allEntries = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => entry(`metric:${i}`));
    // First batch succeeds; second batch throws the daily limit error.
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });
    const { APIError } = await import('cloudflare');
    mockBulkUpdate.mockRejectedValueOnce(
      new (APIError as unknown as new (status: number, errors: Array<{ code?: number }>, msg: string) => Error)(
        429, [{ code: 10048 }], 'KV daily limit reached',
      ),
    );

    const written = await kvBulkPut(allEntries);

    // First batch (KV_BATCH_SIZE entries) written; second batch (1 entry) not.
    expect(written.size).toBe(KV_BATCH_SIZE);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('write limit'));
  });
});

describe('kvBulkPut: SDK call shape', () => {
  it('wraps each value in a version envelope', async () => {
    mockBulkUpdate.mockResolvedValueOnce(null);
    await kvBulkPut([{ key: 'metric:x', value: '"raw-value"' }]);

    const [, params] = mockBulkUpdate.mock.calls[0] as [string, { body: Array<{ key: string; value: string }> }];
    const firstBody = params.body[0]!;
    expect(firstBody.value).toMatch(/^\{"v":/);
    expect(firstBody.value).toContain('"raw-value"');
  });

  it('passes namespace id and account id', async () => {
    mockBulkUpdate.mockResolvedValueOnce(null);
    await kvBulkPut([entry('metric:y')]);

    const [namespaceId, params] = mockBulkUpdate.mock.calls[0] as [string, { account_id: string }];
    expect(namespaceId).toBe(TEST_NAMESPACE_ID);
    expect(params.account_id).toBe(TEST_ACCOUNT_ID);
  });
});

describe('kvBulkPut: batching', () => {
  it('issues one SDK call per batch when entries exceed KV_BATCH_SIZE', async () => {
    mockBulkUpdate.mockResolvedValue({ unsuccessful_keys: [] });
    const entries = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => entry(`metric:${i}`));

    await kvBulkPut(entries);

    expect(mockBulkUpdate).toHaveBeenCalledTimes(2);
  });

  it('accumulates written keys across multiple batches', async () => {
    mockBulkUpdate.mockResolvedValue({ unsuccessful_keys: [] });
    const entries = Array.from({ length: KV_BATCH_SIZE + 3 }, (_, i) => entry(`metric:${i}`));

    const written = await kvBulkPut(entries);

    expect(written.size).toBe(entries.length);
  });

  it('excludes failed keys from the correct batch in a multi-batch run', async () => {
    const remainder = 2;
    const entries = Array.from({ length: KV_BATCH_SIZE + remainder }, (_, i) => entry(`metric:${i}`));
    const failedKey = entries[KV_BATCH_SIZE]!.key; // first key of second batch

    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [failedKey] });

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
    mockBulkUpdate.mockResolvedValue({ unsuccessful_keys: [] });
    const half = Math.ceil(KV_BATCH_MAX_BYTES / 2);
    const entries = [sizedEntry('trace:a', half), sizedEntry('trace:b', half), sizedEntry('trace:c', half)];

    const written = await kvBulkPut(entries);

    expect(mockBulkUpdate).toHaveBeenCalledTimes(entries.length);
    expect(written.size).toBe(entries.length);
  });
});

describe('kvBulkPut: connection failures', () => {
  it('defers only the chunk that could not connect and writes the rest', async () => {
    const half = Math.ceil(KV_BATCH_MAX_BYTES / 2);
    const entries = [sizedEntry('trace:a', half), sizedEntry('trace:b', half), sizedEntry('trace:c', half)];
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });
    mockBulkUpdate.mockRejectedValueOnce(await connectionError());
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });

    const written = await kvBulkPut(entries);

    expect([...written].sort()).toEqual(['trace:a', 'trace:c']);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('could not connect'));
  });

  it('throws when every request fails to connect', async () => {
    mockBulkUpdate.mockRejectedValue(await connectionError());

    await expect(kvBulkPut([entry('metric:a')])).rejects.toThrow('could not connect for any');
  });

  it('still throws on an API error that is not a connection failure', async () => {
    const { APIError } = await import('cloudflare');
    mockBulkUpdate.mockRejectedValueOnce(
      new (APIError as unknown as new (status: number, errors: Array<{ code?: number }>, msg: string) => Error)(
        403, [{ code: 10000 }], 'Authentication error',
      ),
    );

    await expect(kvBulkPut([entry('metric:a')])).rejects.toThrow('bulk put failed');
  });
});

describe('kvBulkPut: transport', () => {
  it('builds the SDK client on the HTTP/1.1 fetch', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: [] });

    await kvBulkPut([entry('metric:a')]);

    expect(clientOptions).toEqual([{ fetch: http1FetchSentinel }]);
  });
});

describe('kvBulkDelete: empty guard', () => {
  it('does nothing when given an empty key list and returns an empty set', async () => {
    const failed = await kvBulkDelete([]);
    expect(mockBulkDelete).not.toHaveBeenCalled();
    expect(failed).toBeInstanceOf(Set);
    expect(failed.size).toBe(0);
  });
});

describe('kvBulkDelete: dry-run', () => {
  it('logs, skips SDK call, and returns an empty Set', async () => {

    const failed = await kvBulkDelete(['trace:abc', 'session:xyz'], { dryRun: true });

    expect(mockBulkDelete).not.toHaveBeenCalled();
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
  it('does not throw when SDK call fails, and returns the failed keys', async () => {
    mockBulkDelete.mockRejectedValueOnce(new Error('network error'));

    const failed = await kvBulkDelete(['trace:abc']);
    expect(failed).toBeInstanceOf(Set);
    expect(failed.has('trace:abc')).toBe(true);
  });

  it('emits a console.warn that includes the error message', async () => {
    mockBulkDelete.mockRejectedValueOnce(new Error('connection refused'));

    await kvBulkDelete(['trace:abc']);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('bulk delete failed'));
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });
});

describe('kvBulkDelete: partial failure via unsuccessful_keys', () => {
  it('returns only the keys listed in unsuccessful_keys', async () => {
    mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: ['trace:bad'] });

    const failed = await kvBulkDelete(['trace:good', 'trace:bad']);

    expect(failed.has('trace:bad')).toBe(true);
    expect(failed.has('trace:good')).toBe(false);
    expect(failed.size).toBe(1);
  });

  it('returns an empty set when all keys are deleted', async () => {
    mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: [] });
    const failed = await kvBulkDelete(['trace:good']);

    expect(failed.size).toBe(0);
  });
});

describe('kvBulkDelete: SDK call shape', () => {
  it('passes the key array as body to bulkDelete', async () => {
    mockBulkDelete.mockResolvedValueOnce(null);
    const keys = ['trace:abc123', 'session:xyz789'];
    await kvBulkDelete(keys);

    expect(mockBulkDelete).toHaveBeenCalledOnce();
    const [, params] = mockBulkDelete.mock.calls[0] as [string, { account_id: string; body: string[] }];
    expect(params.body).toEqual(keys);
  });

  it('passes namespace id and account id', async () => {
    mockBulkDelete.mockResolvedValueOnce(null);
    await kvBulkDelete(['trace:abc']);

    const [namespaceId, params] = mockBulkDelete.mock.calls[0] as [string, { account_id: string; body: string[] }];
    expect(namespaceId).toBe(TEST_NAMESPACE_ID);
    expect(params.account_id).toBe(TEST_ACCOUNT_ID);
  });
});

describe('kvBulkDelete: batching', () => {
  it('issues one SDK call per batch when keys exceed KV_BATCH_SIZE', async () => {
    mockBulkDelete.mockResolvedValue(null);
    const keys = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => `trace:${i}`);
    await kvBulkDelete(keys);

    expect(mockBulkDelete).toHaveBeenCalledTimes(2);
  });

  it('first batch is exactly KV_BATCH_SIZE keys; remainder goes in the second', async () => {
    mockBulkDelete.mockResolvedValue(null);
    const remainder = 7;
    const keys = Array.from({ length: KV_BATCH_SIZE + remainder }, (_, i) => `trace:${i}`);
    await kvBulkDelete(keys);

    const [, params1] = mockBulkDelete.mock.calls[0] as [string, { body: string[] }];
    const [, params2] = mockBulkDelete.mock.calls[1] as [string, { body: string[] }];
    expect(params1.body).toHaveLength(KV_BATCH_SIZE);
    expect(params2.body).toHaveLength(remainder);
  });

  it('accumulates failed keys from both batches when each has failures', async () => {
    const failedInFirst = `trace:${KV_BATCH_SIZE - 1}`;
    const failedInSecond = 'trace:extra';
    const keys = [
      ...Array.from({ length: KV_BATCH_SIZE }, (_, i) => `trace:${i}`),
      failedInSecond,
    ];
    mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: [failedInFirst] });
    mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: [failedInSecond] });

    const failed = await kvBulkDelete(keys);

    expect(failed.has(failedInFirst)).toBe(true);
    expect(failed.has(failedInSecond)).toBe(true);
    expect(failed.size).toBe(2);
  });
});
