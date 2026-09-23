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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, constants } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { LLMJudge, HALLUCINATION_CRITERIA } from '../../src/lib/judge/llm-judge-config.js';
import { MODEL_PRICING, type ModelPricingEntry } from '../../src/lib/core/constants-models.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { HALLUCINATION_EVAL_NAME, LLM_EVALUATOR_TYPE } from '../../src/lib/validation/dashboard-schemas.js';
import {
  evaluateTurn,
  processBatch,
  fitContextForJudge,
  resetFailureTracking,
  FAITHFULNESS_EVAL_NAME,
  HAIKU_MODEL,
  PRODUCER,
  type Turn,
} from './judge-evaluations.js';
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
import {
  addUsage,
  createPerCriterionProvider,
  createUsageTotals,
  estimateSpend,
  resolveApiKey,
  scoresByName,
  usageToUsd,
  DOCS_DIR,
  JUDGE_MAX_RETRIES,
  PRIMARY_KEY_ENV,
  FALLBACK_KEY_ENV,
  RESULTS_SUFFIX,
  type UsageReport,
  type UsageTotals,
} from './judge-agreement.js';
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
export const YES_FLAG = '--yes';
export const REFERENCE_FLAG = '--reference';
export const MARKER_FILENAME = '.judge-hallucination.started';
export const RESULTS_PREFIX = 'judge-hallucination-';
/** A turn whose faithfulness and hallucination sum to 1 within this is inferring, not measuring. */
export const COMPLEMENT_EPSILON = 1e-9;
export const DIRECT_OPTIONS: ConsolidatedCriteriaOptions = { directHallucination: true };

export const CONFIGURATIONS = ['perCriterion', 'consolidated', 'consolidatedDirect'] as const;
export type Configuration = typeof CONFIGURATIONS[number];

const KNOWN_FLAGS: ReadonlySet<string> = new Set([YES_FLAG, REFERENCE_FLAG]);
const ISO_DATE_LEN = 10;
const JSON_INDENT = 2;
const EXIT_REFUSED = 1;
const NO_BATCH_DELAY_MS = 0;
const DIFF_DECIMALS = 3;
const USD_DECIMALS = 4;
const TABLE_NAME_WIDTH = 18;
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === YES_FLAG) {
      parsed.yes = true;
      continue;
    }
    if (arg === REFERENCE_FLAG) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { ...parsed, error: `${REFERENCE_FLAG} needs a path` };
      parsed.referencePath = value;
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) return { ...parsed, error: `Unknown argument: ${arg} (there is no --force; remove the marker and results file by hand if you mean it)` };
  }
  if (!parsed.yes) return { ...parsed, error: `${YES_FLAG} is required: this run spends real API money` };
  return parsed;
}

export function listResultsFiles(docsDir: string): string[] {
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter(f => f.startsWith(RESULTS_PREFIX) && f.endsWith(RESULTS_SUFFIX))
    .sort();
}

export function resultsFilePath(docsDir: string, date: Date): string {
  return join(docsDir, `${RESULTS_PREFIX}${date.toISOString().slice(0, ISO_DATE_LEN)}${RESULTS_SUFFIX}`);
}

/** Why the run must not start, or undefined when it may. */
export function refusalReason(docsDir: string): string | undefined {
  const marker = join(docsDir, MARKER_FILENAME);
  if (existsSync(marker)) return `marker exists: ${marker} — a run already started; this eval runs once`;
  const results = listResultsFiles(docsDir);
  if (results.length > 0) return `results already exist: ${results.join(', ')} — this eval runs once`;
  return undefined;
}

/** O_CREAT | O_EXCL: two concurrent starts cannot both win. */
function writeMarker(docsDir: string, payload: object): void {
  mkdirSync(docsDir, { recursive: true });
  const fd = openSync(join(docsDir, MARKER_FILENAME), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  writeFileSync(fd, JSON.stringify(payload, null, JSON_INDENT) + '\n');
  closeSync(fd);
}

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
  const referenceUsd = usageToUsd({
    inputTokens,
    outputTokens: toolTurns.length * REFERENCE_OUTPUT_TOKENS_PER_CALL,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }, referencePricing);
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

function cell(value: string | number): string {
  return String(value).padStart(TABLE_CELL_WIDTH);
}

function formatDiff(diff: number | null | undefined): string {
  return diff === null || diff === undefined ? '-' : diff.toFixed(DIFF_DECIMALS);
}

function printTable(
  summaries: Record<Configuration, ReferenceSummary>,
  closest: Record<string, Configuration | typeof TIE>,
  complements: Record<Configuration | 'reference', ComplementCount>,
): void {
  console.log(`\n[hallucination] MAE from ${REFERENCE_MODEL} (1–5 scale)`);
  console.log(`${'criterion'.padEnd(TABLE_NAME_WIDTH)}${CONFIGURATIONS.map(c => cell(c.slice(0, TABLE_CELL_WIDTH - 1))).join('')}${cell('closest')}`);
  for (const name of Object.keys(closest)) {
    const maes = CONFIGURATIONS.map(c => cell(formatDiff(summaries[c].byCriterion[name]?.meanAbsDiff)));
    console.log(`${name.padEnd(TABLE_NAME_WIDTH)}${maes.join('')}${cell(closest[name]!)}`);
  }
  const overall = CONFIGURATIONS.map(c => cell(formatDiff(summaries[c].overall.meanAbsDiff)));
  console.log(`${'overall'.padEnd(TABLE_NAME_WIDTH)}${overall.join('')}`);
  console.log('\n[hallucination] faithfulness + hallucination = 1 (acceptance c: the candidate should read 0)');
  for (const [name, count] of Object.entries(complements)) {
    console.log(`  ${name.padEnd(TABLE_NAME_WIDTH)} ${count.sumToOne}/${count.paired}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function refuse(message: string): void {
  console.error(`[hallucination] refused: ${message}`);
  process.exitCode = EXIT_REFUSED;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) return refuse(args.error);

  const credential = resolveApiKey(process.env);
  if (!credential) return refuse(`no API key: set ${PRIMARY_KEY_ENV} (or ${FALLBACK_KEY_ENV})`);
  console.log(`[hallucination] API key from ${credential.source}`);

  const reason = refusalReason(DOCS_DIR);
  if (reason) return refuse(reason);

  const haikuPricing = MODEL_PRICING[HAIKU_MODEL];
  const referencePricing = MODEL_PRICING[REFERENCE_MODEL];
  if (!haikuPricing || !referencePricing) return refuse(`no pricing data for ${HAIKU_MODEL} or ${REFERENCE_MODEL}`);

  if (!existsSync(FROZEN_TURNS_PATH)) return refuse(`no frozen turns at ${FROZEN_TURNS_PATH}; judge-quality-eval.ts writes them`);
  const frozen = JSON.parse(readFileSync(FROZEN_TURNS_PATH, 'utf8')) as Turn[];
  const byKey = new Map(frozen.map(t => [turnKey(t), t]));
  const prior = readPriorReference(args.referencePath).filter(t => byKey.has(turnKey(t)));
  console.log(`[hallucination] ${prior.length} turns from ${args.referencePath} matched the frozen turns`);
  if (prior.length === 0) return refuse('no prior reference turn matches a frozen turn');

  const estimate = estimateRunSpend(prior.map(t => byKey.get(turnKey(t))!), haikuPricing, referencePricing);
  console.log(
    `[hallucination] estimate: Haiku ~$${estimate.haikuUsd.toFixed(USD_DECIMALS)}, `
    + `${estimate.referenceCalls} reference calls ~$${estimate.referenceUsd.toFixed(USD_DECIMALS)}`,
  );
  if (estimate.totalUsd > MAX_ESTIMATED_SPEND_USD) {
    return refuse(`estimated spend $${estimate.totalUsd.toFixed(USD_DECIMALS)} exceeds the $${MAX_ESTIMATED_SPEND_USD} cap`);
  }

  const lateReason = refusalReason(DOCS_DIR);
  if (lateReason) return refuse(lateReason);
  const startedAt = new Date();
  writeMarker(DOCS_DIR, { startedAt: startedAt.toISOString(), pid: process.pid, referencePath: args.referencePath, turns: prior.length });
  console.log(`[hallucination] marker written: ${join(DOCS_DIR, MARKER_FILENAME)} — API calls start now`);

  const totals: Record<Configuration | 'reference', UsageTotals> = {
    perCriterion: createUsageTotals(),
    consolidated: createUsageTotals(),
    consolidatedDirect: createUsageTotals(),
    reference: createUsageTotals(),
  };
  const judge = new LLMJudge(
    await createPerCriterionProvider(credential.key, usage => addUsage(totals.perCriterion, usage)),
    {
      timeoutMs: TIME_MS.MINUTE,
      maxRetries: JUDGE_MAX_RETRIES,
      evaluator: PRODUCER,
      evaluatorType: LLM_EVALUATOR_TYPE,
      logger: {
        warn: (msg) => console.warn(`  [warn] ${msg}`),
        error: (msg) => console.error(`  [error] ${msg}`),
      },
    },
  );
  const consolidated = await createConsolidatedProvider({ apiKey: credential.key, onUsage: u => addUsage(totals.consolidated, u) });
  const direct = await createConsolidatedProvider({ apiKey: credential.key, onUsage: u => addUsage(totals.consolidatedDirect, u) });
  const reference = await createReferenceProvider(credential.key, u => addUsage(totals.reference, u));
  const caches: Record<'consolidated' | 'consolidatedDirect' | 'reference', EvaluationStepsCache> = {
    consolidated: new Map(),
    consolidatedDirect: new Map(),
    reference: new Map(),
  };

  const spentUsd = (): number => CONFIGURATIONS.reduce((sum, c) => sum + usageToUsd(totals[c], haikuPricing), 0)
    + usageToUsd(totals.reference, referencePricing);
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
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length > 0) turnErrors.push({ sessionId: turn.sessionId, timestamp: turn.timestamp, errors });
    completed++;
    console.log(`[hallucination] ${completed}/${prior.length} turns done ($${spentUsd().toFixed(USD_DECIMALS)} so far)`);
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
    { ...t, usd: usageToUsd(t, name === 'reference' ? referencePricing : haikuPricing) } satisfies UsageReport,
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
  console.log(`\n[hallucination] spent $${spentUsd().toFixed(USD_DECIMALS)}; results written: ${outPath}`);
}

// Only run when executed directly (not imported as a module for testing)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[hallucination] fatal:', err);
    process.exitCode = EXIT_REFUSED;
  });
}
