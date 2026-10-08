#!/usr/bin/env tsx
/**
 * Judge agreement check: per-criterion vs consolidated, on real turns, once.
 *
 * Loads N turns through the pipeline's own transcript discovery, scores each
 * turn both ways against the REAL Anthropic API, and writes
 * docs/judge-agreement-<YYYY-MM-DD>.json with the per-criterion exact-match
 * rate and mean absolute difference on the 1–5 scale, plus each
 * configuration's token totals (from `response.usage`) and USD at
 * MODEL_PRICING[HAIKU_MODEL]. Prints a one-screen table.
 *
 * Safety rules, all mandatory:
 * - `--yes` is required.
 * - Before the first API call a marker (docs/.judge-agreement.started) is
 *   written; the script refuses to run while the marker or any results file
 *   exists. There is no --force flag.
 * - The key comes from LLM_JUDGE_ANTHROPIC_KEY, falling back to ANTHROPIC_API_KEY.
 * - Concurrency is capped at AGREEMENT_CONCURRENCY (4).
 *
 * Usage:
 *   doppler run -p integrity-studio -c prd -- npx tsx scripts/judge-agreement.ts --limit 30 --yes
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { LLMProvider } from '../../src/lib/judge/llm-as-judge.js';
import { MODEL_PRICING, TOKENS_PER_CHAR, type ModelPricingEntry } from '../../src/lib/core/constants-models.js';
import { G_EVAL_MIN_SCORE, G_EVAL_SCORE_RANGE, MAX_STATEMENTS } from '../../src/lib/judge/llm-judge-constants.js';
import {
  _discoverTranscripts,
  extractTurns,
  fitContextForJudge,
  type Turn,
  type TranscriptInfo,
} from './judge-turns.js';
import { createAnthropicProvider, createLLMJudge, evaluateTurn, processBatch } from './judge-evaluations.js';
import { resetFailureTracking } from './judge-failures.js';
import type { EvalRecord } from './eval-record.js';
import {
  HAIKU_MODEL,
  FAITHFULNESS_EVAL_NAME,
} from './judge-criteria.js';
import {
  createConsolidatedProvider,
  evaluateTurnConsolidated,
  selectCriteria,
  type EvaluationStepsCache,
} from './judge-consolidated.js';
import { resolveJudgeApiKey, JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV } from './judge-credentials.js';
import { parseCli, positiveIntArg } from './cli-args.js';
import {
  EXIT_REFUSED,
  JSON_INDENT,
  NO_BATCH_DELAY_MS,
  TABLE_NAME_WIDTH,
  USD_DECIMALS,
  YES_FLAG,
  YES_REQUIRED_ERROR,
  createRunGuard,
  formatDiff,
  formatRate,
  oneShotArgError,
  padCell,
} from './one-shot-eval.js';
import { createUsageTotals as createJudgeUsageTotals, tokenUsageCostUsd, type JudgeTokenUsage } from './judge-usage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 40;
const AGREEMENT_CONCURRENCY = 4;
/** Spread the sample across sessions instead of taking one transcript's first N turns. */
const TURNS_PER_TRANSCRIPT_CAP = 3;
/** A turn whose content estimates above this is skipped: the per-criterion path re-sends it ~20 times. */
const MAX_SAMPLE_TURN_TOKENS = 12_000;
/** Refuse — before the marker and before any API call — when the up-front estimate exceeds this. */
export const MAX_ESTIMATED_SPEND_USD = 8;
export { YES_FLAG };
export const LIMIT_FLAG = '--limit';
export const MARKER_FILENAME = '.judge-agreement.started';
export const RESULTS_PREFIX = 'judge-agreement-';
export const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
/** Estimate only: QAG answers one question per statement, each carrying the context. */
const QAG_STATEMENTS_ESTIMATE = MAX_STATEMENTS / 2;
/** Estimate only: same figure the pipeline's --dry-run uses per call. */
const OUTPUT_TOKENS_PER_CALL_ESTIMATE = 200;
/** Steps prompt + eval prompt per G-Eval criterion. */
const GEVAL_CALLS_PER_CRITERION = 2;
const TABLE_CELL_WIDTH = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  yes: boolean;
  limit: number;
  /** Set when the invocation must be refused; the message says why. */
  error?: string;
}

export interface UsageTotals extends JudgeTokenUsage {
  calls: number;
}

export interface UsageReport extends UsageTotals {
  usd: number;
}

/** Normalized (0–1) scores by evaluation name, one entry per configuration. */
export interface TurnScores {
  perCriterion: Record<string, number>;
  consolidated: Record<string, number>;
}

export interface CriterionAgreement {
  paired: number;
  exactMatches: number;
  exactMatchRate: number | null;
  meanAbsDiff: number | null;
  perCriterionOnly: number;
  consolidatedOnly: number;
}

export interface AgreementSummary {
  byCriterion: Record<string, CriterionAgreement>;
  overall: CriterionAgreement;
}

export interface TurnOutcome extends TurnScores {
  sessionId: string;
  timestamp: string;
  hasTools: boolean;
  expected: string[];
  error?: string;
}

export interface SampleSummary {
  turns: Turn[];
  transcriptsScanned: number;
  skippedOversize: number;
}

export interface SpendEstimate {
  perCriterionInputTokens: number;
  perCriterionCalls: number;
  consolidatedInputTokens: number;
  consolidatedCalls: number;
  perCriterionUsd: number;
  consolidatedUsd: number;
  totalUsd: number;
}

// ---------------------------------------------------------------------------
// Arguments and key
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { yes: false, limit: DEFAULT_LIMIT };
  try {
    const cli = parseCli(argv, { values: [LIMIT_FLAG], switches: [YES_FLAG] }, { allowUnknown: false });
    parsed.yes = cli.has(YES_FLAG);
    parsed.limit = positiveIntArg(LIMIT_FLAG, cli.value(LIMIT_FLAG)) ?? DEFAULT_LIMIT;
  } catch (err) {
    return { ...parsed, error: oneShotArgError(err) };
  }
  if (parsed.limit > MAX_LIMIT) return { ...parsed, error: `${LIMIT_FLAG} ${parsed.limit} exceeds the hard maximum of ${MAX_LIMIT}` };
  if (!parsed.yes) return { ...parsed, error: YES_REQUIRED_ERROR };
  return parsed;
}

// ---------------------------------------------------------------------------
// Marker and results files
// ---------------------------------------------------------------------------

const runGuard = createRunGuard({ markerFilename: MARKER_FILENAME, resultsPrefix: RESULTS_PREFIX, logPrefix: '[agreement]', noun: 'check' });
export const { listResultsFiles, resultsFilePath, refusalReason } = runGuard;
const { writeMarker, refuse } = runGuard;


// ---------------------------------------------------------------------------
// Sampling and estimate
// ---------------------------------------------------------------------------

/** Tokens the judge sees for one turn, by the pipeline's own chars-per-token heuristic. */
export function estimateTurnTokens(turn: Turn): number {
  const contextChars = fitContextForJudge(turn.toolResults).reduce((sum, item) => sum + item.length, 0);
  return Math.ceil((turn.userText.length + turn.assistantText.length + contextChars) * TOKENS_PER_CHAR);
}

async function sampleTurns(transcripts: readonly TranscriptInfo[], limit: number): Promise<SampleSummary> {
  const turns: Turn[] = [];
  let transcriptsScanned = 0;
  let skippedOversize = 0;
  for (const info of transcripts) {
    if (turns.length >= limit) break;
    transcriptsScanned++;
    let taken = 0;
    for (const turn of await extractTurns(info)) {
      if (taken >= TURNS_PER_TRANSCRIPT_CAP || turns.length >= limit) break;
      if (estimateTurnTokens(turn) > MAX_SAMPLE_TURN_TOKENS) {
        skippedOversize++;
        continue;
      }
      turns.push(turn);
      taken++;
    }
  }
  return { turns, transcriptsScanned, skippedOversize };
}

/**
 * Rough, documented up-front estimate. Per criterion: every G-Eval criterion
 * re-sends the content once (its steps call is content-free), and QAG
 * faithfulness sends the output once plus the context once per statement.
 * Consolidated: the content once per turn plus one steps call per criterion.
 */
export function estimateSpend(turns: readonly Turn[], pricing: ModelPricingEntry): SpendEstimate {
  let perCriterionInputTokens = 0;
  let perCriterionCalls = 0;
  let consolidatedInputTokens = 0;
  let consolidatedCalls = 0;
  const stepsGenerated = new Set<string>();

  for (const turn of turns) {
    const contentTokens = estimateTurnTokens(turn);
    const { criteria, recordNames } = selectCriteria(turn, new Set());
    const gevalCriteria = recordNames.filter(name => name !== FAITHFULNESS_EVAL_NAME).length;
    const hasQag = recordNames.includes(FAITHFULNESS_EVAL_NAME);

    perCriterionInputTokens += gevalCriteria * contentTokens;
    perCriterionCalls += gevalCriteria * GEVAL_CALLS_PER_CRITERION;
    if (hasQag) {
      perCriterionInputTokens += (1 + QAG_STATEMENTS_ESTIMATE) * contentTokens;
      perCriterionCalls += 1 + QAG_STATEMENTS_ESTIMATE * GEVAL_CALLS_PER_CRITERION;
    }

    consolidatedInputTokens += contentTokens;
    consolidatedCalls += 1;
    for (const config of criteria) {
      if (stepsGenerated.has(config.name)) continue;
      stepsGenerated.add(config.name);
      consolidatedCalls += 1;
    }
  }

  const perCriterionUsd = tokenUsageCostUsd({
    inputTokens: perCriterionInputTokens,
    outputTokens: perCriterionCalls * OUTPUT_TOKENS_PER_CALL_ESTIMATE,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }, pricing);
  const consolidatedUsd = tokenUsageCostUsd({
    inputTokens: consolidatedInputTokens,
    outputTokens: consolidatedCalls * OUTPUT_TOKENS_PER_CALL_ESTIMATE,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }, pricing);
  return {
    perCriterionInputTokens,
    perCriterionCalls,
    consolidatedInputTokens,
    consolidatedCalls,
    perCriterionUsd,
    consolidatedUsd,
    totalUsd: perCriterionUsd + consolidatedUsd,
  };
}

// ---------------------------------------------------------------------------
// Usage totals
// ---------------------------------------------------------------------------

export function createUsageTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function addUsage(totals: UsageTotals, usage: JudgeTokenUsage): void {
  totals.calls += 1;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens;
}

// ---------------------------------------------------------------------------
// Agreement math
// ---------------------------------------------------------------------------

/** Back from the record's 0–1 value to the judge's 1–5 scale. */
export function toFivePointScale(normalized: number): number {
  return G_EVAL_MIN_SCORE + normalized * G_EVAL_SCORE_RANGE;
}

function emptyAgreement(): CriterionAgreement {
  return { paired: 0, exactMatches: 0, exactMatchRate: null, meanAbsDiff: null, perCriterionOnly: 0, consolidatedOnly: 0 };
}

/**
 * Per criterion: exact-match rate and mean absolute difference on the 1–5
 * scale over turns where both configurations produced a score. Exact match
 * compares rounded values because QAG faithfulness is a fraction of supported
 * statements, not a grid point.
 */
export function computeAgreement(turns: readonly TurnScores[]): AgreementSummary {
  const sums = new Map<string, CriterionAgreement & { absDiffSum: number }>();
  const overall = { ...emptyAgreement(), absDiffSum: 0 };

  const bucket = (name: string): CriterionAgreement & { absDiffSum: number } => {
    const existing = sums.get(name);
    if (existing) return existing;
    const created = { ...emptyAgreement(), absDiffSum: 0 };
    sums.set(name, created);
    return created;
  };

  for (const turn of turns) {
    const names = new Set([...Object.keys(turn.perCriterion), ...Object.keys(turn.consolidated)]);
    for (const name of names) {
      const entry = bucket(name);
      const a = turn.perCriterion[name];
      const b = turn.consolidated[name];
      if (a === undefined) {
        entry.consolidatedOnly++;
        overall.consolidatedOnly++;
        continue;
      }
      if (b === undefined) {
        entry.perCriterionOnly++;
        overall.perCriterionOnly++;
        continue;
      }
      const a5 = toFivePointScale(a);
      const b5 = toFivePointScale(b);
      const match = Math.round(a5) === Math.round(b5) ? 1 : 0;
      const diff = Math.abs(a5 - b5);
      for (const target of [entry, overall]) {
        target.paired++;
        target.exactMatches += match;
        target.absDiffSum += diff;
      }
    }
  }

  const finish = ({ absDiffSum, ...rest }: CriterionAgreement & { absDiffSum: number }): CriterionAgreement => ({
    ...rest,
    exactMatchRate: rest.paired > 0 ? rest.exactMatches / rest.paired : null,
    meanAbsDiff: rest.paired > 0 ? absDiffSum / rest.paired : null,
  });

  const byCriterion: Record<string, CriterionAgreement> = {};
  for (const [name, entry] of [...sums.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    byCriterion[name] = finish(entry);
  }
  return { byCriterion, overall: finish(overall) };
}

/** Records missing per evaluation name — what each path failed to produce. */
export function countMissing(outcomes: readonly TurnOutcome[], side: keyof TurnScores): Record<string, number> {
  const missing: Record<string, number> = {};
  for (const outcome of outcomes) {
    for (const name of outcome.expected) {
      if (outcome[side][name] !== undefined) continue;
      missing[name] = (missing[name] ?? 0) + 1;
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** The pipeline's own provider (structured score output included), with the usage hook. */
export function createPerCriterionProvider(apiKey: string, onUsage: (usage: JudgeTokenUsage) => void): Promise<LLMProvider> {
  return createAnthropicProvider(apiKey, createJudgeUsageTotals(), onUsage);
}

export function scoresByName(records: readonly EvalRecord[]): Record<string, number> {
  return Object.fromEntries(records.map(r => [r.evaluationName, r.scoreValue]));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function cell(value: string | number): string {
  return padCell(value, TABLE_CELL_WIDTH);
}

function printTable(summary: AgreementSummary, configurations: Record<string, UsageReport>, turnsEvaluated: number): void {
  console.log(`\n[agreement] ${turnsEvaluated} turns, model ${HAIKU_MODEL}`);
  console.log(
    `${'criterion'.padEnd(TABLE_NAME_WIDTH)}${cell('paired')}${cell('exact')}${cell('mean|d|')}${cell('pc-only')}${cell('cons-only')}`,
  );
  const rows = [...Object.entries(summary.byCriterion), ['overall', summary.overall] as const];
  for (const [name, entry] of rows) {
    console.log(
      `${name.padEnd(TABLE_NAME_WIDTH)}${cell(entry.paired)}${cell(formatRate(entry.exactMatchRate))}`
      + `${cell(formatDiff(entry.meanAbsDiff))}${cell(entry.perCriterionOnly)}${cell(entry.consolidatedOnly)}`,
    );
  }
  console.log(
    `\n${'configuration'.padEnd(TABLE_NAME_WIDTH)}${cell('calls')}${cell('input')}${cell('output')}${cell('usd')}`,
  );
  for (const [name, report] of Object.entries(configurations)) {
    console.log(
      `${name.padEnd(TABLE_NAME_WIDTH)}${cell(report.calls)}${cell(report.inputTokens)}${cell(report.outputTokens)}`
      + `${cell(report.usd.toFixed(USD_DECIMALS))}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    refuse(args.error);
    return;
  }

  const credential = resolveJudgeApiKey();
  if (!credential) {
    refuse(`no API key: set ${JUDGE_API_KEY_ENV} (or ${DEFAULT_API_KEY_ENV})`);
    return;
  }
  console.log(`[agreement] API key from ${credential.source}`);

  const reason = refusalReason(DOCS_DIR);
  if (reason) {
    refuse(reason);
    return;
  }

  const pricing = MODEL_PRICING[HAIKU_MODEL];
  if (!pricing) {
    refuse(`no pricing data for model ${HAIKU_MODEL}`);
    return;
  }

  console.log('[agreement] discovering transcripts through the pipeline…');
  const transcripts = await _discoverTranscripts();
  const sample = await sampleTurns(transcripts, args.limit);
  const turnsWithTools = sample.turns.filter(t => t.toolResults.length > 0).length;
  console.log(
    `[agreement] ${transcripts.length} transcripts discovered, ${sample.transcriptsScanned} scanned, `
    + `${sample.turns.length} turns sampled (${turnsWithTools} with tool results, ${sample.skippedOversize} skipped as oversize)`,
  );
  if (sample.turns.length === 0) {
    refuse('no turns to evaluate');
    return;
  }

  const estimate = estimateSpend(sample.turns, pricing);
  console.log(
    `[agreement] estimate: per-criterion ~${estimate.perCriterionInputTokens.toLocaleString()} input tokens / ~${estimate.perCriterionCalls} calls `
    + `($${estimate.perCriterionUsd.toFixed(USD_DECIMALS)}); consolidated ~${estimate.consolidatedInputTokens.toLocaleString()} / ~${estimate.consolidatedCalls} `
    + `($${estimate.consolidatedUsd.toFixed(USD_DECIMALS)}); total ~$${estimate.totalUsd.toFixed(USD_DECIMALS)}`,
  );
  if (estimate.totalUsd > MAX_ESTIMATED_SPEND_USD) {
    refuse(`estimated spend $${estimate.totalUsd.toFixed(USD_DECIMALS)} exceeds the $${MAX_ESTIMATED_SPEND_USD} cap; lower ${LIMIT_FLAG}`);
    return;
  }

  // Re-check right before committing: discovery took a while.
  const lateReason = refusalReason(DOCS_DIR);
  if (lateReason) {
    refuse(lateReason);
    return;
  }
  const startedAt = new Date();
  writeMarker(DOCS_DIR, { startedAt: startedAt.toISOString(), pid: process.pid, limit: args.limit, turns: sample.turns.length });
  console.log(`[agreement] marker written: ${join(DOCS_DIR, MARKER_FILENAME)} — API calls start now`);

  const perCriterionTotals = createUsageTotals();
  const consolidatedTotals = createUsageTotals();
  const llm = await createPerCriterionProvider(credential.apiKey, usage => addUsage(perCriterionTotals, usage));
  const judge = createLLMJudge(llm);
  const provider = await createConsolidatedProvider({
    apiKey: credential.apiKey,
    onUsage: usage => addUsage(consolidatedTotals, usage),
  });
  const stepsCache: EvaluationStepsCache = new Map();
  resetFailureTracking();

  let completed = 0;
  const outcomes = await processBatch(sample.turns, AGREEMENT_CONCURRENCY, NO_BATCH_DELAY_MS, async (turn): Promise<TurnOutcome> => {
    const outcome: TurnOutcome = {
      sessionId: turn.sessionId,
      timestamp: turn.timestamp,
      hasTools: turn.toolResults.length > 0,
      expected: selectCriteria(turn, new Set()).recordNames,
      perCriterion: {},
      consolidated: {},
    };
    try {
      outcome.perCriterion = scoresByName(await evaluateTurn(judge, turn, new Set()));
      outcome.consolidated = scoresByName(await evaluateTurnConsolidated(provider, turn, new Set(), stepsCache));
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    completed++;
    console.log(`[agreement] ${completed}/${sample.turns.length} turns done`);
    return outcome;
  });

  const summary = computeAgreement(outcomes);
  const configurations: Record<string, UsageReport> = {
    perCriterion: { ...perCriterionTotals, usd: tokenUsageCostUsd(perCriterionTotals, pricing) },
    consolidated: { ...consolidatedTotals, usd: tokenUsageCostUsd(consolidatedTotals, pricing) },
  };
  const results = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    model: HAIKU_MODEL,
    pricingUsdPerMillion: { input: pricing.input, output: pricing.output },
    limitRequested: args.limit,
    turnsEvaluated: outcomes.length,
    turnsWithTools,
    sampling: {
      turnsPerTranscriptCap: TURNS_PER_TRANSCRIPT_CAP,
      maxTurnTokens: MAX_SAMPLE_TURN_TOKENS,
      transcriptsDiscovered: transcripts.length,
      transcriptsScanned: sample.transcriptsScanned,
      skippedOversize: sample.skippedOversize,
    },
    estimate,
    agreement: summary,
    configurations,
    savings: {
      inputTokenRatio: configurations.consolidated!.inputTokens > 0
        ? configurations.perCriterion!.inputTokens / configurations.consolidated!.inputTokens
        : null,
      usdRatio: configurations.consolidated!.usd > 0
        ? configurations.perCriterion!.usd / configurations.consolidated!.usd
        : null,
    },
    failures: {
      perCriterion: countMissing(outcomes, 'perCriterion'),
      consolidated: countMissing(outcomes, 'consolidated'),
      turnErrors: outcomes.filter(o => o.error).map(o => ({ sessionId: o.sessionId, timestamp: o.timestamp, error: o.error })),
    },
    turns: outcomes.map(({ error: _error, ...rest }) => rest),
  };

  const outPath = resultsFilePath(DOCS_DIR, startedAt);
  writeFileSync(outPath, JSON.stringify(results, null, JSON_INDENT) + '\n');
  printTable(summary, configurations, outcomes.length);
  console.log(`\n[agreement] results written: ${outPath}`);
}

// Only run when executed directly (not imported as a module for testing)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[agreement] fatal:', err);
    process.exitCode = EXIT_REFUSED;
  });
}
