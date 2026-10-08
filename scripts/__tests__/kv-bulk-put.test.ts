/**
 * Unit tests for kvBulkPut (dashboard/scripts/sync-to-kv.ts).
 *
 * Covers:
 *  - empty-entry early return (returns empty Set)
 *  - partial failure via unsuccessful_keys: failed keys excluded from returned Set
 *  - null API result (204 No Content): credits all keys
 *  - KV daily write limit (code 10048): returns partial Set, does not throw
 *  - SDK call shape: body envelope includes version wrapper, credentials, namespace
 *  - batching: correct split, call count, and Set accumulation across KV_BATCH_SIZE
 *  - multi-batch partial failure: failed keys from all batches are excluded
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockBulkUpdate = vi.fn().mockResolvedValue(null);
const mockBulkDelete = vi.fn().mockResolvedValue(null);

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
  function CloudflareClass(this: Record<string, unknown>) {
    this['kv'] = { namespaces: { bulkUpdate: mockBulkUpdate, bulkDelete: mockBulkDelete } };
  }
  const CloudflareMock = vi.fn().mockImplementation(CloudflareClass);
  return { default: Object.assign(CloudflareMock, { APIError }), APIError };
});

const TEST_NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';
const TEST_ACCOUNT_ID = 'test-account-id';

import { kvBulkPut, KV_BATCH_SIZE, type KVEntry } from '../sync-to-kv.js';

function entry(key: string): KVEntry {
  return { key, value: JSON.stringify({ metric: key }) };
}

beforeEach(() => {
  process.env.KV_NAMESPACE_ID = TEST_NAMESPACE_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = TEST_ACCOUNT_ID;
});

afterEach(() => {
  delete process.env.KV_NAMESPACE_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b')]);

    expect(written.size).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no response body'));
    warnSpy.mockRestore();
  });
});

describe('kvBulkPut: partial failure via unsuccessful_keys', () => {
  it('excludes failed keys from the returned Set', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: ['metric:b'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const written = await kvBulkPut([entry('metric:a'), entry('metric:b'), entry('metric:c')]);

    expect(written.has('metric:a')).toBe(true);
    expect(written.has('metric:b')).toBe(false);
    expect(written.has('metric:c')).toBe(true);
    expect(written.size).toBe(2);
    warnSpy.mockRestore();
  });

  it('emits a warning that names the failed key', async () => {
    mockBulkUpdate.mockResolvedValueOnce({ unsuccessful_keys: ['trace:bad'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await kvBulkPut([entry('trace:bad'), entry('trace:good')]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('trace:bad'));
    warnSpy.mockRestore();
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const written = await kvBulkPut(allEntries);

    // First batch (KV_BATCH_SIZE entries) written; second batch (1 entry) not.
    expect(written.size).toBe(KV_BATCH_SIZE);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('write limit'));
    warnSpy.mockRestore();
  });
});

describe('kvBulkPut: SDK call shape', () => {
  it('wraps each value in a version envelope', async () => {
    mockBulkUpdate.mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await kvBulkPut([{ key: 'metric:x', value: '"raw-value"' }]);

    const [, params] = mockBulkUpdate.mock.calls[0] as [string, { body: Array<{ key: string; value: string }> }];
    const firstBody = params.body[0]!;
    expect(firstBody.value).toMatch(/^\{"v":/);
    expect(firstBody.value).toContain('"raw-value"');
    warnSpy.mockRestore();
  });

  it('passes namespace id and account id', async () => {
    mockBulkUpdate.mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await kvBulkPut([entry('metric:y')]);

    const [namespaceId, params] = mockBulkUpdate.mock.calls[0] as [string, { account_id: string }];
    expect(namespaceId).toBe(TEST_NAMESPACE_ID);
    expect(params.account_id).toBe(TEST_ACCOUNT_ID);
    warnSpy.mockRestore();
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const written = await kvBulkPut(entries);

    expect(written.has(failedKey)).toBe(false);
    expect(written.size).toBe(entries.length - 1);
    warnSpy.mockRestore();
  });
});
