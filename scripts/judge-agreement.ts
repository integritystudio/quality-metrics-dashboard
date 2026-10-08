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
import { pathToFileURL } from 'url';
import type { ModelPricingEntry } from '../../src/lib/core/constants-models.js';
import { MAX_STATEMENTS } from '../../src/lib/judge/llm-judge-constants.js';
import {
  _discoverTranscripts,
  extractTurns,
  type Turn,
  type TranscriptInfo,
} from './judge-turns.js';
import { createLLMJudge, evaluateTurn, processBatch } from './judge-evaluations.js';
import { resetFailureTracking } from './judge-failures.js';
import {
  HAIKU_MODEL,
  FAITHFULNESS_EVAL_NAME,
} from './judge-criteria.js';
import {
  createConsolidatedProvider,
  evaluateTurnConsolidated,
  selectCriteria,
  toFivePointScale,
  type EvaluationStepsCache,
} from './judge-consolidated.js';
import { parseCli, positiveIntArg } from './cli-args.js';
import {
  DOCS_DIR,
  EXIT_REFUSED,
  JSON_INDENT,
  NO_BATCH_DELAY_MS,
  USD_DECIMALS,
  YES_FLAG,
  YES_REQUIRED_ERROR,
  createPerCriterionProvider,
  createRunGuard,
  formatDiff,
  formatUsd,
  formatRate,
  oneShotArgError,
  scoresByName,
  spendCapReason,
  tableRow,
} from './one-shot-eval.js';
import {
  addCallUsage,
  createCallUsageTotals,
  estimateTurnTokens,
  judgePricing,
  listCostUsd,
  tokenUsageCostUsd,
  type CallUsageReport,
} from './judge-usage.js';

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
export const LIMIT_FLAG = '--limit';
export const MARKER_FILENAME = '.judge-agreement.started';
export const RESULTS_PREFIX = 'judge-agreement-';
/** Estimate only: QAG answers one question per statement, each carrying the context. */
const QAG_STATEMENTS_ESTIMATE = MAX_STATEMENTS / 2;
/** Estimate only: same figure the pipeline's --dry-run uses per call. */
const OUTPUT_TOKENS_PER_CALL_ESTIMATE = 200;
/** Steps prompt + eval prompt per G-Eval criterion. */
const GEVAL_CALLS_PER_CRITERION = 2;
const TABLE_CELL_WIDTH = 10;
const AGREEMENT_HEADER = ['criterion', 'paired', 'exact', 'mean|d|', 'pc-only', 'cons-only'] as const;
const USAGE_HEADER = ['configuration', 'calls', 'input', 'output', 'usd'] as const;
const OVERALL_ROW = 'overall';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  yes: boolean;
  limit: number;
  /** Set when the invocation must be refused; the message says why. */
  error?: string;
}

/** Normalized (0–1) scores by evaluation name, one entry per configuration. */
export interface TurnScores {
  perCriterion: Record<string, number>;
  consolidated: Record<string, number>;
}

type Configuration = keyof TurnScores;

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
const { refuse, resolveApiKey, begin } = runGuard;


// ---------------------------------------------------------------------------
// Sampling and estimate
// ---------------------------------------------------------------------------

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

  const perCriterionUsd = listCostUsd(perCriterionInputTokens, perCriterionCalls * OUTPUT_TOKENS_PER_CALL_ESTIMATE, pricing);
  const consolidatedUsd = listCostUsd(consolidatedInputTokens, consolidatedCalls * OUTPUT_TOKENS_PER_CALL_ESTIMATE, pricing);
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
// Agreement math
// ---------------------------------------------------------------------------

/** A criterion's running sums; `absDiffSum` becomes `meanAbsDiff` once every turn is in. */
type AgreementAccumulator = CriterionAgreement & { absDiffSum: number };

function newAccumulator(): AgreementAccumulator {
  return { paired: 0, exactMatches: 0, exactMatchRate: null, meanAbsDiff: null, perCriterionOnly: 0, consolidatedOnly: 0, absDiffSum: 0 };
}

function finishAgreement({ absDiffSum, ...rest }: AgreementAccumulator): CriterionAgreement {
  return {
    ...rest,
    exactMatchRate: rest.paired > 0 ? rest.exactMatches / rest.paired : null,
    meanAbsDiff: rest.paired > 0 ? absDiffSum / rest.paired : null,
  };
}

/**
 * Per criterion: exact-match rate and mean absolute difference on the 1–5
 * scale over turns where both configurations produced a score. Exact match
 * compares rounded values because QAG faithfulness is a fraction of supported
 * statements, not a grid point.
 */
export function computeAgreement(turns: readonly TurnScores[]): AgreementSummary {
  const sums = new Map<string, AgreementAccumulator>();
  const overall = newAccumulator();

  for (const turn of turns) {
    const names = new Set([...Object.keys(turn.perCriterion), ...Object.keys(turn.consolidated)]);
    for (const name of names) {
      const entry = sums.get(name) ?? newAccumulator();
      sums.set(name, entry);
      const targets = [entry, overall];
      const a = turn.perCriterion[name];
      const b = turn.consolidated[name];
      if (a === undefined || b === undefined) {
        const side = a === undefined ? 'consolidatedOnly' : 'perCriterionOnly';
        for (const target of targets) target[side]++;
        continue;
      }
      const a5 = toFivePointScale(a);
      const b5 = toFivePointScale(b);
      for (const target of targets) {
        target.paired++;
        target.exactMatches += Math.round(a5) === Math.round(b5) ? 1 : 0;
        target.absDiffSum += Math.abs(a5 - b5);
      }
    }
  }

  const byCriterion = Object.fromEntries(
    [...sums.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([name, entry]) => [name, finishAgreement(entry)]),
  );
  return { byCriterion, overall: finishAgreement(overall) };
}

/** Records missing per evaluation name — what each path failed to produce. */
export function countMissing(outcomes: readonly TurnOutcome[], side: Configuration): Record<string, number> {
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
// Output
// ---------------------------------------------------------------------------

/** `numerator / denominator`, or null when the denominator is 0. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function printTable(summary: AgreementSummary, configurations: Record<Configuration, CallUsageReport>, turnsEvaluated: number): void {
  console.log(`\n[agreement] ${turnsEvaluated} turns, model ${HAIKU_MODEL}`);
  console.log(tableRow(TABLE_CELL_WIDTH, ...AGREEMENT_HEADER));
  for (const [name, entry] of [...Object.entries(summary.byCriterion), [OVERALL_ROW, summary.overall] as const]) {
    console.log(tableRow(
      TABLE_CELL_WIDTH,
      name,
      entry.paired,
      formatRate(entry.exactMatchRate),
      formatDiff(entry.meanAbsDiff),
      entry.perCriterionOnly,
      entry.consolidatedOnly,
    ));
  }
  console.log(`\n${tableRow(TABLE_CELL_WIDTH, ...USAGE_HEADER)}`);
  for (const [name, report] of Object.entries(configurations)) {
    console.log(tableRow(TABLE_CELL_WIDTH, name, report.calls, report.inputTokens, report.outputTokens, report.usd.toFixed(USD_DECIMALS)));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) return refuse(args.error);

  const credential = resolveApiKey();
  if (!credential) return;

  const reason = refusalReason(DOCS_DIR);
  if (reason) return refuse(reason);

  const pricing = judgePricing();

  console.log('[agreement] discovering transcripts through the pipeline…');
  const transcripts = await _discoverTranscripts();
  const sample = await sampleTurns(transcripts, args.limit);
  const turnsWithTools = sample.turns.filter(t => t.toolResults.length > 0).length;
  console.log(
    `[agreement] ${transcripts.length} transcripts discovered, ${sample.transcriptsScanned} scanned, `
    + `${sample.turns.length} turns sampled (${turnsWithTools} with tool results, ${sample.skippedOversize} skipped as oversize)`,
  );
  if (sample.turns.length === 0) return refuse('no turns to evaluate');

  const estimate = estimateSpend(sample.turns, pricing);
  console.log(
    `[agreement] estimate: per-criterion ~${estimate.perCriterionInputTokens.toLocaleString()} input tokens / ~${estimate.perCriterionCalls} calls `
    + `(${formatUsd(estimate.perCriterionUsd)}); consolidated ~${estimate.consolidatedInputTokens.toLocaleString()} / ~${estimate.consolidatedCalls} `
    + `(${formatUsd(estimate.consolidatedUsd)}); total ~${formatUsd(estimate.totalUsd)}`,
  );
  const overCap = spendCapReason(estimate.totalUsd, MAX_ESTIMATED_SPEND_USD, `lower ${LIMIT_FLAG}`);
  if (overCap) return refuse(overCap);

  const startedAt = begin(DOCS_DIR, { limit: args.limit, turns: sample.turns.length });
  if (!startedAt) return;

  const perCriterionTotals = createCallUsageTotals();
  const consolidatedTotals = createCallUsageTotals();
  const llm = await createPerCriterionProvider(credential.apiKey, usage => addCallUsage(perCriterionTotals, usage));
  const judge = createLLMJudge(llm);
  const provider = await createConsolidatedProvider({
    apiKey: credential.apiKey,
    onUsage: usage => addCallUsage(consolidatedTotals, usage),
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
  const configurations: Record<Configuration, CallUsageReport> = {
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
      inputTokenRatio: ratio(configurations.perCriterion.inputTokens, configurations.consolidated.inputTokens),
      usdRatio: ratio(configurations.perCriterion.usd, configurations.consolidated.usd),
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
