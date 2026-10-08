/**
 * Unit tests for kvBulkDelete (dashboard/scripts/sync-to-kv.ts).
 *
 * Covers:
 *  - empty-key early return
 *  - dry-run: logs, no SDK call
 *  - warn-on-failure: does not throw; includes error message in warning
 *  - KV_BATCH_SIZE batching: correct split and SDK call count
 *  - passes correct body and credentials to SDK bulkDelete
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Stub the Cloudflare SDK before importing the module under test.
const mockBulkDelete = vi.fn().mockResolvedValue(null);
const mockBulkUpdate = vi.fn().mockResolvedValue(null);

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
  // Use a regular function (not arrow) so `new CloudflareClass()` correctly
  // sets instance properties on `this`, which vitest requires for constructor mocks.
  function CloudflareClass(this: Record<string, unknown>) {
    this['kv'] = { namespaces: { bulkDelete: mockBulkDelete, bulkUpdate: mockBulkUpdate } };
  }
  const CloudflareMock = vi.fn().mockImplementation(CloudflareClass);
  return { default: Object.assign(CloudflareMock, { APIError }), APIError };
});

// Use env vars for config resolution so no smol-toml or fs mocking is needed.
const TEST_NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';
const TEST_ACCOUNT_ID = 'test-account-id';

import { kvBulkDelete, KV_BATCH_SIZE } from '../sync-to-kv.js';

beforeEach(() => {
  process.env.KV_NAMESPACE_ID = TEST_NAMESPACE_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = TEST_ACCOUNT_ID;
});

afterEach(() => {
  delete process.env.KV_NAMESPACE_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  // clearAllMocks resets call history but preserves mockImplementation, so the
  // cached Cloudflare client's methods remain callable across tests.
  vi.clearAllMocks();
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
  it('logs and skips SDK call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kvBulkDelete(['trace:abc', 'session:xyz'], { dryRun: true });

    expect(mockBulkDelete).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
    logSpy.mockRestore();
  });

  it('dry-run log mentions the batch size', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kvBulkDelete(['key:a', 'key:b'], { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
    logSpy.mockRestore();
  });
});

describe('kvBulkDelete: warn-on-failure', () => {
  it('does not throw when SDK call fails, and returns the failed keys', async () => {
    mockBulkDelete.mockRejectedValueOnce(new Error('network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const failed = await kvBulkDelete(['trace:abc']);
    expect(failed).toBeInstanceOf(Set);
    expect(failed.has('trace:abc')).toBe(true);
    warnSpy.mockRestore();
  });

  it('emits a console.warn that includes the error message', async () => {
    mockBulkDelete.mockRejectedValueOnce(new Error('connection refused'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await kvBulkDelete(['trace:abc']);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bulk delete failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    warnSpy.mockRestore();
  });
});

describe('kvBulkDelete: partial failure via unsuccessful_keys', () => {
  it('returns only the keys listed in unsuccessful_keys', async () => {
    mockBulkDelete.mockResolvedValueOnce({ unsuccessful_keys: ['trace:bad'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const failed = await kvBulkDelete(['trace:good', 'trace:bad']);

    expect(failed.has('trace:bad')).toBe(true);
    expect(failed.has('trace:good')).toBe(false);
    expect(failed.size).toBe(1);
    warnSpy.mockRestore();
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
});
