import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectCriteria,
  buildConsolidatedSchema,
  buildConsolidatedPrompt,
  buildStepsPrompt,
  parseConsolidatedResponse,
  validateVerdict,
  toNormalizedScore,
  evaluateTurnConsolidated,
  cachedEvaluationSteps,
  sourceCriterionName,
  CONSOLIDATED_PRODUCER,
  REASONING_KEY,
  SCORE_KEY,
  type ConsolidatedProvider,
  type ConsolidatedGenerateOptions,
  type EvaluationStepsCache,
} from '../judge-consolidated.js';
import {
  evalFailures,
  failureClasses,
  resetFailureTracking,
  RELEVANCE_EVAL_NAME,
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  TOOL_CORRECTNESS_CRITERIA,
  TOOL_SELECTION_CRITERIA,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
  PRODUCER,
  HAIKU_MODEL,
  type Turn,
} from '../judge-evaluations.js';
import { RELEVANCE_CRITERIA, COHERENCE_CRITERIA } from '../../../src/lib/judge/llm-judge-config.js';
import { G_EVAL_MAX_SCORE, G_EVAL_MIN_SCORE } from '../../../src/lib/judge/llm-judge-constants.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_TEXT = 'Fix the login bug in auth.ts';
const ASSISTANT_TEXT = 'I found the null check missing in auth.ts and fixed it.';
const TOOL_RESULT = 'export function login() { /* … */ }';
const TURN_KEY = '2026-02-09T01:11:15';
const FAKE_STEPS = '1. Read the input\n2. Compare with the output\n3. Check every claim';
const DEFAULT_SCORE = 4;
const OUT_OF_RANGE_SCORE = G_EVAL_MAX_SCORE + 1;

const ALL_TOOL_NAMES = [
  RELEVANCE_EVAL_NAME,
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  'hallucination',
  TOOL_CORRECTNESS_CRITERIA.name,
  TOOL_SELECTION_CRITERIA.name,
  TOOL_ARGUMENTS_CRITERIA.name,
  TOOL_INTEGRATION_CRITERIA.name,
];
const ALL_TOOL_CRITERIA = ALL_TOOL_NAMES.filter(n => n !== 'hallucination');
const DIRECT = { directHallucination: true } as const;

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: `${TURN_KEY}.525Z`,
    userText: USER_TEXT,
    assistantText: ASSISTANT_TEXT,
    toolResults: [],
    ...overrides,
  };
}

function keyFor(turn: Turn, name: string): string {
  return `${turn.sessionId}:${name}:${TURN_KEY}`;
}

interface RecordedCall {
  prompt: string;
  options: ConsolidatedGenerateOptions | undefined;
}

/** Answers steps prompts with a numbered list and schema calls with one verdict per required key. */
function createFakeProvider(
  scores: Record<string, unknown> = {},
  calls: RecordedCall[] = [],
  verdictText?: string,
): ConsolidatedProvider {
  return {
    generate(prompt, options) {
      calls.push({ prompt, options });
      if (!options?.schema) return Promise.resolve({ text: FAKE_STEPS });
      if (verdictText !== undefined) return Promise.resolve({ text: verdictText });
      const required = (options.schema as { required: string[] }).required;
      const body = Object.fromEntries(required.map(name => [
        name,
        { [REASONING_KEY]: `${name} reasoning`, [SCORE_KEY]: scores[name] ?? DEFAULT_SCORE },
      ]));
      return Promise.resolve({ text: JSON.stringify(body) });
    },
  };
}

function names(selection: { criteria: { name: string }[] }): string[] {
  return selection.criteria.map(c => c.name);
}

// ---------------------------------------------------------------------------
// selectCriteria — schema key selection mirrors evaluateTurn
// ---------------------------------------------------------------------------

describe('selectCriteria', () => {
  it('selects relevance and coherence for a turn without tool results', () => {
    const selection = selectCriteria(makeTurn(), new Set());
    expect(names(selection)).toEqual([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(selection.recordNames).toEqual([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
  });

  it('selects every criterion for a turn with tool results, records in the per-criterion order', () => {
    const selection = selectCriteria(makeTurn({ toolResults: [TOOL_RESULT] }), new Set());
    expect(names(selection)).toEqual(ALL_TOOL_CRITERIA);
    expect(selection.recordNames).toEqual(ALL_TOOL_NAMES);
  });

  it('drops a criterion whose dedup key already exists', () => {
    const turn = makeTurn();
    const selection = selectCriteria(turn, new Set([keyFor(turn, RELEVANCE_EVAL_NAME)]));
    expect(names(selection)).toEqual([COHERENCE_EVAL_NAME]);
    expect(selection.recordNames).toEqual([COHERENCE_EVAL_NAME]);
  });

  it('keeps faithfulness in the schema when only hallucination is still needed', () => {
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });
    const selection = selectCriteria(turn, new Set([keyFor(turn, FAITHFULNESS_EVAL_NAME)]));
    expect(names(selection)).toContain(FAITHFULNESS_EVAL_NAME);
    expect(selection.recordNames).toContain('hallucination');
    expect(selection.recordNames).not.toContain(FAITHFULNESS_EVAL_NAME);
  });

  it('skips the tool sub-criteria when tool_correctness already exists, as evaluateTurn does', () => {
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });
    const selection = selectCriteria(turn, new Set([keyFor(turn, TOOL_CORRECTNESS_CRITERIA.name)]));
    expect(names(selection)).not.toContain(TOOL_SELECTION_CRITERIA.name);
    expect(names(selection)).not.toContain(TOOL_ARGUMENTS_CRITERIA.name);
    expect(names(selection)).not.toContain(TOOL_INTEGRATION_CRITERIA.name);
  });

  it('selects nothing when every key exists', () => {
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });
    const selection = selectCriteria(turn, new Set(ALL_TOOL_NAMES.map(n => keyFor(turn, n))));
    expect(selection.criteria).toEqual([]);
    expect(selection.recordNames).toEqual([]);
  });

  it('derives hallucination from faithfulness and every other record from itself', () => {
    expect(sourceCriterionName('hallucination')).toBe(FAITHFULNESS_EVAL_NAME);
    expect(sourceCriterionName(RELEVANCE_EVAL_NAME)).toBe(RELEVANCE_EVAL_NAME);
  });

  it('under directHallucination, puts hallucination in the schema as its own criterion', () => {
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });
    const selection = selectCriteria(turn, new Set(), DIRECT);
    expect(names(selection)).toEqual(ALL_TOOL_NAMES);
    expect(selection.recordNames).toEqual(ALL_TOOL_NAMES);
    expect(sourceCriterionName('hallucination', DIRECT)).toBe('hallucination');
  });

  it('under directHallucination, drops faithfulness from the schema when only hallucination is needed', () => {
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });
    const selection = selectCriteria(turn, new Set([keyFor(turn, FAITHFULNESS_EVAL_NAME)]), DIRECT);
    expect(names(selection)).not.toContain(FAITHFULNESS_EVAL_NAME);
    expect(names(selection)).toContain('hallucination');
  });
});

// ---------------------------------------------------------------------------
// buildConsolidatedSchema
// ---------------------------------------------------------------------------

describe('buildConsolidatedSchema', () => {
  it('requires exactly the selected criteria and nothing else', () => {
    const schema = buildConsolidatedSchema([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(schema.required).toEqual([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(Object.keys(schema.properties as object)).toEqual([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(schema.additionalProperties).toBe(false);
  });

  it('asks for reasoning before an integer score limited to 1-5', () => {
    const schema = buildConsolidatedSchema([RELEVANCE_EVAL_NAME]);
    const verdict = (schema.properties as Record<string, { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }>)[RELEVANCE_EVAL_NAME]!;
    expect(Object.keys(verdict.properties)).toEqual([REASONING_KEY, SCORE_KEY]);
    expect(verdict.required).toEqual([REASONING_KEY, SCORE_KEY]);
    expect(verdict.additionalProperties).toBe(false);
    expect(verdict.properties[SCORE_KEY]).toMatchObject({ type: 'integer', enum: [1, 2, 3, 4, 5] });
  });
});

// ---------------------------------------------------------------------------
// buildConsolidatedPrompt
// ---------------------------------------------------------------------------

describe('buildConsolidatedPrompt', () => {
  const prepared = [
    { config: RELEVANCE_CRITERIA, steps: FAKE_STEPS },
    { config: COHERENCE_CRITERIA, steps: FAKE_STEPS },
  ];

  it('includes the turn content once and every criterion with its text and steps', () => {
    const prompt = buildConsolidatedPrompt(makeTurn(), [], prepared);
    expect(prompt.split(USER_TEXT).length - 1).toBe(1);
    expect(prompt.split(ASSISTANT_TEXT).length - 1).toBe(1);
    expect(prompt).toContain(`Criterion: ${RELEVANCE_EVAL_NAME}`);
    expect(prompt).toContain(`Criterion: ${COHERENCE_EVAL_NAME}`);
    expect(prompt).toContain(`Criteria: ${RELEVANCE_CRITERIA.criteria}`);
    expect(prompt).toContain(`Criteria: ${COHERENCE_CRITERIA.criteria}`);
    expect(prompt.split(FAKE_STEPS).length - 1).toBe(prepared.length);
    expect(prompt).toContain('Score anchoring:');
    expect(prompt).toContain(`${G_EVAL_MIN_SCORE}-${G_EVAL_MAX_SCORE}`);
  });

  it('says which parts each criterion applies to', () => {
    const prompt = buildConsolidatedPrompt(makeTurn(), [], prepared);
    expect(prompt).toContain('Applies to: Input, Output, Context');
    expect(prompt).toContain('Applies to: Output');
  });

  it('omits the context block when there are no tool results and includes it otherwise', () => {
    expect(buildConsolidatedPrompt(makeTurn(), [], prepared)).not.toContain('Context:');
    const withContext = buildConsolidatedPrompt(makeTurn(), [TOOL_RESULT], prepared);
    expect(withContext).toContain('Context:');
    expect(withContext).toContain(TOOL_RESULT);
  });

  it('names the exact JSON keys expected', () => {
    const prompt = buildConsolidatedPrompt(makeTurn(), [], prepared);
    expect(prompt).toContain(`keys are exactly: ${RELEVANCE_EVAL_NAME}, ${COHERENCE_EVAL_NAME}.`);
  });

  it('generates steps with the per-criterion path\'s steps prompt', () => {
    const prompt = buildStepsPrompt(RELEVANCE_CRITERIA.criteria);
    expect(prompt).toContain(`Given the criteria: ${RELEVANCE_CRITERIA.criteria}`);
    expect(prompt).toContain('Generate detailed evaluation steps');
  });
});

// ---------------------------------------------------------------------------
// parseConsolidatedResponse / validateVerdict
// ---------------------------------------------------------------------------

describe('parseConsolidatedResponse', () => {
  it('parses one verdict per criterion', () => {
    const text = JSON.stringify({
      [RELEVANCE_EVAL_NAME]: { [REASONING_KEY]: 'on topic', [SCORE_KEY]: 5 },
      [COHERENCE_EVAL_NAME]: { [REASONING_KEY]: 'flows', [SCORE_KEY]: 3 },
    });
    const parsed = parseConsolidatedResponse(text, [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(parsed.verdicts.get(RELEVANCE_EVAL_NAME)).toEqual({ reasoning: 'on topic', score: 5 });
    expect(parsed.verdicts.get(COHERENCE_EVAL_NAME)).toEqual({ reasoning: 'flows', score: 3 });
    expect(parsed.failures.size).toBe(0);
  });

  it('rejects a score out of range and keeps the other criteria', () => {
    const text = JSON.stringify({
      [RELEVANCE_EVAL_NAME]: { [REASONING_KEY]: 'x', [SCORE_KEY]: OUT_OF_RANGE_SCORE },
      [COHERENCE_EVAL_NAME]: { [REASONING_KEY]: 'y', [SCORE_KEY]: 2 },
    });
    const parsed = parseConsolidatedResponse(text, [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]);
    expect(parsed.verdicts.has(RELEVANCE_EVAL_NAME)).toBe(false);
    expect(parsed.failures.get(RELEVANCE_EVAL_NAME)?.message).toMatch(/Invalid normalized score/);
    expect(parsed.verdicts.get(COHERENCE_EVAL_NAME)?.score).toBe(2);
  });

  it.each([
    ['a fraction', 3.5],
    ['zero', 0],
    ['a string', '4'],
    ['missing', undefined],
  ])('rejects %s as a score', (_label, score) => {
    expect(() => validateVerdict(RELEVANCE_EVAL_NAME, { [REASONING_KEY]: 'r', [SCORE_KEY]: score })).toThrow();
  });

  it('records a missing criterion as a failure', () => {
    const parsed = parseConsolidatedResponse(JSON.stringify({}), [RELEVANCE_EVAL_NAME]);
    expect(parsed.failures.get(RELEVANCE_EVAL_NAME)?.message).toMatch(/Could not parse verdict/);
  });

  it('throws when the document is not a JSON object', () => {
    expect(() => parseConsolidatedResponse('[1,2]', [RELEVANCE_EVAL_NAME])).toThrow(/expected a JSON object/);
    expect(() => parseConsolidatedResponse('not json', [RELEVANCE_EVAL_NAME])).toThrow();
  });
});

describe('toNormalizedScore', () => {
  it('maps the 1-5 scale onto 0-1 exactly as G-Eval does', () => {
    expect(toNormalizedScore(G_EVAL_MIN_SCORE)).toBe(0);
    expect(toNormalizedScore(4)).toBe(0.75);
    expect(toNormalizedScore(G_EVAL_MAX_SCORE)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateTurnConsolidated — records
// ---------------------------------------------------------------------------

describe('evaluateTurnConsolidated', () => {
  beforeEach(() => {
    resetFailureTracking();
  });

  it('produces the per-criterion path\'s records from one structured call', async () => {
    const calls: RecordedCall[] = [];
    const provider = createFakeProvider({ [FAITHFULNESS_EVAL_NAME]: 5 }, calls);
    const turn = makeTurn({ toolResults: [TOOL_RESULT] });

    const records = await evaluateTurnConsolidated(provider, turn, new Set());

    expect(records.map(r => r.evaluationName)).toEqual(ALL_TOOL_NAMES);
    const schemaCalls = calls.filter(c => c.options?.schema);
    expect(schemaCalls).toHaveLength(1);
    expect((schemaCalls[0]!.options!.schema as { required: string[] }).required).toEqual(ALL_TOOL_CRITERIA);
    expect(schemaCalls[0]!.prompt.split(TOOL_RESULT).length - 1).toBe(1);
    for (const record of records) {
      // Its own producer, distinct from the per-criterion path's: the two measure
      // faithfulness and hallucination with different instruments, and this is the
      // only field that says which one a stored record came from.
      expect(record.evaluator).toBe(CONSOLIDATED_PRODUCER);
      expect(record.evaluator).not.toBe(PRODUCER);
      expect(record.evaluatorType).toBe('llm');
      expect(record.evaluatorKind).toBe('llm');
      expect(record.cohort).toBe('normal');
      expect(record.judgeModel).toBe(HAIKU_MODEL);
      expect(record.traceId).toBe(turn.traceId);
      expect(record.sessionId).toBe(turn.sessionId);
      expect(record.timestamp).toBe(turn.timestamp);
    }
  });

  it('normalizes scores like G-Eval and derives hallucination as 1 - faithfulness', async () => {
    const provider = createFakeProvider({ [RELEVANCE_EVAL_NAME]: 4, [FAITHFULNESS_EVAL_NAME]: 2 });
    const records = await evaluateTurnConsolidated(provider, makeTurn({ toolResults: [TOOL_RESULT] }), new Set());
    const byName = Object.fromEntries(records.map(r => [r.evaluationName, r]));

    expect(byName[RELEVANCE_EVAL_NAME]!.scoreValue).toBe(0.75);
    expect(byName[RELEVANCE_EVAL_NAME]!.explanation).toBe(`${RELEVANCE_EVAL_NAME} reasoning`);
    expect(byName[FAITHFULNESS_EVAL_NAME]!.scoreValue).toBe(0.25);
    expect(byName['hallucination']!.scoreValue).toBe(0.75);
    expect(byName['hallucination']!.explanation).toBe(`${FAITHFULNESS_EVAL_NAME} reasoning`);
  });

  it('under directHallucination, scores hallucination from its own verdict, so the two no longer sum to 1', async () => {
    const calls: RecordedCall[] = [];
    const provider = createFakeProvider({ [FAITHFULNESS_EVAL_NAME]: 2, hallucination: 5 }, calls);
    const records = await evaluateTurnConsolidated(provider, makeTurn({ toolResults: [TOOL_RESULT] }), new Set(), new Map(), DIRECT);
    const byName = Object.fromEntries(records.map(r => [r.evaluationName, r]));

    const schemaCalls = calls.filter(c => c.options?.schema);
    expect(schemaCalls).toHaveLength(1);
    expect((schemaCalls[0]!.options!.schema as { required: string[] }).required).toContain('hallucination');
    expect(byName[FAITHFULNESS_EVAL_NAME]!.scoreValue).toBe(0.25);
    // 5 = no fabrication on HALLUCINATION_CRITERIA, stored higher-is-worse.
    expect(byName['hallucination']!.scoreValue).toBe(0);
    expect(byName['hallucination']!.explanation).toBe('hallucination reasoning');
    expect(byName[FAITHFULNESS_EVAL_NAME]!.scoreValue + byName['hallucination']!.scoreValue).not.toBe(1);
  });

  it('skips criteria already covered by existingKeys and emits nothing when all are', async () => {
    const turn = makeTurn();
    const provider = createFakeProvider();
    const partial = await evaluateTurnConsolidated(provider, turn, new Set([keyFor(turn, RELEVANCE_EVAL_NAME)]));
    expect(partial.map(r => r.evaluationName)).toEqual([COHERENCE_EVAL_NAME]);

    const calls: RecordedCall[] = [];
    const none = await evaluateTurnConsolidated(
      createFakeProvider({}, calls),
      turn,
      new Set([keyFor(turn, RELEVANCE_EVAL_NAME), keyFor(turn, COHERENCE_EVAL_NAME)]),
    );
    expect(none).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('rejects a score out of range for that metric only and tracks the failure', async () => {
    const provider = createFakeProvider({ [RELEVANCE_EVAL_NAME]: OUT_OF_RANGE_SCORE });
    const records = await evaluateTurnConsolidated(provider, makeTurn(), new Set());

    expect(records.map(r => r.evaluationName)).toEqual([COHERENCE_EVAL_NAME]);
    expect(evalFailures[RELEVANCE_EVAL_NAME]).toBe(1);
    expect(evalFailures[COHERENCE_EVAL_NAME]).toBeUndefined();
    expect(failureClasses.parse).toBe(1);
  });

  it('fails every selected metric when the response is not JSON', async () => {
    const provider = createFakeProvider({}, [], 'Sure! Here is my evaluation.');
    const records = await evaluateTurnConsolidated(provider, makeTurn(), new Set());

    expect(records).toEqual([]);
    expect(evalFailures[RELEVANCE_EVAL_NAME]).toBe(1);
    expect(evalFailures[COHERENCE_EVAL_NAME]).toBe(1);
  });

  it('generates evaluation steps once per criterion across turns', async () => {
    const calls: RecordedCall[] = [];
    const provider = createFakeProvider({}, calls);
    const cache: EvaluationStepsCache = new Map();

    await evaluateTurnConsolidated(provider, makeTurn(), new Set(), cache);
    await evaluateTurnConsolidated(provider, makeTurn({ timestamp: '2026-02-09T02:00:00.000Z' }), new Set(), cache);

    const stepsCalls = calls.filter(c => !c.options?.schema);
    expect(stepsCalls).toHaveLength(2);
    expect(calls.filter(c => c.options?.schema)).toHaveLength(2);
  });

  it('retries steps generation after a failure instead of caching it', async () => {
    let failOnce = true;
    const provider: ConsolidatedProvider = {
      generate(_prompt, _options) {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('Connection error.'));
        }
        return Promise.resolve({ text: FAKE_STEPS });
      },
    };
    const cache: EvaluationStepsCache = new Map();
    await expect(cachedEvaluationSteps(provider, RELEVANCE_CRITERIA, cache)).rejects.toThrow('Connection error.');
    expect(cache.has(RELEVANCE_CRITERIA.name)).toBe(false);
    await expect(cachedEvaluationSteps(provider, RELEVANCE_CRITERIA, cache)).resolves.toContain('1. ');
  });
});
