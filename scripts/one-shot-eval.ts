/**
 * Scaffolding shared by the one-shot paid evals (judge-agreement,
 * judge-quality-eval, judge-hallucination-eval): each spends real API money,
 * runs once, and refuses a second start.
 */

import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LLMProvider } from '../../src/lib/judge/llm-as-judge.js';
import { G_EVAL_MIN_SCORE, G_EVAL_SCORE_RANGE } from '../../src/lib/judge/llm-judge-constants.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { CliArgError } from './cli-args.js';
import { resolveJudgeApiKey, JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV, type JudgeApiKey } from './judge-credentials.js';
import type { EvalRecord } from './eval-record.js';
import { createAnthropicProvider } from './judge-evaluations.js';
import { createUsageTotals, type JudgeTokenUsage } from './judge-usage.js';

export const YES_FLAG = '--yes';
export const RESULTS_SUFFIX = '.json';
export const JSON_INDENT = 2;
/** Every call goes out at once; the evals are small and bounded by their spend caps. */
export const NO_BATCH_DELAY_MS = 0;
export const USD_DECIMALS = 4;
export const TABLE_NAME_WIDTH = 18;
export const EXIT_REFUSED = 1;
/** Where every one-shot eval writes its marker and results. */
export const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
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

/** A run's own marker fields; begin() writes `startedAt` and `pid`, so a payload cannot carry them. */
export type MarkerPayload = Record<string, unknown> & { startedAt?: never; pid?: never };

export interface RunGuard {
  listResultsFiles: (docsDir: string) => string[];
  resultsFilePath: (docsDir: string, date: Date) => string;
  /** Why the run must not start, or undefined when it may. */
  refusalReason: (docsDir: string) => string | undefined;
  /** Log the refusal and set a failing exit code. */
  refuse: (message: string) => void;
  /** The judge key (logging which variable supplied it), or undefined after refusing. */
  resolveApiKey: () => JudgeApiKey | undefined;
  /**
   * Re-check the refusal — setup took a while — then write the marker
   * (O_CREAT | O_EXCL: two concurrent starts cannot both win) with `payload`
   * after the start time and pid. Returns the start time, or undefined after refusing.
   */
  begin: (docsDir: string, payload: MarkerPayload) => Date | undefined;
}

export function createRunGuard({ markerFilename, resultsPrefix, logPrefix, noun }: RunGuardConfig): RunGuard {
  const listResultsFiles = (docsDir: string): string[] => {
    if (!existsSync(docsDir)) return [];
    return readdirSync(docsDir)
      .filter(f => f.startsWith(resultsPrefix) && f.endsWith(RESULTS_SUFFIX))
      .sort();
  };
  const refusalReason = (docsDir: string): string | undefined => {
    const marker = join(docsDir, markerFilename);
    if (existsSync(marker)) return `marker exists: ${marker} — a run already started; this ${noun} runs once`;
    const results = listResultsFiles(docsDir);
    if (results.length > 0) return `results already exist: ${results.join(', ')} — this ${noun} runs once`;
    return undefined;
  };
  const refuse = (message: string): void => {
    console.error(`${logPrefix} refused: ${message}`);
    process.exitCode = EXIT_REFUSED;
  };
  return {
    listResultsFiles,
    resultsFilePath: (docsDir, date) => join(docsDir, `${resultsPrefix}${toDateOnly(date)}${RESULTS_SUFFIX}`),
    refusalReason,
    refuse,
    resolveApiKey: () => {
      const credential = resolveJudgeApiKey();
      if (!credential) {
        refuse(`no API key: set ${JUDGE_API_KEY_ENV} (or ${DEFAULT_API_KEY_ENV})`);
        return undefined;
      }
      console.log(`${logPrefix} API key from ${credential.source}`);
      return credential;
    },
    begin: (docsDir, payload) => {
      const reason = refusalReason(docsDir);
      if (reason) {
        refuse(reason);
        return undefined;
      }
      const startedAt = new Date();
      const marker = join(docsDir, markerFilename);
      mkdirSync(docsDir, { recursive: true });
      const fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, JSON.stringify({ startedAt: startedAt.toISOString(), pid: process.pid, ...payload }, null, JSON_INDENT) + '\n');
      closeSync(fd);
      console.log(`${logPrefix} marker written: ${marker} — API calls start now`);
      return startedAt;
    },
  };
}

/** A dollar amount at USD_DECIMALS places, e.g. `$1.8123`. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(USD_DECIMALS)}`;
}

/** The refusal for an estimate over `capUsd` (with an optional remedy), or undefined when it fits. */
export function spendCapReason(estimateUsd: number, capUsd: number, remedy?: string): string | undefined {
  if (estimateUsd <= capUsd) return undefined;
  const reason = `estimated spend ${formatUsd(estimateUsd)} exceeds the $${capUsd} cap`;
  return remedy ? `${reason}; ${remedy}` : reason;
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

/** Back from the record's 0–1 value to the judge's 1–5 scale. */
export function toFivePointScale(normalized: number): number {
  return G_EVAL_MIN_SCORE + normalized * G_EVAL_SCORE_RANGE;
}

export function scoresByName(records: readonly EvalRecord[]): Record<string, number> {
  return Object.fromEntries(records.map(r => [r.evaluationName, r.scoreValue]));
}

/** The pipeline's own provider (structured score output included), with the usage hook. */
export function createPerCriterionProvider(apiKey: string, onUsage: (usage: JudgeTokenUsage) => void): Promise<LLMProvider> {
  return createAnthropicProvider(apiKey, createUsageTotals(), onUsage);
}
