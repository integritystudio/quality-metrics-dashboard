#!/usr/bin/env tsx
/**
 * Hallucination re-reference eval (JUDGE-HALLUCINATION-INVERTED-ON-DEFAULT).
 *
 * judge-quality-eval.ts (JCP4) cannot judge whether the consolidated default
 * should stop inverting faithfulness into `hallucination`, for two reasons its
 * backlog entry records: its Haiku scores come from a judge-agreement file
 * written before the per-criterion path stopped inverting, and its reference
 * derives hallucination as 1 - faithfulness too. This script fixes both:
 *
 * - Haiku is scored LIVE, three ways, on the same turns: the per-criterion path
 *   (QAG faithfulness + fabrication), the consolidated default (inverted), and
 *   the consolidated candidate with `directHallucination` (its own criterion).
 * - The reference judges hallucination DIRECTLY: one REFERENCE_MODEL call per
 *   tool turn on HALLUCINATION_CRITERIA. Every other reference score is reused
 *   from the JCP4 results file: same model, same turns, same method, so paying
 *   for it again would buy nothing.
 * - Turns come from the frozen file JCP4 wrote (local/, gitignored).
 *
 * Acceptance (c) is reported as `complement`: per configuration, how many
 * turns have faithfulness + hallucination = 1. The candidate should not.
 *
 * Safety rules, as in judge-quality-eval.ts: `--yes` is required; a marker is
 * written before the first call and the script refuses while it or a results
 * file exists; refuses when the estimate exceeds MAX_ESTIMATED_SPEND_USD and
 * stops issuing calls once measured spend reaches MAX_MEASURED_SPEND_USD.
 *
 * Usage:
 *   doppler run -p integrity-studio -c prd -- npx tsx scripts/judge-hallucination-eval.ts --yes
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { HALLUCINATION_CRITERIA } from '../../src/lib/judge/llm-judge-config.js';
import type { ModelPricingEntry } from '../../src/lib/core/constants-models.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { createLLMJudge, evaluateTurn, processBatch } from './judge-evaluations.js';
import { fitContextForJudge, type Turn } from './judge-turns.js';
import { resetFailureTracking } from './judge-failures.js';
import { FAITHFULNESS_EVAL_NAME, HAIKU_MODEL } from './judge-criteria.js';
import {
  buildConsolidatedPrompt,
  buildConsolidatedSchema,
  cachedEvaluationSteps,
  createConsolidatedProvider,
  evaluateTurnConsolidated,
  parseConsolidatedResponse,
  toNormalizedScore,
  type ConsolidatedCriteriaOptions,
  type ConsolidatedProvider,
  type EvaluationStepsCache,
} from './judge-consolidated.js';
import { estimateSpend } from './judge-agreement.js';
import {
  compareToReference,
  createReferenceProvider,
  estimateCallInputTokens,
  turnKey,
  FROZEN_TURNS_PATH,
  OUTPUT_TOKENS_PER_CALL_ESTIMATE as REFERENCE_OUTPUT_TOKENS_PER_CALL,
  REFERENCE_CONCURRENCY,
  REFERENCE_EFFORT,
  REFERENCE_MODEL,
  type QualityTurn,
  type ReferenceSummary,
} from './judge-quality-eval.js';
import { parseCli } from './cli-args.js';
import {
  DOCS_DIR,
  EXIT_REFUSED,
  JSON_INDENT,
  NO_BATCH_DELAY_MS,
  TABLE_NAME_WIDTH,
  YES_FLAG,
  YES_REQUIRED_ERROR,
  createRunGuard,
  formatDiff,
  formatUsd,
  createPerCriterionProvider,
  oneShotArgError,
  tableRow,
  scoresByName,
  spendCapReason,
} from './one-shot-eval.js';
import {
  addCallUsage,
  createCallUsageTotals,
  judgePricing,
  listCostUsd,
  tokenUsageCostUsd,
  type CallUsageReport,
  type CallUsageTotals,
} from './judge-usage.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The JCP4 results file whose non-hallucination reference scores are reused. */
export const PRIOR_REFERENCE_PATH = join(DOCS_DIR, 'judge-quality-2026-09-22.json');
/**
 * Not yet approved. Sized from JCP4's actuals on the same 30 turns: per-criterion
 * Haiku $2.99, consolidated $0.30 (twice here), and ~1 reference call per tool
 * turn at the ~$0.07 per call JCP4 measured.
 */
export const MAX_ESTIMATED_SPEND_USD = 8;
export const MAX_MEASURED_SPEND_USD = 8;
export const REFERENCE_FLAG = '--reference';
export const MARKER_FILENAME = '.judge-hallucination.started';
export const RESULTS_PREFIX = 'judge-hallucination-';
/** A turn whose faithfulness and hallucination sum to 1 within this is inferring, not measuring. */
const COMPLEMENT_EPSILON = 1e-9;
const DIRECT_OPTIONS: ConsolidatedCriteriaOptions = { directHallucination: true };

const CONFIGURATIONS = ['perCriterion', 'consolidated', 'consolidatedDirect'] as const;
export type Configuration = typeof CONFIGURATIONS[number];

const TABLE_CELL_WIDTH = 12;
const TIE = 'tie';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  yes: boolean;
  referencePath: string;
  /** Set when the invocation must be refused; the message says why. */
  error?: string;
}

export type HallucinationTurn = Pick<QualityTurn, 'sessionId' | 'timestamp' | 'hasTools' | 'expected' | 'reference'>
  & Record<Configuration, Record<string, number>>;

export interface ComplementCount {
  /** Turns with both faithfulness and hallucination. */
  paired: number;
  /** Of those, how many sum to 1. */
  sumToOne: number;
}

// ---------------------------------------------------------------------------
// Arguments and files
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { yes: false, referencePath: PRIOR_REFERENCE_PATH };
  try {
    const cli = parseCli(argv, { values: [REFERENCE_FLAG], switches: [YES_FLAG] }, { allowUnknown: false });
    parsed.yes = cli.has(YES_FLAG);
    parsed.referencePath = cli.value(REFERENCE_FLAG) ?? PRIOR_REFERENCE_PATH;
  } catch (err) {
    return { ...parsed, error: oneShotArgError(err) };
  }
  if (!parsed.yes) return { ...parsed, error: YES_REQUIRED_ERROR };
  return parsed;
}

const runGuard = createRunGuard({ markerFilename: MARKER_FILENAME, resultsPrefix: RESULTS_PREFIX, logPrefix: '[hallucination]', noun: 'eval' });
export const { listResultsFiles, resultsFilePath, refusalReason } = runGuard;
const { refuse, resolveApiKey, begin } = runGuard;

export function readPriorReference(path: string): QualityTurn[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { turns?: { reference?: unknown }[] };
  if (!Array.isArray(parsed.turns) || parsed.turns.some(t => typeof t.reference !== 'object' || t.reference === null)) {
    throw new Error(`${path} has no turns with reference scores — not a judge-quality results file`);
  }
  return parsed.turns as QualityTurn[];
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export function estimateRunSpend(
  turns: readonly Turn[],
  haikuPricing: ModelPricingEntry,
  referencePricing: ModelPricingEntry,
): { haikuUsd: number; referenceCalls: number; referenceUsd: number; totalUsd: number } {
  const haiku = estimateSpend(turns, haikuPricing);
  // The candidate is the consolidated call plus one criterion, so price it as a second consolidated run.
  const haikuUsd = haiku.perCriterionUsd + 2 * haiku.consolidatedUsd;
  const toolTurns = turns.filter(t => t.toolResults.length > 0);
  const inputTokens = toolTurns.reduce((sum, t) => sum + estimateCallInputTokens(t, HALLUCINATION_CRITERIA), 0);
  const referenceUsd = listCostUsd(inputTokens, toolTurns.length * REFERENCE_OUTPUT_TOKENS_PER_CALL, referencePricing);
  return { haikuUsd, referenceCalls: toolTurns.length, referenceUsd, totalUsd: haikuUsd + referenceUsd };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** The prior reference with its inverted hallucination replaced by a direct verdict, or dropped when there is none. */
export function mergeReference(prior: Record<string, number>, hallucination: number | undefined): Record<string, number> {
  const { [HALLUCINATION_EVAL_NAME]: _inverted, ...rest } = prior;
  return hallucination === undefined ? rest : { ...rest, [HALLUCINATION_EVAL_NAME]: hallucination };
}

/** Acceptance (c): a configuration that measures hallucination does not produce faithfulness + hallucination = 1. */
export function countComplements(scores: readonly Record<string, number>[]): ComplementCount {
  let paired = 0;
  let sumToOne = 0;
  for (const s of scores) {
    const faith = s[FAITHFULNESS_EVAL_NAME];
    const hal = s[HALLUCINATION_EVAL_NAME];
    if (faith === undefined || hal === undefined) continue;
    paired++;
    if (Math.abs(faith + hal - 1) < COMPLEMENT_EPSILON) sumToOne++;
  }
  return { paired, sumToOne };
}

/** Per criterion, the configuration with the lowest MAE against the reference; 'tie' when tied or unpaired. */
export function closestConfiguration(
  summaries: Record<Configuration, ReferenceSummary>,
): Record<string, Configuration | typeof TIE> {
  const names = new Set(CONFIGURATIONS.flatMap(c => Object.keys(summaries[c].byCriterion)));
  const verdict: Record<string, Configuration | typeof TIE> = {};
  for (const name of [...names].sort()) {
    const scored = CONFIGURATIONS
      .map(c => ({ c, mae: summaries[c].byCriterion[name]?.meanAbsDiff ?? null }))
      .filter((e): e is { c: Configuration; mae: number } => e.mae !== null)
      .sort((a, b) => a.mae - b.mae);
    const [best, next] = scored;
    verdict[name] = !best || scored.length < 2 || best.mae === next!.mae ? TIE : best.c;
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

/** One REFERENCE_MODEL call on HALLUCINATION_CRITERIA, stored higher-is-worse like the pipeline's records. */
async function scoreReferenceHallucination(
  provider: ConsolidatedProvider,
  turn: Turn,
  stepsCache: EvaluationStepsCache,
): Promise<number> {
  const steps = await cachedEvaluationSteps(provider, HALLUCINATION_CRITERIA, stepsCache);
  const prompt = buildConsolidatedPrompt(turn, fitContextForJudge(turn.toolResults), [{ config: HALLUCINATION_CRITERIA, steps }]);
  const response = await provider.generate(prompt, { schema: buildConsolidatedSchema([HALLUCINATION_CRITERIA.name]) });
  const parsed = parseConsolidatedResponse(response.text, [HALLUCINATION_CRITERIA.name]);
  const verdict = parsed.verdicts.get(HALLUCINATION_CRITERIA.name);
  if (!verdict) throw parsed.failures.get(HALLUCINATION_CRITERIA.name) ?? new Error('no hallucination verdict');
  return 1 - toNormalizedScore(verdict.score);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------


function printTable(
  summaries: Record<Configuration, ReferenceSummary>,
  closest: Record<string, Configuration | typeof TIE>,
  complements: Record<Configuration | 'reference', ComplementCount>,
): void {
  console.log(`\n[hallucination] MAE from ${REFERENCE_MODEL} (1–5 scale)`);
  console.log(tableRow(TABLE_CELL_WIDTH, 'criterion', ...CONFIGURATIONS.map(c => c.slice(0, TABLE_CELL_WIDTH - 1)), 'closest'));
  for (const name of Object.keys(closest)) {
    const maes = CONFIGURATIONS.map(c => formatDiff(summaries[c].byCriterion[name]?.meanAbsDiff));
    console.log(tableRow(TABLE_CELL_WIDTH, name, ...maes, closest[name]!));
  }
  console.log(tableRow(TABLE_CELL_WIDTH, 'overall', ...CONFIGURATIONS.map(c => formatDiff(summaries[c].overall.meanAbsDiff))));
  console.log('\n[hallucination] faithfulness + hallucination = 1 (acceptance c: the candidate should read 0)');
  for (const [name, count] of Object.entries(complements)) {
    console.log(`  ${name.padEnd(TABLE_NAME_WIDTH)} ${count.sumToOne}/${count.paired}`);
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

  const haikuPricing = judgePricing();
  const referencePricing = judgePricing(REFERENCE_MODEL);

  if (!existsSync(FROZEN_TURNS_PATH)) return refuse(`no frozen turns at ${FROZEN_TURNS_PATH}; judge-quality-eval.ts writes them`);
  const frozen = JSON.parse(readFileSync(FROZEN_TURNS_PATH, 'utf8')) as Turn[];
  const byKey = new Map(frozen.map(t => [turnKey(t), t]));
  const prior = readPriorReference(args.referencePath).filter(t => byKey.has(turnKey(t)));
  console.log(`[hallucination] ${prior.length} turns from ${args.referencePath} matched the frozen turns`);
  if (prior.length === 0) return refuse('no prior reference turn matches a frozen turn');

  const estimate = estimateRunSpend(prior.map(t => byKey.get(turnKey(t))!), haikuPricing, referencePricing);
  console.log(
    `[hallucination] estimate: Haiku ~${formatUsd(estimate.haikuUsd)}, `
    + `${estimate.referenceCalls} reference calls ~${formatUsd(estimate.referenceUsd)}`,
  );
  const overCap = spendCapReason(estimate.totalUsd, MAX_ESTIMATED_SPEND_USD);
  if (overCap) return refuse(overCap);

  const startedAt = begin(DOCS_DIR, { referencePath: args.referencePath, turns: prior.length });
  if (!startedAt) return;

  const totals: Record<Configuration | 'reference', CallUsageTotals> = {
    perCriterion: createCallUsageTotals(),
    consolidated: createCallUsageTotals(),
    consolidatedDirect: createCallUsageTotals(),
    reference: createCallUsageTotals(),
  };
  const judge = createLLMJudge(await createPerCriterionProvider(credential.apiKey, usage => addCallUsage(totals.perCriterion, usage)));
  const consolidated = await createConsolidatedProvider({ apiKey: credential.apiKey, onUsage: u => addCallUsage(totals.consolidated, u) });
  const direct = await createConsolidatedProvider({ apiKey: credential.apiKey, onUsage: u => addCallUsage(totals.consolidatedDirect, u) });
  const reference = await createReferenceProvider(credential.apiKey, u => addCallUsage(totals.reference, u));
  const caches: Record<'consolidated' | 'consolidatedDirect' | 'reference', EvaluationStepsCache> = {
    consolidated: new Map(),
    consolidatedDirect: new Map(),
    reference: new Map(),
  };

  const spentUsd = (): number => CONFIGURATIONS.reduce((sum, c) => sum + tokenUsageCostUsd(totals[c], haikuPricing), 0)
    + tokenUsageCostUsd(totals.reference, referencePricing);
  const canSpend = (): boolean => spentUsd() < MAX_MEASURED_SPEND_USD;
  const turnErrors: { sessionId: string; timestamp: string; errors: string[] }[] = [];
  resetFailureTracking();

  let completed = 0;
  const scored = await processBatch(prior, REFERENCE_CONCURRENCY, NO_BATCH_DELAY_MS, async (priorTurn): Promise<HallucinationTurn> => {
    const turn = byKey.get(turnKey(priorTurn))!;
    const errors: string[] = [];
    const outcome: HallucinationTurn = {
      sessionId: priorTurn.sessionId,
      timestamp: priorTurn.timestamp,
      hasTools: priorTurn.hasTools,
      expected: priorTurn.expected,
      reference: mergeReference(priorTurn.reference, undefined),
      perCriterion: {},
      consolidated: {},
      consolidatedDirect: {},
    };
    if (!canSpend()) {
      errors.push(`skipped, measured spend reached $${MAX_MEASURED_SPEND_USD}`);
    } else {
      try {
        outcome.perCriterion = scoresByName(await evaluateTurn(judge, turn, new Set()));
        outcome.consolidated = scoresByName(await evaluateTurnConsolidated(consolidated, turn, new Set(), caches.consolidated));
        outcome.consolidatedDirect = scoresByName(
          await evaluateTurnConsolidated(direct, turn, new Set(), caches.consolidatedDirect, DIRECT_OPTIONS),
        );
        if (turn.toolResults.length > 0 && canSpend()) {
          const hallucination = await scoreReferenceHallucination(reference, turn, caches.reference);
          outcome.reference = mergeReference(priorTurn.reference, hallucination);
        }
      } catch (err) {
        errors.push(describeUnknown(err));
      }
    }
    if (errors.length > 0) turnErrors.push({ sessionId: turn.sessionId, timestamp: turn.timestamp, errors });
    completed++;
    console.log(`[hallucination] ${completed}/${prior.length} turns done (${formatUsd(spentUsd())} so far)`);
    return outcome;
  });

  const summaries = Object.fromEntries(
    CONFIGURATIONS.map(c => [c, compareToReference(scored, c)]),
  ) as Record<Configuration, ReferenceSummary>;
  const closest = closestConfiguration(summaries);
  const complements = Object.fromEntries(
    [...CONFIGURATIONS, 'reference' as const].map(c => [c, countComplements(scored.map(t => t[c]))]),
  ) as Record<Configuration | 'reference', ComplementCount>;
  const usage = Object.fromEntries(Object.entries(totals).map(([name, t]) => [
    name,
    { ...t, usd: tokenUsageCostUsd(t, name === 'reference' ? referencePricing : haikuPricing) } satisfies CallUsageReport,
  ]));

  const results = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    priorReference: args.referencePath,
    reference: {
      model: REFERENCE_MODEL,
      effort: REFERENCE_EFFORT,
      method: 'hallucination: G-Eval on HALLUCINATION_CRITERIA, judged directly, one call per tool turn; '
        + 'every other criterion reused from the prior reference',
    },
    haikuModel: HAIKU_MODEL,
    turnsEvaluated: scored.length,
    estimate,
    usage,
    distance: summaries,
    closest,
    complement: complements,
    failures: turnErrors,
    turns: scored,
  };

  const outPath = resultsFilePath(DOCS_DIR, startedAt);
  writeFileSync(outPath, JSON.stringify(results, null, JSON_INDENT) + '\n');
  printTable(summaries, closest, complements);
  console.log(`\n[hallucination] spent ${formatUsd(spentUsd())}; results written: ${outPath}`);
}

// Only run when executed directly (not imported as a module for testing)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[hallucination] fatal:', err);
    process.exitCode = EXIT_REFUSED;
  });
}
