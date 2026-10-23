import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectCriteria,
  buildConsolidatedSchema,
  buildConsolidatedPrompt,
  buildStepsPrompt,
  parseConsolidatedResponse,
  validateVerdict,
  toFivePointScale,
  toNormalizedScore,
  evaluateTurnConsolidated,
  cachedEvaluationSteps,
  CONSOLIDATED_PRODUCER,
  REASONING_KEY,
  SCORE_KEY,
  type ConsolidatedProvider,
  type ConsolidatedGenerateOptions,
  type EvaluationStepsCache,
} from '../judge-consolidated.js';
import { evalFailures, failureClasses, resetFailureTracking } from '../judge-failures.js';
import {
  RELEVANCE_EVAL_NAME,
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  TOOL_CORRECTNESS_CRITERIA,
  TOOL_SELECTION_CRITERIA,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
  HAIKU_MODEL,
} from '../judge-criteria.js';
import { PRODUCER } from '../eval-record.js';
import { type Turn } from '../judge-turns.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { RELEVANCE_CRITERIA, COHERENCE_CRITERIA } from '../../../src/lib/judge/llm-judge-config.js';
import { G_EVAL_MAX_SCORE, G_EVAL_MIN_SCORE } from '../../../src/lib/judge/llm-judge-constants.js';
import { judgedKeys, makeTurn as makeBaseTurn, TOOL_TURN_RECORDS } from './support/fixtures.js';
import { defined } from '../../src/__tests__/support/defined.js';

const USER_TEXT = 'Fix the login bug in auth.ts';
const ASSISTANT_TEXT = 'I found the null check missing in auth.ts and fixed it.';
const TOOL_RESULT = 'export function login() { /* … */ }';
const FAKE_STEPS = '1. Read the input\n2. Compare with the output\n3. Check every claim';
const DEFAULT_RAW_SCORE = 4;
const DEFAULT_SCORE_NORMALIZED = 0.75;
const LOW_SCORE = 2;
const LOW_SCORE_NORMALIZED = 0.25;
const FRACTIONAL_SCORE = 3.5;
const FIVE_POINT_SCALE = [1, 2, 3, 4, 5];
const OUT_OF_RANGE_SCORE = G_EVAL_MAX_SCORE + 1;
const OTHER_JUDGE_MODEL = 'claude-opus-5';

/** A tool turn's criteria and records on the default consolidated path: every per-criterion record but hallucination. */
const TOOL_TURN_CRITERIA = TOOL_TURN_RECORDS.filter(n => n !== HALLUCINATION_EVAL_NAME);
const PLAIN_CRITERIA = [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME];
const DIRECT = { directHallucination: true } as const;

const makeTurn = (overrides: Partial<Turn> = {}): Turn =>
  makeBaseTurn({ userText: USER_TEXT, assistantText: ASSISTANT_TEXT, ...overrides });
const toolTurn = (): Turn => makeTurn({ toolResults: [TOOL_RESULT] });

type RecordedCall = {
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
      const body = Object.fromEntries(requiredOf(options).map(name => [
        name,
        { [REASONING_KEY]: `${name} reasoning`, [SCORE_KEY]: scores[name] ?? DEFAULT_RAW_SCORE },
      ]));
      return Promise.resolve({ text: JSON.stringify(body) });
    },
  };
}

function requiredOf(options: ConsolidatedGenerateOptions | undefined): string[] {
  return (defined(options).schema as { required: string[] }).required;
}

/** The required keys of each structured (schema) call, in call order. */
function schemaCallKeys(calls: RecordedCall[]): string[][] {
  return calls.filter(c => c.options?.schema).map(c => requiredOf(c.options));
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function names(selection: { criteria: Array<{ name: string }> }): string[] {
  return selection.criteria.map(c => c.name);
}

describe('selectCriteria', () => {
  it('selects relevance and coherence for a turn without tool results', () => {
    const selection = selectCriteria(makeTurn(), new Set());
    expect(names(selection)).toEqual(PLAIN_CRITERIA);
    expect(selection.recordNames).toEqual(PLAIN_CRITERIA);
  });

  it('selects every criterion but hallucination for a turn with tool results', () => {
    const selection = selectCriteria(toolTurn(), new Set());
    expect(names(selection)).toEqual(TOOL_TURN_CRITERIA);
    expect(selection.recordNames).toEqual(TOOL_TURN_CRITERIA);
  });

  it('drops a criterion whose dedup key already exists', () => {
    const turn = makeTurn();
    const selection = selectCriteria(turn, judgedKeys(turn, [RELEVANCE_EVAL_NAME]));
    expect(names(selection)).toEqual([COHERENCE_EVAL_NAME]);
    expect(selection.recordNames).toEqual([COHERENCE_EVAL_NAME]);
  });

  it('does not skip a criterion another model judged, since the dedup key is per judge model', () => {
    const turn = makeTurn();
    const otherModel = judgedKeys(turn, [RELEVANCE_EVAL_NAME], OTHER_JUDGE_MODEL);

    expect(selectCriteria(turn, otherModel).recordNames).toContain(RELEVANCE_EVAL_NAME);
    expect(selectCriteria(turn, otherModel, { judgeModel: OTHER_JUDGE_MODEL }).recordNames).not.toContain(RELEVANCE_EVAL_NAME);
  });

  it('treats a tool turn as judged when only hallucination is missing, so it is not re-selected every run', () => {
    const turn = toolTurn();
    const selection = selectCriteria(turn, judgedKeys(turn, TOOL_TURN_CRITERIA));
    expect(selection.criteria).toEqual([]);
    expect(selection.recordNames).toEqual([]);
  });

  it('skips the tool sub-criteria when tool_correctness already exists, as evaluateTurn does', () => {
    const turn = toolTurn();
    const subCriteria = [TOOL_SELECTION_CRITERIA.name, TOOL_ARGUMENTS_CRITERIA.name, TOOL_INTEGRATION_CRITERIA.name];
    const selection = selectCriteria(turn, judgedKeys(turn, [TOOL_CORRECTNESS_CRITERIA.name]));
    expect(names(selection).filter(n => subCriteria.includes(n))).toEqual([]);
  });

  it('selects nothing when every key exists', () => {
    const turn = toolTurn();
    const selection = selectCriteria(turn, judgedKeys(turn, TOOL_TURN_RECORDS));
    expect(selection.criteria).toEqual([]);
    expect(selection.recordNames).toEqual([]);
  });

  it('under directHallucination, puts hallucination in the schema as its own criterion', () => {
    const selection = selectCriteria(toolTurn(), new Set(), DIRECT);
    expect(names(selection)).toEqual(TOOL_TURN_RECORDS);
    expect(selection.recordNames).toEqual(TOOL_TURN_RECORDS);
  });

  it('under directHallucination, drops faithfulness from the schema when only hallucination is needed', () => {
    const turn = toolTurn();
    const selection = selectCriteria(turn, judgedKeys(turn, [FAITHFULNESS_EVAL_NAME]), DIRECT);
    expect(names(selection)).not.toContain(FAITHFULNESS_EVAL_NAME);
    expect(names(selection)).toContain(HALLUCINATION_EVAL_NAME);
  });
});

describe('buildConsolidatedSchema', () => {
  it('requires exactly the selected criteria and nothing else', () => {
    const schema = buildConsolidatedSchema(PLAIN_CRITERIA);
    expect(schema.required).toEqual(PLAIN_CRITERIA);
    expect(Object.keys(schema.properties as object)).toEqual(PLAIN_CRITERIA);
    expect(schema.additionalProperties).toBe(false);
  });

  it('asks for reasoning before an integer score limited to 1-5', () => {
    const schema = buildConsolidatedSchema([RELEVANCE_EVAL_NAME]);
    const verdict = defined((schema.properties as Record<string, { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }>)[RELEVANCE_EVAL_NAME]);
    expect(Object.keys(verdict.properties)).toEqual([REASONING_KEY, SCORE_KEY]);
    expect(verdict.required).toEqual([REASONING_KEY, SCORE_KEY]);
    expect(verdict.additionalProperties).toBe(false);
    expect(verdict.properties[SCORE_KEY]).toMatchObject({ type: 'integer', enum: FIVE_POINT_SCALE });
  });
});

describe('buildConsolidatedPrompt', () => {
  const prepared = [
    { config: RELEVANCE_CRITERIA, steps: FAKE_STEPS },
    { config: COHERENCE_CRITERIA, steps: FAKE_STEPS },
  ];

  it('includes the turn content once and every criterion with its text and steps', () => {
    const prompt = buildConsolidatedPrompt(makeTurn(), [], prepared);
    expect(occurrences(prompt, USER_TEXT)).toBe(1);
    expect(occurrences(prompt, ASSISTANT_TEXT)).toBe(1);
    expect(prompt).toContain(`Criterion: ${RELEVANCE_EVAL_NAME}`);
    expect(prompt).toContain(`Criterion: ${COHERENCE_EVAL_NAME}`);
    expect(prompt).toContain(`Criteria: ${RELEVANCE_CRITERIA.criteria}`);
    expect(prompt).toContain(`Criteria: ${COHERENCE_CRITERIA.criteria}`);
    expect(occurrences(prompt, FAKE_STEPS)).toBe(prepared.length);
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

describe('parseConsolidatedResponse', () => {
  it('parses one verdict per criterion', () => {
    const text = JSON.stringify({
      [RELEVANCE_EVAL_NAME]: { [REASONING_KEY]: 'on topic', [SCORE_KEY]: 5 },
      [COHERENCE_EVAL_NAME]: { [REASONING_KEY]: 'flows', [SCORE_KEY]: 3 },
    });
    const parsed = parseConsolidatedResponse(text, PLAIN_CRITERIA);
    expect(parsed.verdicts.get(RELEVANCE_EVAL_NAME)).toEqual({ reasoning: 'on topic', score: 5 });
    expect(parsed.verdicts.get(COHERENCE_EVAL_NAME)).toEqual({ reasoning: 'flows', score: 3 });
    expect(parsed.failures.size).toBe(0);
  });

  it('rejects a score out of range and keeps the other criteria', () => {
    const text = JSON.stringify({
      [RELEVANCE_EVAL_NAME]: { [REASONING_KEY]: 'x', [SCORE_KEY]: OUT_OF_RANGE_SCORE },
      [COHERENCE_EVAL_NAME]: { [REASONING_KEY]: 'y', [SCORE_KEY]: 2 },
    });
    const parsed = parseConsolidatedResponse(text, PLAIN_CRITERIA);
    expect(parsed.verdicts.has(RELEVANCE_EVAL_NAME)).toBe(false);
    expect(parsed.failures.get(RELEVANCE_EVAL_NAME)?.message).toMatch(/Invalid normalized score/);
    expect(parsed.verdicts.get(COHERENCE_EVAL_NAME)?.score).toBe(2);
  });

  it.each([
    ['a fraction', FRACTIONAL_SCORE],
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
    expect(toNormalizedScore(DEFAULT_RAW_SCORE)).toBe(DEFAULT_SCORE_NORMALIZED);
    expect(toNormalizedScore(G_EVAL_MAX_SCORE)).toBe(1);
  });

  it.each(FIVE_POINT_SCALE)('is inverted by toFivePointScale at %i', (score) => {
    expect(toFivePointScale(toNormalizedScore(score))).toBe(score);
  });
});

describe('evaluateTurnConsolidated', () => {
  beforeEach(() => {
    resetFailureTracking();
  });

  it('produces the per-criterion path\'s records from one structured call', async () => {
    const calls: RecordedCall[] = [];
    const turn = toolTurn();

    const records = await evaluateTurnConsolidated(createFakeProvider({}, calls), turn, new Set());

    expect(schemaCallKeys(calls)).toEqual([TOOL_TURN_CRITERIA]);
    expect(occurrences(defined(calls.find(c => c.options?.schema)).prompt, TOOL_RESULT)).toBe(1);
    // Its own producer, distinct from the per-criterion path's: the two measure
    // faithfulness and hallucination with different instruments, and this is the
    // only field that says which one a stored record came from.
    expect(CONSOLIDATED_PRODUCER).not.toBe(PRODUCER);
    expect(records).toMatchObject(TOOL_TURN_CRITERIA.map(evaluationName => ({
      evaluationName,
      evaluator: CONSOLIDATED_PRODUCER,
      // The mirrored legacy field must keep matching evaluatorKind.
      evaluatorType: 'llm',
      evaluatorKind: 'llm',
      cohort: 'normal',
      judgeModel: HAIKU_MODEL,
      traceId: turn.traceId,
      sessionId: turn.sessionId,
      timestamp: turn.timestamp,
    })));
  });

  it('normalizes scores like G-Eval and writes no hallucination record', async () => {
    const provider = createFakeProvider({ [RELEVANCE_EVAL_NAME]: DEFAULT_RAW_SCORE, [FAITHFULNESS_EVAL_NAME]: LOW_SCORE });
    const records = await evaluateTurnConsolidated(provider, toolTurn(), new Set());
    const byName = Object.fromEntries(records.map(r => [r.evaluationName, r]));

    expect(byName[RELEVANCE_EVAL_NAME]).toMatchObject({ scoreValue: DEFAULT_SCORE_NORMALIZED, explanation: `${RELEVANCE_EVAL_NAME} reasoning` });
    expect(byName[FAITHFULNESS_EVAL_NAME]).toMatchObject({ scoreValue: LOW_SCORE_NORMALIZED });
    expect(byName[HALLUCINATION_EVAL_NAME]).toBeUndefined();
  });

  it('under directHallucination, scores hallucination from its own verdict, so the two no longer sum to 1', async () => {
    const calls: RecordedCall[] = [];
    const provider = createFakeProvider({ [FAITHFULNESS_EVAL_NAME]: LOW_SCORE, [HALLUCINATION_EVAL_NAME]: G_EVAL_MAX_SCORE }, calls);
    const records = await evaluateTurnConsolidated(provider, toolTurn(), new Set(), { criteria: DIRECT });
    const byName = Object.fromEntries(records.map(r => [r.evaluationName, r]));

    expect(schemaCallKeys(calls)).toEqual([TOOL_TURN_RECORDS]);
    expect(byName[FAITHFULNESS_EVAL_NAME]).toMatchObject({ scoreValue: LOW_SCORE_NORMALIZED });
    // 5 = no fabrication on HALLUCINATION_CRITERIA, stored higher-is-worse.
    expect(byName[HALLUCINATION_EVAL_NAME]).toMatchObject({ scoreValue: 0, explanation: `${HALLUCINATION_EVAL_NAME} reasoning` });
  });

  it('skips criteria already covered by existingKeys and emits nothing when all are', async () => {
    const turn = makeTurn();
    const partial = await evaluateTurnConsolidated(createFakeProvider(), turn, judgedKeys(turn, [RELEVANCE_EVAL_NAME]));
    expect(partial.map(r => r.evaluationName)).toEqual([COHERENCE_EVAL_NAME]);

    const calls: RecordedCall[] = [];
    const none = await evaluateTurnConsolidated(createFakeProvider({}, calls), turn, judgedKeys(turn, PLAIN_CRITERIA));
    expect(none).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('rejects a score out of range for that metric only and tracks the failure', async () => {
    const provider = createFakeProvider({ [RELEVANCE_EVAL_NAME]: OUT_OF_RANGE_SCORE });
    const records = await evaluateTurnConsolidated(provider, makeTurn(), new Set());

    expect(records.map(r => r.evaluationName)).toEqual([COHERENCE_EVAL_NAME]);
    expect(evalFailures).toEqual({ [RELEVANCE_EVAL_NAME]: 1 });
    expect(failureClasses.parse).toBe(1);
  });

  it('fails every selected metric when the response is not JSON', async () => {
    const provider = createFakeProvider({}, [], 'Sure! Here is my evaluation.');
    const records = await evaluateTurnConsolidated(provider, makeTurn(), new Set());

    expect(records).toEqual([]);
    expect(evalFailures).toEqual({ [RELEVANCE_EVAL_NAME]: 1, [COHERENCE_EVAL_NAME]: 1 });
  });

  it('generates evaluation steps once per criterion across turns', async () => {
    const calls: RecordedCall[] = [];
    const provider = createFakeProvider({}, calls);
    const cache: EvaluationStepsCache = new Map();

    await evaluateTurnConsolidated(provider, makeTurn(), new Set(), { stepsCache: cache });
    await evaluateTurnConsolidated(provider, makeTurn({ timestamp: '2026-02-09T02:00:00.000Z' }), new Set(), { stepsCache: cache });

    expect(calls.filter(c => !c.options?.schema)).toHaveLength(PLAIN_CRITERIA.length);
    expect(schemaCallKeys(calls)).toHaveLength(2);
  });

  it('retries steps generation after a failure instead of caching it', async () => {
    let failOnce = true;
    const provider: ConsolidatedProvider = {
      generate() {
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
