/** Token accounting, list pricing and pre-run cost estimates for the judge. */

import { MODEL_PRICING, TOKENS_PER_CHAR, TOKENS_PER_MILLION, type ModelPricingEntry } from '../../src/lib/core/constants-models.js';
import { HAIKU_MODEL } from './judge-criteria.js';
import { fitContextForJudge, type Turn } from './judge-turns.js';

/** Cache reads bill at a tenth of the input rate. */
export const CACHE_READ_INPUT_PRICE_RATIO = 0.1;

/** Cache writes bill at 1.25x the input rate. */
export const CACHE_CREATION_INPUT_PRICE_RATIO = 1.25;

/** Message Batches API bills at half the synchronous rate. */
export const BATCH_PRICE_RATIO = 0.5;

/** Token totals folded from every `response.usage` a run saw. Field names match the API. */
export interface JudgeUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** The `usage` of one Messages API response; cache counts are null on models without caching. */
export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function createUsageTotals(): JudgeUsageTotals {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

/** Fold one response's usage into the run totals. */
export function recordUsage(totals: JudgeUsageTotals, usage: ProviderUsage): void {
  totals.input_tokens += usage.input_tokens;
  totals.output_tokens += usage.output_tokens;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

/** List pricing for the judge model; throws rather than pricing a run at $0. */
export function judgePricing(): ModelPricingEntry {
  const pricing = MODEL_PRICING[HAIKU_MODEL];
  if (!pricing) throw new Error(`No pricing data for model ${HAIKU_MODEL}`);
  return pricing;
}

/** USD the totals imply at list rates: input and output as billed, cache reads and writes at their ratios. */
export function usageCostUsd(totals: JudgeUsageTotals, pricing: ModelPricingEntry): number {
  const inputUsd = (totals.input_tokens / TOKENS_PER_MILLION) * pricing.input;
  const outputUsd = (totals.output_tokens / TOKENS_PER_MILLION) * pricing.output;
  const cacheReadUsd = (totals.cache_read_input_tokens / TOKENS_PER_MILLION) * pricing.input * CACHE_READ_INPUT_PRICE_RATIO;
  const cacheCreationUsd = (totals.cache_creation_input_tokens / TOKENS_PER_MILLION) * pricing.input * CACHE_CREATION_INPUT_PRICE_RATIO;
  return inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd;
}

/** Estimated tokens per evaluation response — the judge answers with a short JSON verdict. */
export const EST_OUTPUT_TOKENS_PER_EVAL = 200;

/** Criteria in one consolidated prompt: relevance and coherence, always. */
export const CONSOLIDATED_BASE_CRITERIA = 2;

/** Added with tool results: faithfulness, tool_correctness and its three sub-criteria. */
export const CONSOLIDATED_TOOL_CRITERIA = 5;

export interface JudgeRunEstimate {
  evals: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * What the run should cost before it spends anything, priced from content
 * length (TOKENS_PER_CHAR). The dry-run prints it; a real run prints it beside
 * the usage the API reported, which is how a $1.80 estimate was found to be
 * a ~$3.30 bill. Pass `batch: true` when `--batch` is set — Message Batches
 * bill at BATCH_PRICE_RATIO (half list rates). Pass `consolidated: true` for
 * the default mode, which sends each turn's content once and answers every
 * criterion in that one call.
 */
export function estimateJudgeRun(turns: readonly Turn[], batch = false, consolidated = false): JudgeRunEstimate {
  if (consolidated) return estimateConsolidatedRun(turns, batch);
  // 2 base evals (relevance, coherence) + 2 with tools (tool_correctness, and one
  // QAG sweep that scores faithfulness and hallucination together — hallucination
  // is no longer a paid call of its own).
  const evals = turns.reduce((sum, t) =>
    sum + 2 + (t.toolResults.length > 0 ? 2 : 0), 0);
  // Estimate tokens from actual content length (~4 chars/token)
  const inputTokens = turns.reduce((sum, t) => {
    const contentChars = t.userText.length + t.assistantText.length
      + t.toolResults.reduce((s, r) => s + r.length, 0);
    const evalsPerTurn = 2 + (t.toolResults.length > 0 ? 2 : 0);
    return sum + Math.ceil(contentChars * TOKENS_PER_CHAR) * evalsPerTurn;
  }, 0);
  const outputTokens = evals * EST_OUTPUT_TOKENS_PER_EVAL;
  const pricing = judgePricing();
  const listCostUsd = (inputTokens / TOKENS_PER_MILLION) * pricing.input
    + (outputTokens / TOKENS_PER_MILLION) * pricing.output;
  const costUsd = batch ? listCostUsd * BATCH_PRICE_RATIO : listCostUsd;
  return { evals, inputTokens, outputTokens, costUsd };
}

/**
 * One call per turn: content once, every criterion's reasoning in the reply.
 * The per-criterion steps calls (one per criterion per run) are left out —
 * at most seven short calls, noise beside the verdicts.
 */
export function estimateConsolidatedRun(turns: readonly Turn[], batch: boolean): JudgeRunEstimate {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const t of turns) {
    const contentChars = t.userText.length + t.assistantText.length
      + fitContextForJudge(t.toolResults).reduce((s, r) => s + r.length, 0);
    inputTokens += Math.ceil(contentChars * TOKENS_PER_CHAR);
    const criteria = CONSOLIDATED_BASE_CRITERIA + (t.toolResults.length > 0 ? CONSOLIDATED_TOOL_CRITERIA : 0);
    outputTokens += criteria * EST_OUTPUT_TOKENS_PER_EVAL;
  }
  const pricing = judgePricing();
  const listCostUsd = (inputTokens / TOKENS_PER_MILLION) * pricing.input
    + (outputTokens / TOKENS_PER_MILLION) * pricing.output;
  const costUsd = batch ? listCostUsd * BATCH_PRICE_RATIO : listCostUsd;
  return { evals: turns.length, inputTokens, outputTokens, costUsd };
}
