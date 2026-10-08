import { describe, it, expect } from 'vitest';
import { TOKENS_PER_MILLION, type ModelPricingEntry } from '../../../src/lib/core/constants-models.js';
import {
  addCallUsage,
  charsToTokens,
  createCallUsageTotals,
  createUsageTotals,
  judgePricing,
  recordUsage,
  tokenUsageCostUsd,
  totalChars,
  usageCostUsd,
  CACHE_CREATION_INPUT_PRICE_RATIO,
  CACHE_READ_INPUT_PRICE_RATIO,
} from '../judge-usage.js';

const PRICING: ModelPricingEntry = { input: 2, output: 10, provider: 'anthropic' };
const CACHE_PRICE = PRICING.input * (CACHE_READ_INPUT_PRICE_RATIO + CACHE_CREATION_INPUT_PRICE_RATIO);

describe('tokenUsageCostUsd', () => {
  it('prices input and output per million at the model rate', () => {
    const usage = { inputTokens: TOKENS_PER_MILLION, outputTokens: TOKENS_PER_MILLION, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(tokenUsageCostUsd(usage, PRICING)).toBeCloseTo(PRICING.input + PRICING.output);
  });

  it('prices cache reads and writes at their input-rate ratios', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: TOKENS_PER_MILLION, cacheReadInputTokens: TOKENS_PER_MILLION };
    expect(tokenUsageCostUsd(usage, PRICING)).toBeCloseTo(CACHE_PRICE);
  });
});

describe('usageCostUsd', () => {
  it('prices snake_case run totals the same way, and a run with no calls at zero', () => {
    const totals = {
      input_tokens: TOKENS_PER_MILLION,
      output_tokens: TOKENS_PER_MILLION,
      cache_read_input_tokens: TOKENS_PER_MILLION,
      cache_creation_input_tokens: TOKENS_PER_MILLION,
    };
    expect(usageCostUsd(totals, PRICING)).toBeCloseTo(PRICING.input + PRICING.output + CACHE_PRICE);
    expect(usageCostUsd(createUsageTotals(), PRICING)).toBe(0);
  });
});

describe('usage totals', () => {
  it('recordUsage sums every response and treats null cache counts as zero', () => {
    const totals = createUsageTotals();
    recordUsage(totals, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
    recordUsage(totals, { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null });
    expect(totals).toEqual({ input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
  });

  it('addCallUsage accumulates usage and call counts', () => {
    const totals = createCallUsageTotals();
    addCallUsage(totals, { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 1, cacheReadInputTokens: 0 });
    addCallUsage(totals, { inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 4 });
    expect(totals).toEqual({ calls: 2, inputTokens: 15, outputTokens: 5, cacheCreationInputTokens: 1, cacheReadInputTokens: 4 });
  });
});

describe('judgePricing', () => {
  it('prices the judge model by default and throws for an unpriced model', () => {
    expect(judgePricing().input).toBeGreaterThan(0);
    expect(() => judgePricing('no-such-model')).toThrow(/No pricing data for model no-such-model/);
    expect(() => judgePricing('toString')).toThrow(/No pricing data/);
  });
});

describe('token estimates', () => {
  it('sums text lengths and rounds the token estimate up', () => {
    expect(totalChars(['ab', '', 'cde'])).toBe(5);
    expect(totalChars([])).toBe(0);
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(1)).toBe(1);
  });
});
