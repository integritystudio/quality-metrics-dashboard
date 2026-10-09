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

/** The `usage` of one Messages API response; cache counts are null on models without caching. */
export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The one accounting shape; `ProviderUsage` is converted to it at the SDK boundary and nowhere else. */
export interface JudgeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function toJudgeTokenUsage(usage: ProviderUsage): JudgeTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export function createUsageTotals(): JudgeTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function addUsage(totals: JudgeTokenUsage, usage: JudgeTokenUsage): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens;
}

export interface CallUsageTotals extends JudgeTokenUsage {
  calls: number;
}

/** {@link CallUsageTotals} priced at list rates. */
export interface CallUsageReport extends CallUsageTotals {
  usd: number;
}

export function createCallUsageTotals(): CallUsageTotals {
  return { calls: 0, ...createUsageTotals() };
}

export function addCallUsage(totals: CallUsageTotals, usage: JudgeTokenUsage): void {
  totals.calls += 1;
  addUsage(totals, usage);
}

/** List pricing for `model` (the judge's by default); throws rather than pricing a run at $0. */
export function judgePricing(model: string = HAIKU_MODEL): ModelPricingEntry {
  const pricing = Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model] : undefined;
  if (!pricing) throw new Error(`No pricing data for model ${model}`);
  return pricing;
}

/**
 * USD a usage implies at list rates: input and output as billed, cache reads
 * and writes at their ratios. The one place judge spend is priced.
 */
export function tokenUsageCostUsd(usage: JudgeTokenUsage, pricing: ModelPricingEntry): number {
  const perToken = (tokens: number, rate: number): number => (tokens / TOKENS_PER_MILLION) * rate;
  return perToken(usage.inputTokens, pricing.input)
    + perToken(usage.outputTokens, pricing.output)
    + perToken(usage.cacheReadInputTokens, pricing.input * CACHE_READ_INPUT_PRICE_RATIO)
    + perToken(usage.cacheCreationInputTokens, pricing.input * CACHE_CREATION_INPUT_PRICE_RATIO);
}

/** List cost of token counts with no cache traffic — how every pre-run estimate is priced. */
export function listCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricingEntry): number {
  return tokenUsageCostUsd({ inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, pricing);
}

/** Estimated tokens for `chars` characters of prompt text (TOKENS_PER_CHAR, rounded up). */
export function charsToTokens(chars: number): number {
  return Math.ceil(chars * TOKENS_PER_CHAR);
}

/** Combined length of `texts`. */
export function totalChars(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + text.length, 0);
}

/** Tokens the judge sees for one turn (tool context fitted as the judge fits it), by chars-per-token. */
export function estimateTurnTokens(turn: Turn): number {
  return charsToTokens(turn.userText.length + turn.assistantText.length + totalChars(fitContextForJudge(turn.toolResults)));
}

/** List cost of an estimate's tokens, at the batch rate when `batch`. */
function estimateCostUsd(inputTokens: number, outputTokens: number, batch: boolean): number {
  const listUsd = listCostUsd(inputTokens, outputTokens, judgePricing());
  return batch ? listUsd * BATCH_PRICE_RATIO : listUsd;
}

/** Estimated tokens per evaluation response — the judge answers with a short JSON verdict. */
export const EST_OUTPUT_TOKENS_PER_EVAL = 200;

/** Criteria in one consolidated prompt: relevance and coherence, always. */
export const CONSOLIDATED_BASE_CRITERIA = 2;

/** Added with tool results: faithfulness, tool_correctness and its three sub-criteria. */
export const CONSOLIDATED_TOOL_CRITERIA = 5;

/** Per-criterion calls every turn costs: relevance and coherence. */
const PER_CRITERION_BASE_CALLS = 2;
/**
 * Added with tool results: tool_correctness, and one QAG sweep that scores
 * faithfulness and hallucination together.
 */
const PER_CRITERION_TOOL_CALLS = 2;

export interface JudgeRunEstimate {
  evals: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * What the run should cost before it spends anything, priced from content
 * length (TOKENS_PER_CHAR). The dry-run prints it; a real run prints it beside
 * the usage the API reported, which can run well above it. Pass `batch: true` when `--batch` is set — Message Batches
 * bill at BATCH_PRICE_RATIO (half list rates). Pass `consolidated: true` for
 * the default mode, which sends each turn's content once and answers every
 * criterion in that one call.
 */
export function estimateJudgeRun(turns: readonly Turn[], batch = false, consolidated = false): JudgeRunEstimate {
  if (consolidated) return estimateConsolidatedRun(turns, batch);
  let evals = 0;
  let inputTokens = 0;
  for (const t of turns) {
    const turnEvals = PER_CRITERION_BASE_CALLS + (t.toolResults.length > 0 ? PER_CRITERION_TOOL_CALLS : 0);
    const contentChars = t.userText.length + t.assistantText.length + totalChars(t.toolResults);
    evals += turnEvals;
    // Every per-criterion call resends the turn's content.
    inputTokens += charsToTokens(contentChars) * turnEvals;
  }
  const outputTokens = evals * EST_OUTPUT_TOKENS_PER_EVAL;
  const costUsd = estimateCostUsd(inputTokens, outputTokens, batch);
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
    inputTokens += estimateTurnTokens(t);
    const criteria = CONSOLIDATED_BASE_CRITERIA + (t.toolResults.length > 0 ? CONSOLIDATED_TOOL_CRITERIA : 0);
    outputTokens += criteria * EST_OUTPUT_TOKENS_PER_EVAL;
  }
  const costUsd = estimateCostUsd(inputTokens, outputTokens, batch);
  return { evals: turns.length, inputTokens, outputTokens, costUsd };
}
