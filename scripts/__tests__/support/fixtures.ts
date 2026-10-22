import type { ModelPricingEntry } from '../../../../src/lib/core/constants-models.js';
import { TIME_MS } from '../../../../src/lib/core/units.js';
import { HALLUCINATION_EVAL_NAME } from '../../../src/lib/validation/dashboard-schemas.js';
import {
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  HAIKU_MODEL,
  RELEVANCE_EVAL_NAME,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_CORRECTNESS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
  TOOL_SELECTION_CRITERIA,
} from '../../judge-criteria.js';
import { judgedByKey, turnKeyOf, turnScoreKey } from '../../judge-dedup.js';
import type { Turn } from '../../judge-turns.js';

/** Round per-million rates, so expected costs are easy to compute by hand. */
export const TEST_PRICING: ModelPricingEntry = { input: 1, output: 5, provider: 'anthropic' };

/** What the seed path writes for a turn without tool results, in emit order. */
export const SEED_RECORDS = [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, HALLUCINATION_EVAL_NAME];

/** What either LLM judge path writes for a turn with tool results, in emit order. */
export const TOOL_TURN_RECORDS = [
  ...SEED_RECORDS,
  TOOL_CORRECTNESS_CRITERIA.name,
  TOOL_SELECTION_CRITERIA.name,
  TOOL_ARGUMENTS_CRITERIA.name,
  TOOL_INTEGRATION_CRITERIA.name,
];

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

/** A turn with one tool result, which brings in the faithfulness, hallucination and tool criteria. */
export function makeToolTurn(overrides: Partial<Turn> = {}): Turn {
  return makeTurn({ toolResults: ['tool output'], ...overrides });
}

/** `count` turns, each in its own session and a minute after the last. */
export function turnSeries(count: number, overrides: Partial<Turn> = {}): Turn[] {
  const startMs = Date.parse(makeTurn().timestamp);
  return Array.from({ length: count }, (_, i) => makeTurn({
    sessionId: `session-${i}`,
    timestamp: new Date(startMs + i * TIME_MS.MINUTE).toISOString(),
    ...overrides,
  }));
}

/** The keys an LLM judgement of each name leaves in the dedup set, which the LLM paths check. */
export function judgedKeys(turn: Turn, names: readonly string[], judgeModel: string = HAIKU_MODEL): Set<string> {
  return new Set(names.map(name => judgedByKey(turn.sessionId, name, turnKeyOf(turn.timestamp), judgeModel)));
}

/** The model-free keys every stored score leaves in the dedup set, which the seed path checks. */
export function scoredKeys(turn: Turn, names: readonly string[]): Set<string> {
  return new Set(names.map(name => turnScoreKey(turn.sessionId, name, turnKeyOf(turn.timestamp))));
}

/** Text lengths long enough that token estimates are not rounding noise. */
export const SIZED_TURN_CHARS = { user: 400, assistant: 800 } as const;

/** A turn with SIZED_TURN_CHARS-long texts. */
export function makeSizedTurn(overrides: Partial<Turn> = {}): Turn {
  return makeTurn({ userText: 'u'.repeat(SIZED_TURN_CHARS.user), assistantText: 'a'.repeat(SIZED_TURN_CHARS.assistant), ...overrides });
}
