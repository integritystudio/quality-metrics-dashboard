import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createRunGuard,
  formatUsd,
  spendCapReason,
  tableRow,
  EXIT_REFUSED,
  RESULTS_SUFFIX,
  TABLE_NAME_WIDTH,
  YES_FLAG,
  YES_REQUIRED_ERROR,
} from '../one-shot-eval.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV } from '../judge-credentials.js';
import * as agreement from '../judge-agreement.js';
import * as quality from '../judge-quality-eval.js';
import * as hallucination from '../judge-hallucination-eval.js';

const MARKER = '.test.started';
const RESULTS_PREFIX = 'test-';
const guard = createRunGuard({ markerFilename: MARKER, resultsPrefix: RESULTS_PREFIX, logPrefix: '[test]', noun: 'eval' });
const RESULTS_DAY = new Date('2026-09-22T00:00:00Z');
const RESULTS_NAME = `2026-09-22${RESULTS_SUFFIX}`;

/** The three one-shot evals' run-once configuration, each guarding its own docs files. */
const SCRIPTS = [
  { name: 'judge-agreement', ...agreement },
  { name: 'judge-quality-eval', ...quality },
  { name: 'judge-hallucination-eval', ...hallucination },
] as const;

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

  it('allows a fresh dir and refuses an existing results file or marker', () => {
    expect(guard.refusalReason(dir)).toBeUndefined();

    expect(guard.resultsFilePath(dir, RESULTS_DAY)).toBe(join(dir, `${RESULTS_PREFIX}${RESULTS_NAME}`));
    writeFileSync(guard.resultsFilePath(dir, RESULTS_DAY), '{}');
    expect(guard.listResultsFiles(dir)).toEqual([`${RESULTS_PREFIX}${RESULTS_NAME}`]);
    expect(guard.refusalReason(dir)).toMatch(/results already exist/);

    rmSync(guard.resultsFilePath(dir, RESULTS_DAY));
    writeFileSync(join(dir, MARKER), '{}');
    expect(guard.refusalReason(dir)).toMatch(/marker exists/);
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

describe.each(SCRIPTS)('$name parseArgs', ({ parseArgs }) => {
  it('requires --yes and has no --force flag', () => {
    expect(parseArgs([]).error).toBe(YES_REQUIRED_ERROR);
    expect(parseArgs([YES_FLAG]).error).toBeUndefined();
    expect(parseArgs([YES_FLAG, '--force']).error).toMatch(/Unknown argument: --force/);
  });
});

describe.each(SCRIPTS)('$name run-once files', ({ refusalReason, MARKER_FILENAME, RESULTS_PREFIX: prefix }) => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'one-shot-scripts-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is blocked by its own results or marker, never by another eval\'s', () => {
    for (const other of SCRIPTS.filter(s => s.RESULTS_PREFIX !== prefix)) {
      writeFileSync(join(dir, other.MARKER_FILENAME), '{}');
      writeFileSync(join(dir, `${other.RESULTS_PREFIX}${RESULTS_NAME}`), '{}');
    }
    expect(refusalReason(dir)).toBeUndefined();

    writeFileSync(join(dir, `${prefix}${RESULTS_NAME}`), '{}');
    expect(refusalReason(dir)).toMatch(/results already exist/);
    rmSync(join(dir, `${prefix}${RESULTS_NAME}`));
    writeFileSync(join(dir, MARKER_FILENAME), '{}');
    expect(refusalReason(dir)).toMatch(/marker exists/);
  });
});

describe('formatUsd', () => {
  it('prefixes a dollar sign and fixes the decimals', () => {
    expect(formatUsd(1.81234)).toBe('$1.8123');
    expect(formatUsd(0)).toBe('$0.0000');
  });
});

describe('spendCapReason', () => {
  it('allows an estimate at the cap and refuses one above it, with the remedy', () => {
    expect(spendCapReason(8, 8)).toBeUndefined();
    expect(spendCapReason(8.5, 8)).toBe('estimated spend $8.5000 exceeds the $8 cap');
    expect(spendCapReason(8.5, 8, 'lower --limit')).toBe('estimated spend $8.5000 exceeds the $8 cap; lower --limit');
  });
});

describe('tableRow', () => {
  it('pads the name column and right-aligns each cell', () => {
    const CELL = 6;
    expect(tableRow(CELL, 'overall', 3, '50.0%')).toBe(`${'overall'.padEnd(TABLE_NAME_WIDTH)}     3 50.0%`);
  });
});
