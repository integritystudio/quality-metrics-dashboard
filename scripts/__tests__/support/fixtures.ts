import type { ModelPricingEntry } from '../../../../src/lib/core/constants-models.js';
import type { Turn } from '../../judge-turns.js';

/** Round per-million rates, so expected costs are easy to compute by hand. */
export const TEST_PRICING: ModelPricingEntry = { input: 1, output: 5, provider: 'anthropic' };

/** A short, tool-free turn; each test overrides what it exercises. */
export function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-02-09T01:11:15.525Z',
    userText: 'Fix the login bug',
    assistantText: 'I found the issue in auth.ts and fixed it.',
    toolResults: [],
    ...overrides,
  };
}

/** A turn with 400- and 800-character texts, long enough that token estimates are not rounding noise. */
export function makeSizedTurn(overrides: Partial<Turn> = {}): Turn {
  return makeTurn({ userText: 'u'.repeat(400), assistantText: 'a'.repeat(800), ...overrides });
}
