/**
 * Scaffolding shared by the one-shot paid evals (judge-agreement,
 * judge-quality-eval, judge-hallucination-eval): each spends real API money,
 * runs once, and refuses a second start.
 */

import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { toDateOnly } from '../src/api/api-constants.js';
import { CliArgError } from './cli-args.js';

export const YES_FLAG = '--yes';
export const RESULTS_SUFFIX = '.json';
export const JSON_INDENT = 2;
/** Every call goes out at once; the evals are small and bounded by their spend caps. */
export const NO_BATCH_DELAY_MS = 0;
export const USD_DECIMALS = 4;
export const TABLE_NAME_WIDTH = 18;
export const EXIT_REFUSED = 1;
const PERCENT = 100;
const RATE_DECIMALS = 1;
const DIFF_DECIMALS = 3;

/** The refusal for a run without `--yes`. */
export const YES_REQUIRED_ERROR = `${YES_FLAG} is required: this run spends real API money`;

/** Appended to an unknown-argument refusal: the one-shot evals have no override. */
const NO_FORCE_HINT = '(there is no --force; remove the marker and results file by hand if you mean it)';

/** A one-shot eval's refusal for a bad command line; rethrows anything else. */
export function oneShotArgError(err: unknown): string {
  if (!(err instanceof CliArgError)) throw err;
  return err.kind === 'unknown' ? `${err.message} ${NO_FORCE_HINT}` : err.message;
}

export interface RunGuardConfig {
  /** Created when a run starts; its presence refuses every later start. */
  markerFilename: string;
  /** Results are `<resultsPrefix><YYYY-MM-DD>.json`. */
  resultsPrefix: string;
  /** Console prefix, e.g. `[agreement]`. */
  logPrefix: string;
  /** What the refusal calls the run, e.g. `check` or `eval`. */
  noun: string;
}

export interface RunGuard {
  listResultsFiles: (docsDir: string) => string[];
  resultsFilePath: (docsDir: string, date: Date) => string;
  /** Why the run must not start, or undefined when it may. */
  refusalReason: (docsDir: string) => string | undefined;
  /** O_CREAT | O_EXCL: two concurrent starts cannot both win. */
  writeMarker: (docsDir: string, payload: object) => void;
  /** Log the refusal and set a failing exit code. */
  refuse: (message: string) => void;
}

export function createRunGuard({ markerFilename, resultsPrefix, logPrefix, noun }: RunGuardConfig): RunGuard {
  const listResultsFiles = (docsDir: string): string[] => {
    if (!existsSync(docsDir)) return [];
    return readdirSync(docsDir)
      .filter(f => f.startsWith(resultsPrefix) && f.endsWith(RESULTS_SUFFIX))
      .sort();
  };
  return {
    listResultsFiles,
    resultsFilePath: (docsDir, date) => join(docsDir, `${resultsPrefix}${toDateOnly(date)}${RESULTS_SUFFIX}`),
    refusalReason: (docsDir) => {
      const marker = join(docsDir, markerFilename);
      if (existsSync(marker)) return `marker exists: ${marker} — a run already started; this ${noun} runs once`;
      const results = listResultsFiles(docsDir);
      if (results.length > 0) return `results already exist: ${results.join(', ')} — this ${noun} runs once`;
      return undefined;
    },
    writeMarker: (docsDir, payload) => {
      mkdirSync(docsDir, { recursive: true });
      const fd = openSync(join(docsDir, markerFilename), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, JSON.stringify(payload, null, JSON_INDENT) + '\n');
      closeSync(fd);
    },
    refuse: (message) => {
      console.error(`${logPrefix} refused: ${message}`);
      process.exitCode = EXIT_REFUSED;
    },
  };
}

/** Right-aligned table cell. */
export function padCell(value: string | number, width: number): string {
  return String(value).padStart(width);
}

export function formatRate(rate: number | null): string {
  return rate === null ? '-' : `${(rate * PERCENT).toFixed(RATE_DECIMALS)}%`;
}

export function formatDiff(diff: number | null | undefined): string {
  return diff === null || diff === undefined ? '-' : diff.toFixed(DIFF_DECIMALS);
}
