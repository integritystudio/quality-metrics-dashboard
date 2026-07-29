/**
 * Unit tests for kvBulkDelete (dashboard/scripts/sync-to-kv.ts).
 *
 * Covers:
 *  - empty-key early return
 *  - batch file content (JSON array of keys)
 *  - correct wrangler CLI argv (bulk delete, --namespace-id, --remote, --force)
 *  - tmpFile arg in argv matches path passed to writeFileSync
 *  - dry-run: logs, no execFileSync
 *  - warn-on-failure: does not throw; includes error message + stderr in warning
 *  - temp-file cleanup in finally (success and failure)
 *  - KV_BATCH_SIZE batching: correct split and exec count
 */
import { vi, describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

// Keep real fs for resolveNamespaceId() at module load (uses existsSync + readFileSync);
// only stub the write/delete side-effects exercised by kvBulkDelete.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: vi.fn(), unlinkSync: vi.fn() };
});

import { kvBulkDelete, KV_BATCH_SIZE } from '../sync-to-kv.js';

// Value comes from wrangler.toml [[kv_namespaces]][0].id (resolveNamespaceId).
const EXPECTED_NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';

afterEach(() => {
  // resetAllMocks clears call history AND resets mockImplementation to the factory default
  // (vi.fn() returning undefined). clearAllMocks would leave throw implementations
  // in place, causing e.g. the "successful exec" cleanup test to run with a still-throwing mock.
  vi.resetAllMocks();
});

describe('kvBulkDelete: empty guard', () => {
  it('does nothing when given an empty key list', () => {
    kvBulkDelete([]);

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});

describe('kvBulkDelete: batch file content', () => {
  it('writes the key array as JSON to a temp file', () => {
    const keys = ['trace:abc123', 'session:xyz789'];
    kvBulkDelete(keys, { dryRun: true });

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    const writtenContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(JSON.parse(writtenContent)).toEqual(keys);
  });
});

describe('kvBulkDelete: wrangler argv', () => {
  it('invokes npx wrangler kv bulk delete with --namespace-id, --remote, --force', () => {
    kvBulkDelete(['trace:abc']);

    const execMock = vi.mocked(execFileSync);
    expect(execMock).toHaveBeenCalledOnce();
    const [cmd, argv, spawnOpts] = execMock.mock.calls[0] as [string, string[], Record<string, unknown>];

    expect(cmd).toBe('npx');
    expect(argv.slice(0, 4)).toEqual(['wrangler', 'kv', 'bulk', 'delete']);
    expect(argv).toContain('--namespace-id');
    expect(argv).toContain(EXPECTED_NAMESPACE_ID);
    expect(argv).toContain('--remote');
    expect(argv).toContain('--force');
    expect(spawnOpts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('passes the temp file path as argv[4]', () => {
    kvBulkDelete(['trace:abc']);

    const writtenPath = vi.mocked(writeFileSync).mock.calls[0][0] as string;
    const argv = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    expect(argv[4]).toBe(writtenPath);
  });
});

describe('kvBulkDelete: dry-run', () => {
  it('logs and skips execFileSync', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    kvBulkDelete(['trace:abc', 'session:xyz'], { dryRun: true });

    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
    logSpy.mockRestore();
  });

  it('dry-run log mentions the batch size', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    kvBulkDelete(['key:a', 'key:b'], { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
    logSpy.mockRestore();
  });
});

describe('kvBulkDelete: warn-on-failure', () => {
  it('does not throw when execFileSync fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('wrangler exit 1'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => kvBulkDelete(['trace:abc'])).not.toThrow();
    warnSpy.mockRestore();
  });

  it('emits a console.warn that includes the error message', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('wrangler exit 1'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    kvBulkDelete(['trace:abc']);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bulk delete failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('wrangler exit 1'));
    warnSpy.mockRestore();
  });

  it('includes stderr from the error object in the warning', () => {
    const err = Object.assign(new Error('fail'), { stderr: Buffer.from('rate limit exceeded') });
    vi.mocked(execFileSync).mockImplementation(() => { throw err; });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    kvBulkDelete(['key:a']);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rate limit exceeded'));
    warnSpy.mockRestore();
  });
});

describe('kvBulkDelete: temp-file cleanup', () => {
  it('calls unlinkSync after a successful exec', () => {
    kvBulkDelete(['trace:abc']);
    expect(vi.mocked(unlinkSync)).toHaveBeenCalledOnce();
  });

  it('calls unlinkSync even when execFileSync throws', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('fail'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    kvBulkDelete(['trace:abc']);

    expect(vi.mocked(unlinkSync)).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe('kvBulkDelete: batching', () => {
  it('issues one execFileSync call per batch when keys exceed KV_BATCH_SIZE', () => {
    const keys = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => `trace:${i}`);
    kvBulkDelete(keys);

    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2);
  });

  it('first batch is exactly KV_BATCH_SIZE keys; remainder goes in the second batch', () => {
    const remainder = 7;
    const keys = Array.from({ length: KV_BATCH_SIZE + remainder }, (_, i) => `trace:${i}`);
    kvBulkDelete(keys);

    const batch1 = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string) as unknown[];
    const batch2 = JSON.parse(vi.mocked(writeFileSync).mock.calls[1][1] as string) as unknown[];
    expect(batch1).toHaveLength(KV_BATCH_SIZE);
    expect(batch2).toHaveLength(remainder);
  });

  it('cleans up temp file for each batch', () => {
    const keys = Array.from({ length: KV_BATCH_SIZE + 1 }, (_, i) => `trace:${i}`);
    kvBulkDelete(keys);

    expect(vi.mocked(unlinkSync)).toHaveBeenCalledTimes(2);
  });
});
