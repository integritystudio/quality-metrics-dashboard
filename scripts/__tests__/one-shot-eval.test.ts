import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunGuard, EXIT_REFUSED } from '../one-shot-eval.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV } from '../judge-credentials.js';

const MARKER = '.test.started';
const guard = createRunGuard({ markerFilename: MARKER, resultsPrefix: 'test-', logPrefix: '[test]', noun: 'eval' });

describe('createRunGuard', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'one-shot-eval-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('begin writes the start time, pid and payload, then refuses a second start', () => {
    const startedAt = guard.begin(dir, { turns: 3 });

    expect(startedAt).toBeInstanceOf(Date);
    expect(JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))).toEqual({
      startedAt: startedAt!.toISOString(),
      pid: process.pid,
      turns: 3,
    });
    expect(guard.begin(dir, {})).toBeUndefined();
    expect(process.exitCode).toBe(EXIT_REFUSED);
  });

  it('resolveApiKey returns the key when set and refuses when neither variable is', () => {
    vi.stubEnv(JUDGE_API_KEY_ENV, 'judge-key');
    expect(guard.resolveApiKey()).toEqual({ apiKey: 'judge-key', source: JUDGE_API_KEY_ENV });
    expect(process.exitCode).toBeUndefined();

    vi.stubEnv(JUDGE_API_KEY_ENV, '');
    vi.stubEnv(DEFAULT_API_KEY_ENV, '');
    expect(guard.resolveApiKey()).toBeUndefined();
    expect(process.exitCode).toBe(EXIT_REFUSED);
  });
});
