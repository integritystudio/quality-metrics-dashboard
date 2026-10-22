import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  isSystemPrompt,
  isToolResultOnly,
  extractTextFromContent,
  extractToolResults,
  extractTurns,
  fitContextForJudge,
  CONTEXT_TRUNCATION_MARKER,
  MAX_TOOL_CONTEXT_ITEMS,
  MAX_TURN_TEXT_LEN,
  transcriptPathOf,
  type Turn,
} from '../judge-turns.js';
import {
  hashToScore,
  seedEvaluations,
  evaluateTurn,
  evaluateTurnsBatched,
  processBatch,
  anthropicProviderFor,
  rejectRemovedFlags,
  acquireLock,
  type JudgeMessagesClient,
} from '../judge-evaluations.js';
import { CliArgError } from '../cli-args.js';
import {
  normalizeScore,
  toOTelRecord,
  EVALUATION_ATTRS,
  EVAL_SCORE_PRECISION,
  LEGACY_EVALUATOR_TYPE_ATTR,
  LEGACY_SCORE_UNIT_ATTR,
  PRODUCER,
  type EvalRecord,
} from '../eval-record.js';
import {
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  HAIKU_MODEL,
  JUDGE_MAX_TOKENS,
  RELEVANCE_EVAL_NAME,
  TOOL_CORRECTNESS_CRITERIA,
} from '../judge-criteria.js';
import {
  evalFailures,
  classifyJudgeFailure,
  summarizeJudgeRun,
  resetFailureTracking,
  readRunState,
  writeRunState,
  type JudgeSpend,
  type JudgeFailureClass,
} from '../judge-failures.js';
import {
  addUsage,
  createUsageTotals,
  judgePricing,
  estimateJudgeRun,
  EST_OUTPUT_TOKENS_PER_EVAL,
  BATCH_PRICE_RATIO,
  type JudgeTokenUsage,
} from '../judge-usage.js';
import { LLMJudge } from '../../../src/lib/judge/llm-judge-config.js';
import type { LLMProvider } from '../../../src/lib/judge/llm-as-judge.js';
import type { BatchLLMProvider } from '../judge-batch-provider.js';
import { MAX_TEXT_LENGTH } from '../../../src/lib/judge/llm-judge-constants.js';
import { JUDGE_EXIT_BILLING, JUDGE_EXIT_NO_SCORES, JUDGE_EXIT_HIGH_FAILURE_RATE, JUDGE_EXIT_BATCH_WALL_CLOCK, JUDGE_SOFT_FAILURE_EXITS } from '../pipeline-stages.js';
import { JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV } from '../judge-credentials.js';
import { TOKENS_PER_MILLION } from '../../../src/lib/core/constants-models.js';
import { TIME_MS } from '../../../src/lib/core/units.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';
import { defined } from '../../src/__tests__/support/defined.js';
import { TRANSCRIPT_ATTRIBUTES } from '../../src/lib/hook-attributes.js';
import { judgedKeys, makeToolTurn, makeTurn, scoredKeys, SEED_RECORDS, TOOL_TURN_RECORDS, turnSeries } from './support/fixtures.js';
import { useTempDir } from './support/temp-dir.js';
import { transcriptMessage, writeJsonl } from './support/transcripts.js';

const DEFAULT_SCORE = 0.85;
const PLAIN_CRITERIA = [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME];
const OTHER_JUDGE_MODEL = 'claude-opus-5';

function makeEvalRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    timestamp: '2026-02-09T01:11:15.525Z',
    evaluationName: RELEVANCE_EVAL_NAME,
    scoreValue: DEFAULT_SCORE,
    explanation: 'Test explanation',
    evaluator: PRODUCER,
    evaluatorType: 'llm',
    evaluatorKind: 'llm',
    cohort: 'normal',
    judgeModel: 'claude-haiku-4-5-20251001',
    traceId: 'trace-001',
    sessionId: 'abc12345-session',
    ...overrides,
  };
}

// Transcript content

const SYSTEM_PROMPTS: Array<[string, unknown, boolean]> = [
  ['a system-reminder tag', '<system-reminder>some content</system-reminder>', true],
  ['a system-reminder after leading whitespace', '  <system-reminder>content', true],
  ['stop hook feedback', 'Stop hook feedback: some message', true],
  ['regular user text', 'Fix the login bug', false],
  ['an empty string', '', false],
  ['a non-string', 42, false],
];

const TOOL_RESULT_ONLY: Array<[string, unknown, boolean]> = [
  ['one tool_result block', [{ type: 'tool_result', content: 'result' }], true],
  ['several tool_result blocks', [{ type: 'tool_result', content: 'a' }, { type: 'tool_result', content: 'b' }], true],
  ['tool results beside text', [{ type: 'text', text: 'hello' }, { type: 'tool_result', content: 'result' }], false],
  ['an empty array', [], false],
  ['a string', 'string', false],
  ['null', null, false],
];

const CONTENT_TEXT: Array<[string, unknown, string]> = [
  ['a string', 'hello world', 'hello world'],
  ['text blocks, one per line', [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }], 'First part.\nSecond part.'],
  ['only the text blocks', [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: '123', name: 'Read' }, { type: 'tool_result', content: 'file contents' }], 'Hello'],
  ['nothing from a text block without text', [{ type: 'text' }], ''],
  ['nothing from null', null, ''],
  ['nothing from a number', 42, ''],
  ['nothing from undefined', undefined, ''],
];

const CONTENT_TOOL_RESULTS: Array<[string, unknown, string[]]> = [
  ['string content', [{ type: 'tool_result', content: 'File contents here' }], ['File contents here']],
  ['nested text blocks, one per line', [{ type: 'tool_result', content: [{ type: 'text', text: 'Line 1' }, { type: 'text', text: 'Line 2' }] }], ['Line 1\nLine 2']],
  ['only the tool_result blocks', [{ type: 'text', text: 'Not a tool result' }, { type: 'tool_result', content: 'Actual result' }], ['Actual result']],
  ['only the non-empty results', [{ type: 'tool_result', content: '' }, { type: 'tool_result', content: 'valid' }], ['valid']],
  ['nothing from null', null, []],
  ['nothing from a string', 'string', []],
];

describe('transcript content', () => {
  it.each(SYSTEM_PROMPTS)('isSystemPrompt: %s → %s', (_case, text, expected) => {
    expect(isSystemPrompt(text as string)).toBe(expected);
  });

  it.each(TOOL_RESULT_ONLY)('isToolResultOnly: %s → %s', (_case, content, expected) => {
    expect(isToolResultOnly(content)).toBe(expected);
  });

  it.each(CONTENT_TEXT)('extractTextFromContent reads %s', (_case, content, expected) => {
    expect(extractTextFromContent(content)).toBe(expected);
  });

  it.each(CONTENT_TOOL_RESULTS)('extractToolResults reads %s', (_case, content, expected) => {
    expect(extractToolResults(content)).toEqual(expected);
  });
});

describe('extractTurns', () => {
  const dir = useTempDir('judge-turns-');
  const SESSION = 'sess-1';
  const TRACE = 'trace-1';
  const START_MS = Date.parse('2026-02-09T01:00:00Z');

  const user = (content: string | object[]): object =>
    transcriptMessage('user', typeof content === 'string' ? [{ type: 'text', text: content }] : content);
  const assistant = (text: string): object => transcriptMessage('assistant', [{ type: 'text', text }]);
  const toolResult = (content: string): object => user([{ type: 'tool_result', content }]);

  /** The turns of a transcript holding `entries`, a second apart, in one session. */
  async function extract(...entries: object[]): Promise<Turn[]> {
    const stamped = entries.map((entry, i) => ({ sessionId: SESSION, timestamp: new Date(START_MS + i * TIME_MS.SECOND).toISOString(), ...entry }));
    return extractTurns({ path: writeJsonl(join(dir(), 'session.jsonl'), stamped), sessionId: SESSION, traceId: TRACE });
  }

  it('pairs a user prompt with the assistant reply', async () => {
    expect(await extract(user('Fix the bug'), assistant('I fixed it in auth.ts'))).toEqual([expect.objectContaining({
      sessionId: SESSION,
      // Anchoring assigns each turn its own trace later; extraction leaves it empty.
      traceId: '',
      userText: 'Fix the bug',
      assistantText: 'I fixed it in auth.ts',
      toolResults: [],
    })]);
  });

  it('skips a system prompt', async () => {
    expect(await extract(user('<system-reminder>hook info</system-reminder>'), assistant('Response'))).toEqual([]);
  });

  it('skips a user message holding only tool results', async () => {
    expect(await extract(toolResult('result data'), assistant('Response'))).toEqual([]);
  });

  it('gives a turn the tool results that preceded it, and none to the next turn', async () => {
    const turns = await extract(
      toolResult('tool output from turn 1'),
      user('First question'),
      assistant('First answer'),
      user('Second question'),
      assistant('Second answer'),
    );

    expect(turns.map(t => t.toolResults)).toEqual([['tool output from turn 1'], []]);
  });

  it('skips progress and file-history-snapshot entries', async () => {
    const turns = await extract({ type: 'progress', message: null }, { type: 'file-history-snapshot', files: {} }, user('Hello'), assistant('Hi'));

    expect(turns.map(t => t.userText)).toEqual(['Hello']);
  });

  it('truncates each side of a turn to MAX_TURN_TEXT_LEN', async () => {
    const longText = 'x'.repeat(MAX_TURN_TEXT_LEN + 1);

    const [turn] = await extract(user(longText), assistant(longText));

    expect(defined(turn).userText).toHaveLength(MAX_TURN_TEXT_LEN);
    expect(defined(turn).assistantText).toHaveLength(MAX_TURN_TEXT_LEN);
  });

  it('skips a malformed line and reads the rest', async () => {
    const path = join(dir(), 'bad.jsonl');
    const lines = [user('Hello'), assistant('Hi')].map(entry => JSON.stringify({ sessionId: SESSION, timestamp: new Date(START_MS).toISOString(), ...entry }));
    writeFileSync(path, ['not json', ...lines].join('\n'));

    expect((await extractTurns({ path, sessionId: SESSION, traceId: TRACE })).map(t => t.userText)).toEqual(['Hello']);
  });
});

// transcriptPathOf — `transcript.path` moved under `integritystudio.` (hooks 2026-09-29)
//
// Discovery reads raw logs-*.jsonl, which no alias table rewrites, so both
// spellings reach it. Reading only the old key would drop every post-rename
// session to the slower directory scan.

describe('transcriptPathOf', () => {
  const NEW_PATH = '/home/u/.claude/projects/slug/new-session.jsonl';
  const OLD_PATH = '/home/u/.claude/projects/slug/old-session.jsonl';

  it.each([
    ['only the canonical key', { [TRANSCRIPT_ATTRIBUTES.PATH]: NEW_PATH }, NEW_PATH],
    ['only the legacy key', { 'transcript.path': OLD_PATH }, OLD_PATH],
    ['both keys', { [TRANSCRIPT_ATTRIBUTES.PATH]: NEW_PATH, 'transcript.path': OLD_PATH }, NEW_PATH],
  ])('reads the path from a record with %s', (_shape, attrs, expected) => {
    expect(transcriptPathOf(attrs)).toBe(expected);
  });

  it('skips a non-string canonical value for the legacy one', () => {
    expect(transcriptPathOf({ [TRANSCRIPT_ATTRIBUTES.PATH]: 42, 'transcript.path': OLD_PATH })).toBe(OLD_PATH);
  });

  it('is undefined when neither key holds a string', () => {
    expect(transcriptPathOf({ 'transcript.path': null })).toBeUndefined();
  });
});

// Scores

const NORMALIZED_SCORES = [
  ['rounds to 4 decimal places', 0.123456789, 0.1235],
  ['keeps a value already at that precision', 0.85, 0.85],
  ['keeps 0', 0, 0],
  ['keeps 1', 1, 1],
] as const;

describe('normalizeScore', () => {
  it.each(NORMALIZED_SCORES)('%s', (_case, raw, normalized) => {
    expect(normalizeScore(raw)).toBe(normalized);
  });
});

describe('hashToScore', () => {
  const UPPER_HALF = { min: 0.5, max: 1.0 };
  const NARROW_RANGE = { min: 0.3, max: 0.9 };
  const SAMPLE_COUNT = 100;

  it('returns the same score for the same input', () => {
    expect(hashToScore('test:abc', UPPER_HALF.min, UPPER_HALF.max)).toBe(hashToScore('test:abc', UPPER_HALF.min, UPPER_HALF.max));
  });

  it('returns different scores for different inputs', () => {
    expect(hashToScore('test:abc', UPPER_HALF.min, UPPER_HALF.max)).not.toBe(hashToScore('test:def', UPPER_HALF.min, UPPER_HALF.max));
  });

  it('stays within the range it is given', () => {
    const scores = Array.from({ length: SAMPLE_COUNT }, (_, i) => hashToScore(`input-${i}`, NARROW_RANGE.min, NARROW_RANGE.max));

    expect(scores.filter(score => !(score >= NARROW_RANGE.min && score <= NARROW_RANGE.max))).toEqual([]);
  });

  it('returns at most 4 decimal places', () => {
    const decimals = hashToScore('test', 0, 1).toString().split('.')[1]?.length ?? 0;

    expect(decimals).toBeLessThanOrEqual(EVAL_SCORE_PRECISION);
  });
});

describe('seedEvaluations', () => {
  /** Enough turns to hit the ~2% canary rate several times. */
  const SAMPLE_TURNS = 200;
  const sample = seedEvaluations(turnSeries(SAMPLE_TURNS, { toolResults: ['ctx'] }), new Set()).evals;
  const scoresOf = (cohort: string, name: string): number[] =>
    sample.filter(ev => ev.cohort === cohort && ev.evaluationName === name).map(ev => ev.scoreValue);
  const namesOf = (turn: Turn, existingKeys = new Set<string>()): string[] =>
    seedEvaluations([turn], existingKeys).evals.map(e => e.evaluationName);

  it('seeds relevance, coherence, faithfulness and hallucination for a turn without tool results', () => {
    expect(namesOf(makeTurn())).toEqual(SEED_RECORDS);
  });

  it('adds tool_correctness for a turn with tool results', () => {
    expect(namesOf(makeToolTurn())).toEqual([...SEED_RECORDS, TOOL_CORRECTNESS_CRITERIA.name]);
  });

  it('seeds only the metrics no stored score already covers', () => {
    const turn = makeTurn();

    expect(namesOf(turn, scoredKeys(turn, [HALLUCINATION_EVAL_NAME]))).toEqual([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME]);
    expect(namesOf(turn, scoredKeys(turn, SEED_RECORDS))).toEqual([]);
  });

  it('scores faithfulness and hallucination as complements', () => {
    const { evals } = seedEvaluations([makeTurn()], new Set());
    const score = (name: string): number => defined(evals.find(e => e.evaluationName === name)).scoreValue;

    expect(score(FAITHFULNESS_EVAL_NAME) + score(HALLUCINATION_EVAL_NAME)).toBeCloseTo(1, EVAL_SCORE_PRECISION);
  });

  it('gives the same records for the same turn on every run', () => {
    const turn = makeToolTurn();

    expect(seedEvaluations([turn], new Set())).toEqual(seedEvaluations([turn], new Set()));
  });

  // OBP16: both cohorts hash, so neither may claim an LLM produced the score;
  // the cohort is what tells them apart.
  it('marks every record seed or canary, rule-scored, with no judge model', () => {
    expect(new Set(sample.map(ev => ev.cohort))).toEqual(new Set(['seed', 'canary']));
    expect(sample).toEqual(sample.map(() => expect.objectContaining({ evaluator: PRODUCER, evaluatorKind: 'rule' })));
    expect(sample.filter(ev => ev.judgeModel !== undefined)).toEqual([]);
  });

  it('keeps seed-cohort scores inside their bands', () => {
    // Faithfulness and tool_correctness are seeded too; their bands are not pinned here.
    const bands: Array<[name: string, low: number, high: number]> = [
      [RELEVANCE_EVAL_NAME, 0.70, 1.0],
      [COHERENCE_EVAL_NAME, 0.75, 1.0],
      [HALLUCINATION_EVAL_NAME, 0.0, 0.09],
    ];

    // Negated rather than `< low || > high`: NaN fails every comparison, so the
    // positive form would let a NaN score through both arms.
    const outOfBand = bands.flatMap(([name, low, high]) =>
      scoresOf('seed', name).filter(score => !(score >= low && score <= high)).map(score => `${name}=${score}`));

    expect(bands.filter(([name]) => scoresOf('seed', name).length === 0)).toEqual([]);
    expect(outOfBand).toEqual([]);
  });

  it('gives canary turns intentionally low scores', () => {
    const CANARY_RELEVANCE_MAX = 0.35;
    const CANARY_HALLUCINATION_MIN = 0.50;
    const relevance = scoresOf('canary', RELEVANCE_EVAL_NAME);
    const hallucination = scoresOf('canary', HALLUCINATION_EVAL_NAME);

    expect(relevance.length).toBeGreaterThan(0);
    expect(hallucination.length).toBeGreaterThan(0);
    expect(relevance.filter(score => !(score <= CANARY_RELEVANCE_MAX))).toEqual([]);
    expect(hallucination.filter(score => !(score >= CANARY_HALLUCINATION_MIN))).toEqual([]);
  });
});

describe('toOTelRecord', () => {
  const attributesOf = (record: EvalRecord): Record<string, unknown> =>
    (toOTelRecord(record) as { attributes: Record<string, unknown> }).attributes;

  it('produces the flat OTel evaluation format', () => {
    const record = toOTelRecord(makeEvalRecord());

    expect(record).toMatchObject({ timestamp: '2026-02-09T01:11:15.525Z', traceId: 'trace-001' });
    expect(attributesOf(makeEvalRecord())).toMatchObject({
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: RELEVANCE_EVAL_NAME,
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: DEFAULT_SCORE,
      [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: 'Test explanation',
      [EVALUATION_ATTRS.PRODUCER]: PRODUCER,
      [EVALUATION_ATTRS.EVALUATOR_KIND]: 'llm',
      [EVALUATION_ATTRS.COHORT]: 'normal',
      [EVALUATION_ATTRS.JUDGE_MODEL]: 'claude-haiku-4-5-20251001',
      [SESSION_ATTRIBUTES.ID]: 'abc12345-session',
    });
  });

  it('stamps the evaluation schema URL as a record field, not an attribute', () => {
    expect(toOTelRecord(makeEvalRecord())).toMatchObject({ schemaUrl: 'https://integritystudio.ai/schemas/evaluation/1.0.0' });
    expect(attributesOf(makeEvalRecord()).schemaUrl).toBeUndefined();
  });

  it('omits session.id when empty', () => {
    expect(attributesOf(makeEvalRecord({ sessionId: '' }))[SESSION_ATTRIBUTES.ID]).toBeUndefined();
  });

  // OBP16: neither key is in the semconv registry, so both were local fields
  // squatting under an OpenTelemetry-owned namespace (AA3 Gate 1c).
  it('no longer writes the two overloaded gen_ai evaluator keys', () => {
    const attrs = attributesOf(makeEvalRecord());

    expect(attrs[LEGACY_EVALUATOR_TYPE_ATTR]).toBeUndefined();
    expect(attrs[GENAI_EVALUATION_ATTRIBUTES.EVALUATOR]).toBeUndefined();
  });

  it('writes the score unit under integritystudio.*, not gen_ai.*', () => {
    const attrs = attributesOf(makeEvalRecord({ scoreUnit: 'seconds' }));

    expect(attrs[EVALUATION_ATTRS.SCORE_UNIT]).toBe('seconds');
    expect(attrs[LEGACY_SCORE_UNIT_ATTR]).toBeUndefined();
  });

  it('omits the judge model for a score no model produced', () => {
    const { judgeModel: _noModel, ...canary } = makeEvalRecord({ cohort: 'canary', evaluatorKind: 'rule' });
    const attrs = attributesOf(canary);

    expect(attrs[EVALUATION_ATTRS.COHORT]).toBe('canary');
    expect(attrs[EVALUATION_ATTRS.JUDGE_MODEL]).toBeUndefined();
  });
});

describe('processBatch', () => {
  const CONCURRENCY = 2;
  const items = [1, 2, 3, 4, 5, 6];

  it('returns every result in input order', async () => {
    expect(await processBatch(items, CONCURRENCY, 0, n => Promise.resolve(n * 2))).toEqual(items.map(n => n * 2));
  });

  it('returns nothing for no items', async () => {
    expect(await processBatch([], CONCURRENCY, 0, (n: number) => Promise.resolve(n))).toEqual([]);
  });

  it('drops a failed item and keeps the rest', async () => {
    const failing = 2;
    const results = await processBatch(items, CONCURRENCY, 0, (n) => {
      if (n === failing) throw new Error('fail');
      return Promise.resolve(n);
    });

    expect(results).toEqual(items.filter(n => n !== failing));
  });

  it('runs exactly the concurrency limit at once', async () => {
    const WORK_MS = 10;
    let maxConcurrent = 0;
    let current = 0;

    await processBatch(items, CONCURRENCY, 0, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, WORK_MS));
      current--;
      return n;
    });

    expect(maxConcurrent).toBe(CONCURRENCY);
  });
});

// evaluateTurn (B14)
//
// G-Eval makes 2 calls: (1) step generation, (2) evaluation scoring (1-5 scale).
// QAG makes 2 calls: (1) statement extraction (JSON array), (2) verdict per statement.

const MOCK_GEVAL_STEPS = '1. Check quality\n2. Assess completeness\n3. Verify accuracy';
const MOCK_GEVAL_SCORE = 4;
const JUDGE_TIMEOUT_MS = 5000;

function mockResponse(prompt: string): { text: string } {
  if (prompt.includes('Generate detailed')) return { text: MOCK_GEVAL_STEPS };
  if (prompt.includes('statements') || prompt.includes('claims')) return { text: JSON.stringify(['The response is correct.']) };
  if (prompt.includes('verdict') || prompt.includes('supported')) return { text: 'yes' };
  return { text: String(MOCK_GEVAL_SCORE) };
}

function createMockLLM(): LLMProvider {
  return { generate: (prompt: string) => Promise.resolve(mockResponse(prompt)) };
}

function createFailingLLM(failKeyword: string): LLMProvider {
  return {
    generate(prompt: string) {
      if (prompt.toLowerCase().includes(failKeyword.toLowerCase())) return Promise.reject(new Error(`Mock ${failKeyword} failure`));
      return Promise.resolve(mockResponse(prompt));
    },
  };
}

const judgeOver = (llm: LLMProvider): LLMJudge => new LLMJudge(llm, { timeoutMs: JUDGE_TIMEOUT_MS, maxRetries: 0 });

async function judgedNames(llm: LLMProvider, turn: Turn, existingKeys = new Set<string>()): Promise<string[]> {
  return (await evaluateTurn(judgeOver(llm), turn, existingKeys)).map(e => e.evaluationName);
}

describe('evaluateTurn', () => {
  beforeEach(() => {
    resetFailureTracking();
  });

  it('judges relevance and coherence for a turn without tool results', async () => {
    expect(await judgedNames(createMockLLM(), makeTurn())).toEqual(PLAIN_CRITERIA);
  });

  it('judges every criterion for a turn with tool results, as llm-scored normal-cohort records', async () => {
    const evals = await evaluateTurn(judgeOver(createMockLLM()), makeToolTurn(), new Set());

    expect(evals).toEqual(TOOL_TURN_RECORDS.map(evaluationName =>
      expect.objectContaining({ evaluationName, evaluatorKind: 'llm', cohort: 'normal', judgeModel: HAIKU_MODEL })));
  });

  it('skips criteria this model already judged', async () => {
    const turn = makeTurn();

    expect(await judgedNames(createMockLLM(), turn, judgedKeys(turn, PLAIN_CRITERIA))).toEqual([]);
  });

  it('judges a turn again when only a different model has judged it', async () => {
    const turn = makeTurn();

    expect(await judgedNames(createMockLLM(), turn, judgedKeys(turn, PLAIN_CRITERIA, OTHER_JUDGE_MODEL))).toEqual(PLAIN_CRITERIA);
  });

  it('counts a failed criterion and still records the others', async () => {
    // "evaluating: relevance" matches only relevance prompts — "relevant" also
    // appears in the shared score anchoring text ("irrelevant").
    expect(await judgedNames(createFailingLLM('evaluating: relevance'), makeTurn())).toEqual([COHERENCE_EVAL_NAME]);
    expect(evalFailures).toEqual({ [RELEVANCE_EVAL_NAME]: 1 });
  });

  it('judges every criterion of a turn whose tool result is over the judge\'s length cap', async () => {
    const turn = makeToolTurn({ toolResults: ['x'.repeat(MAX_TEXT_LENGTH + 1)] });

    expect(await judgedNames(createMockLLM(), turn)).toEqual(TOOL_TURN_RECORDS);
    expect(evalFailures).toEqual({});
  });
});

describe('evaluateTurn faithfulness and hallucination', () => {
  beforeEach(() => {
    resetFailureTracking();
  });

  /**
   * A QAG sweep over four statements: two the context supports, one it contradicts
   * and one it cannot settle. The counts are deliberately unequal — with an even
   * split the two modes score the same and a test could not tell a mode-mapping
   * bug from correct behaviour. Counts only the sweep's own calls so the
   * surrounding G-Eval criteria do not pollute the total.
   */
  const QAG_STATEMENTS = ['A', 'B', 'C', 'D'];
  const QAG_ANSWERS = ['yes', 'yes', 'no', 'maybe'];
  const QAG_FAITHFULNESS = QAG_ANSWERS.filter(a => a === 'yes').length / QAG_ANSWERS.length;
  const QAG_HALLUCINATION = QAG_ANSWERS.filter(a => a === 'no').length / QAG_ANSWERS.length;
  /** 1 extraction + a question and an answer per statement; a second sweep doubles it. */
  const SINGLE_SWEEP_CALLS = 1 + 2 * QAG_STATEMENTS.length;

  function createQagLLM(): { llm: LLMProvider; sweepCalls: () => number } {
    let answerIndex = 0;
    let sweepCalls = 0;
    const llm: LLMProvider = {
      generate(prompt: string) {
        if (prompt.includes('Extract all factual claims')) {
          sweepCalls++;
          return Promise.resolve({ text: JSON.stringify(QAG_STATEMENTS) });
        }
        if (prompt.includes('yes/no question')) {
          sweepCalls++;
          return Promise.resolve({ text: 'Is it so?' });
        }
        if (prompt.includes('answer the question with')) {
          sweepCalls++;
          return Promise.resolve({ text: QAG_ANSWERS[answerIndex++] ?? 'maybe' });
        }
        return Promise.resolve(mockResponse(prompt));
      },
    };
    return { llm, sweepCalls: () => sweepCalls };
  }

  const scoreOf = (evals: EvalRecord[], name: string): number | undefined => evals.find(e => e.evaluationName === name)?.scoreValue;

  it('scores both from a single sweep, and hallucination is not 1 - faithfulness', async () => {
    const { llm, sweepCalls } = createQagLLM();

    const evals = await evaluateTurn(judgeOver(llm), makeToolTurn(), new Set());

    // 2 of 4 supported, 1 of 4 contradicted, 1 inconclusive and counted by neither.
    expect(scoreOf(evals, FAITHFULNESS_EVAL_NAME)).toBe(QAG_FAITHFULNESS);
    expect(scoreOf(evals, HALLUCINATION_EVAL_NAME)).toBe(QAG_HALLUCINATION);
    expect(sweepCalls()).toBe(SINGLE_SWEEP_CALLS);
  });

  it('runs the sweep only for the metric that is missing', async () => {
    const { llm, sweepCalls } = createQagLLM();
    const turn = makeToolTurn();

    const evals = await evaluateTurn(judgeOver(llm), turn, judgedKeys(turn, [FAITHFULNESS_EVAL_NAME]));

    expect(evals.map(e => e.evaluationName)).not.toContain(FAITHFULNESS_EVAL_NAME);
    // The score is the fabrication tally, not the faithfulness one it sits beside.
    expect(scoreOf(evals, HALLUCINATION_EVAL_NAME)).toBe(QAG_HALLUCINATION);
    expect(sweepCalls()).toBe(SINGLE_SWEEP_CALLS);
  });

  it('counts a failed sweep against every metric that asked for it', async () => {
    const names = await judgedNames(createFailingLLM('Convert this statement'), makeToolTurn());

    // One shared failure, two metrics missing — recording it once would leave the
    // hallucination series looking merely absent rather than failed.
    expect(evalFailures).toEqual({ [FAITHFULNESS_EVAL_NAME]: 1, [HALLUCINATION_EVAL_NAME]: 1 });
    expect(names).not.toContain(HALLUCINATION_EVAL_NAME);
  });
});

describe('fitContextForJudge', () => {
  it('leaves items within the cap untouched', () => {
    const items = ['a', 'b'.repeat(MAX_TEXT_LENGTH)];

    expect(fitContextForJudge(items)).toEqual(items);
  });

  it('truncates an oversized item to exactly the cap and marks the cut', () => {
    const [fitted] = fitContextForJudge(['x'.repeat(MAX_TEXT_LENGTH + 1)]);

    expect(fitted).toHaveLength(MAX_TEXT_LENGTH);
    expect(defined(fitted).endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  it('keeps at most the tool-context item limit', () => {
    const many = Array.from({ length: MAX_TOOL_CONTEXT_ITEMS + 1 }, (_, i) => `result ${i}`);

    expect(fitContextForJudge(many)).toHaveLength(MAX_TOOL_CONTEXT_ITEMS);
  });
});

describe('classifyJudgeFailure', () => {
  it.each<[JudgeFailureClass, string]>([
    ['billing', '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
    // A QAG sweep reports its own summary; the provider's text has to survive
    // inside it, or a billing refusal mid-sweep is counted as `other` and the
    // run-level escalation never fires.
    ['billing', 'QAG evaluation failed: no verification questions generated (400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}})'],
    ['network', 'Connection error.'],
    ['network', 'getaddrinfo ENOTFOUND api.anthropic.com'],
    ['schema-rejection', '400 {"type":"error","error":{"type":"invalid_request_error","message":"output_config.format.schema is invalid: minimum is not a supported keyword"}}'],
    ['schema-rejection', 'Request failed: output_config validation failed'],
    ['parse', 'Generated evaluation steps below minimum (got 0, require 3)'],
    ['parse', "Unexpected token '`', \"```json\" is not valid JSON"],
    ['invalid-input', 'Invalid TestCase: [ { "code": "too_big" } ]'],
    // The batch provider's BatchWallClockExceededError, as the 09-29 and 09-30 06:00 runs logged it.
    ['wall-clock', 'Message batch msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d still processing at the 10800000ms wall clock; cancelled'],
    ['other', 'something nobody anticipated'],
  ])('classifies as %s: %s', (expected, message) => {
    expect(classifyJudgeFailure(message)).toBe(expected);
  });

  it('does not classify billing errors as schema-rejection even if they share keywords', () => {
    expect(classifyJudgeFailure('credit balance is too low; output_config ignored')).toBe('billing');
  });

  it('does not read a reply that merely mentions a wall clock as an overrun', () => {
    expect(classifyJudgeFailure('Could not parse verdict for coherence: "the wall clock time was not measured"')).toBe('parse');
  });
});

describe('summarizeJudgeRun', () => {
  const noFailures: Record<JudgeFailureClass, number> = { billing: 0, network: 0, 'schema-rejection': 0, parse: 0, 'invalid-input': 0, 'wall-clock': 0, other: 0 };
  const noSpend: JudgeSpend = { usage: createUsageTotals(), estimatedUsd: 0, keySource: DEFAULT_API_KEY_ENV };

  type Run = {
    succeeded: number;
    failed?: number;
    byClass?: Partial<Record<JudgeFailureClass, number>>;
    previous?: { succeeded: number; attempted: number };
  };

  function summarize({ succeeded, failed = 0, byClass = {}, previous }: Run, spend: JudgeSpend = noSpend): ReturnType<typeof summarizeJudgeRun> {
    const byMetric = failed > 0 ? { [COHERENCE_EVAL_NAME]: failed } : {};
    return summarizeJudgeRun(succeeded, { byMetric, byClass: { ...noFailures, ...byClass } }, spend, previous);
  }

  const PREVIOUS_FULL_RUN = { succeeded: 536, attempted: 536 };

  /**
   * [case, run, exit code, fragments the summary line must contain]. The failure-rate
   * alarm fires above 50% failed; the drop alarm above a 25-point fall in success
   * rate, compared only when both runs attempted enough. Precedence: billing, then
   * wall clock, then no scores, then rate, then drop.
   */
  const RUN_OUTCOMES: Array<[string, Run, number, string[]]> = [
    ['a run whose failures stay under half', { succeeded: 200, failed: 40, byClass: { parse: 40 } }, 0, ['attempted=240 succeeded=200 failed=40', 'parse=40']],
    ['a run that attempted nothing', { succeeded: 0 }, 0, []],
    ['a run where every attempt failed', { succeeded: 0, failed: 200, byClass: { parse: 200 } }, JUDGE_EXIT_NO_SCORES, ['NO SCORES PRODUCED']],
    ['a run at 100% failure, before the rate check', { succeeded: 0, failed: 100 }, JUDGE_EXIT_NO_SCORES, []],
    ['a billing refusal, even beside scores', { succeeded: 3, failed: 10, byClass: { billing: 10 } }, JUDGE_EXIT_BILLING, ['BILLING REFUSED']],
    ['a billing refusal beside a wall-clock overrun', { succeeded: 3, failed: 20, byClass: { billing: 10, 'wall-clock': 10 } }, JUDGE_EXIT_BILLING, []],
    // JUDGE-BATCH-WALLCLOCK-ABORTS-RUN: an overrun once threw out of main and cost the 09-29 and 09-30 runs their sync.
    ['a wall-clock overrun that abandoned most evaluations', { succeeded: 40, failed: 60, byClass: { 'wall-clock': 60 } }, JUDGE_EXIT_BATCH_WALL_CLOCK,
      ['BATCH WALL CLOCK EXCEEDED — 60 evaluations were abandoned', 'the 40 scored before it are kept', 'wall-clock=60']],
    ['a wall-clock overrun that abandoned every evaluation', { succeeded: 0, failed: 100, byClass: { 'wall-clock': 100 } }, JUDGE_EXIT_BATCH_WALL_CLOCK, []],
    ['91% failing (the 09-22 collapse)', { succeeded: 46, failed: 490, byClass: { 'schema-rejection': 490 } }, JUDGE_EXIT_HIGH_FAILURE_RATE, ['HIGH FAILURE RATE', '490 of 536']],
    ['49.7% failing', { succeeded: 100, failed: 99 }, 0, []],
    ['50.25% failing', { succeeded: 100, failed: 101 }, JUDGE_EXIT_HIGH_FAILURE_RATE, []],
    ['a 40-point fall in success rate with only 40% failing', { succeeded: 300, failed: 200, previous: PREVIOUS_FULL_RUN }, JUDGE_EXIT_HIGH_FAILURE_RATE,
      ['SUCCESS RATE DROP', '60.0% of 500', '100.0% of 536']],
    ['a 21.8-point fall', { succeeded: 419, failed: 117, previous: PREVIOUS_FULL_RUN }, 0, []],
    ['a smaller run with no failures, however far its count falls', { succeeded: 60, previous: PREVIOUS_FULL_RUN }, 0, []],
    ['a fall measured over too few attempts this run', { succeeded: 6, failed: 4, previous: PREVIOUS_FULL_RUN }, 0, []],
    ['a fall against too small a previous run', { succeeded: 300, failed: 200, previous: { succeeded: 10, attempted: 10 } }, 0, []],
    ['no previous run to compare', { succeeded: 300, failed: 200 }, 0, []],
    ['a run that trips both alarms, as the rate alarm', { succeeded: 10, failed: 200, previous: { succeeded: 500, attempted: 500 } }, JUDGE_EXIT_HIGH_FAILURE_RATE, ['HIGH FAILURE RATE']],
  ];

  it.each(RUN_OUTCOMES)('exits for %s with %i', (_case, run, exitCode, fragments) => {
    const summary = summarize(run);

    expect(summary.exitCode).toBe(exitCode);
    expect(fragments.filter(fragment => !summary.line.includes(fragment))).toEqual([]);
  });

  it('treats a wall-clock overrun as soft, so populate carries on to sync', () => {
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_BATCH_WALL_CLOCK)).toBe(true);
  });

  it('carries the usage totals, both cost figures and the key source name on the line', () => {
    const usage: JudgeTokenUsage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const estimatedUsd = 1.8;
    const succeeded = 5;

    const summary = summarize({ succeeded }, { usage, estimatedUsd, keySource: JUDGE_API_KEY_ENV });

    const pricing = judgePricing();
    const actualUsd = (usage.inputTokens / TOKENS_PER_MILLION) * pricing.input + (usage.outputTokens / TOKENS_PER_MILLION) * pricing.output;
    expect(summary).toMatchObject({ usage, estimatedUsd, keySource: JUDGE_API_KEY_ENV });
    expect(summary.actualUsd).toBeCloseTo(actualUsd);
    expect(summary.line).toContain(
      `usage: in=1000000 out=100000 cache_read=0 cache_creation=0 est=$${estimatedUsd.toFixed(EVAL_SCORE_PRECISION)} actual=$${actualUsd.toFixed(EVAL_SCORE_PRECISION)} key=LLM_JUDGE_ANTHROPIC_KEY`,
    );
  });

  it('copies the totals rather than sharing the accumulator', () => {
    const usage = createUsageTotals();
    const summary = summarize({ succeeded: 0 }, { ...noSpend, usage });

    addUsage(usage, { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

    expect(summary.usage.inputTokens).toBe(0);
  });
});

describe('readRunState / writeRunState', () => {
  // A temp path, never the default: that is the live file the
  // scheduled pipeline's drop check reads.
  const dir = useTempDir('judge-run-state-');
  const stateFile = (): string => join(dir(), 'state.json');

  it('returns undefined when no state file exists', () => {
    expect(readRunState(stateFile())).toBeUndefined();
  });

  it('round-trips the succeeded and attempted counts', () => {
    const succeeded = 420;
    const attempted = 536;

    writeRunState(succeeded, attempted, stateFile());

    expect(readRunState(stateFile())).toEqual({ succeeded, attempted, timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it('returns undefined for a state file written before attempted was recorded', () => {
    // The shape the live file had on 2026-09-22: a count alone gives no rate
    writeFileSync(stateFile(), JSON.stringify({ succeeded: 536, timestamp: '2026-09-23T01:23:37.000Z' }), 'utf-8');
    expect(readRunState(stateFile())).toBeUndefined();
  });

  it('returns undefined for a corrupt state file without throwing', () => {
    writeFileSync(stateFile(), 'not-json', 'utf-8');
    expect(readRunState(stateFile())).toBeUndefined();
  });
});

describe('estimateJudgeRun', () => {
  it('counts two evals for a turn without tools and four for one with', () => {
    // Four, not five: faithfulness and hallucination come from one QAG sweep, so
    // the second score costs nothing to price.
    const EVALS_PER_PLAIN_TURN = 2;
    const EVALS_PER_TOOL_TURN = 4;
    const est = estimateJudgeRun([makeTurn(), makeToolTurn()]);

    expect(est.evals).toBe(EVALS_PER_PLAIN_TURN + EVALS_PER_TOOL_TURN);
    expect(est.outputTokens).toBe(est.evals * EST_OUTPUT_TOKENS_PER_EVAL);
    expect(est.inputTokens).toBeGreaterThan(0);
  });

  it('prices the estimate at the judge model list rates, with no discount by default', () => {
    const est = estimateJudgeRun([makeTurn()]);
    const pricing = judgePricing();

    expect(est.costUsd).toBeCloseTo((est.inputTokens / TOKENS_PER_MILLION) * pricing.input + (est.outputTokens / TOKENS_PER_MILLION) * pricing.output);
    expect(estimateJudgeRun([makeTurn()], false)).toEqual(est);
  });

  it('is free for no turns', () => {
    expect(estimateJudgeRun([])).toEqual({ evals: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('applies the batch discount to the cost and nothing else', () => {
    const list = estimateJudgeRun([makeTurn()], false);

    expect(estimateJudgeRun([makeTurn()], true)).toEqual({ ...list, costUsd: expect.closeTo(list.costUsd * BATCH_PRICE_RATIO) });
  });
});

// anthropicProviderFor (structured score output)

/** Room for two to three sentences of reasoning plus the score object. */
const STRUCTURED_OUTPUT_MAX_TOKENS_FLOOR = 512;
const SCORE_SCHEMA = {
  type: 'object',
  properties: { reasoning: { type: 'string' }, score: { type: 'integer', enum: [1, 2, 3, 4, 5] } },
  required: ['reasoning', 'score'],
  additionalProperties: false,
};

type JudgeCreateParams = Parameters<JudgeMessagesClient['messages']['create']>[0];

function makeFakeAnthropicClient(text: string): { client: JudgeMessagesClient; calls: JudgeCreateParams[] } {
  const calls: JudgeCreateParams[] = [];
  const client: JudgeMessagesClient = {
    messages: {
      create(params) {
        calls.push(params);
        return Promise.resolve({ content: [{ type: 'text', text, citations: null }] });
      },
    },
  };
  return { client, calls };
}

describe('anthropicProviderFor', () => {
  it('sends output_config with the json_schema format when a schema is given', async () => {
    const verdict = '{"reasoning": "Clear.", "score": 4}';
    const { client, calls } = makeFakeAnthropicClient(verdict);

    const result = await anthropicProviderFor(client).generate('rate it', { jsonSchema: SCORE_SCHEMA });

    expect(calls).toEqual([expect.objectContaining({
      output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
      max_tokens: JUDGE_MAX_TOKENS,
    })]);
    expect(result).toEqual({ text: verdict });
  });

  it('omits output_config when no schema is given', async () => {
    const { client, calls } = makeFakeAnthropicClient('Score: 4');

    await anthropicProviderFor(client).generate('rate it');

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('output_config');
  });

  it('folds usage into the totals and hands each response to onUsage', async () => {
    const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: null, cache_creation_input_tokens: 5 };
    const client: JudgeMessagesClient = { messages: { create: () => Promise.resolve({ content: [], usage }) } };
    const totals = createUsageTotals();
    const seen: unknown[] = [];

    await anthropicProviderFor(client, totals, u => seen.push(u)).generate('rate it', { jsonSchema: SCORE_SCHEMA });

    const folded = { inputTokens: 120, outputTokens: 30, cacheCreationInputTokens: 5, cacheReadInputTokens: 0 };
    expect(totals).toEqual(folded);
    expect(seen).toEqual([folded]);
  });

  it('keeps max_tokens high enough for the reasoning and the score', () => {
    expect(JUDGE_MAX_TOKENS).toBeGreaterThanOrEqual(STRUCTURED_OUTPUT_MAX_TOKENS_FLOOR);
  });
});

// evaluateTurn concurrent mode + evaluateTurnsBatched (--batch wiring)

/** Long enough for gEval's dynamic import and promise chain to reach the provider. */
const SETTLE_MS = 20;
const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

/** A provider that answers nothing until asked, so in-flight calls can be counted. */
function createDeferredLLM() {
  const waiting: Array<{ prompt: string; resolve: (r: { text: string }) => void }> = [];
  const llm: LLMProvider = {
    generate(prompt: string) {
      return new Promise(resolve => { waiting.push({ prompt, resolve }); });
    },
  };
  const answerAll = () => {
    for (const { prompt, resolve } of waiting.splice(0)) resolve(mockResponse(prompt));
  };
  return { llm, waiting, answerAll };
}

describe('evaluateTurn in concurrent mode', () => {
  it('issues every criterion before any result comes back, unlike the sequential default', async () => {
    const sequential = createDeferredLLM();
    const sequentialRun = evaluateTurn(judgeOver(sequential.llm), makeTurn(), new Set());
    await settle();
    expect(sequential.waiting).toHaveLength(1);

    const concurrent = createDeferredLLM();
    const concurrentRun = evaluateTurn(judgeOver(concurrent.llm), makeTurn(), new Set(), { concurrent: true });
    await settle();
    expect(concurrent.waiting).toHaveLength(PLAIN_CRITERIA.length); // both at their first call

    // Each answered round lets the next call out; both runs are done once a round leaves nothing waiting.
    do {
      sequential.answerAll();
      concurrent.answerAll();
      // eslint-disable-next-line no-await-in-loop -- one round at a time, see above
      await settle();
    } while (sequential.waiting.length + concurrent.waiting.length > 0);
    expect((await concurrentRun).map(e => e.evaluationName).toSorted()).toEqual(PLAIN_CRITERIA.toSorted());
    expect((await sequentialRun).map(e => e.evaluationName)).toEqual(PLAIN_CRITERIA);
  });
});

describe('evaluateTurnsBatched', () => {
  function batchProvider(overrides: Partial<BatchLLMProvider> = {}): BatchLLMProvider {
    const mock = createMockLLM();
    return { generate: (prompt: string) => mock.generate(prompt), flush: vi.fn(() => Promise.resolve({ settled: 0, abandoned: 0 })), failure: undefined, ...overrides };
  }

  it('flushes the provider exactly once for a small run and scores every turn', async () => {
    resetFailureTracking();
    const flush = vi.fn(() => Promise.resolve({ settled: 0, abandoned: 0 }));
    const provider = batchProvider({ flush });
    const turns = [makeTurn({ sessionId: 'batch-1' }), makeToolTurn({ sessionId: 'batch-2' })];

    const perTurn = await evaluateTurnsBatched(provider, judgeOver(provider), turns, new Set());

    expect(flush).toHaveBeenCalledTimes(1);
    expect(perTurn.map(evals => evals.map(e => e.evaluationName).toSorted())).toEqual([PLAIN_CRITERIA.toSorted(), TOOL_TURN_RECORDS.toSorted()]);
    expect(evalFailures).toEqual({});
  });

  // A run failure, not the wall clock: the wall clock settles what it can and
  // resolves flush() (see judge-batch-provider.test.ts); only an error that
  // escapes a batch rejects it and is recorded as the provider's failure.
  it('throws when flush() fails, and when the provider records a failure, instead of returning partial records', async () => {
    const runFailure = new Error('a batch response the provider could not read');

    const failingFlush = batchProvider({ flush: vi.fn(() => Promise.reject(runFailure)) });
    await expect(evaluateTurnsBatched(failingFlush, judgeOver(failingFlush), [makeTurn()], new Set())).rejects.toBe(runFailure);

    const recorded = batchProvider({ failure: runFailure });
    await expect(evaluateTurnsBatched(recorded, judgeOver(recorded), [makeTurn()], new Set())).rejects.toBe(runFailure);
  });
});

describe('rejectRemovedFlags', () => {
  it('refuses the removed --backfill flag instead of starting a judge run', () => {
    expect(() => rejectRemovedFlags(['--limit', '5', '--backfill'])).toThrow(CliArgError);
  });

  it('accepts the flags the judge still reads', () => {
    expect(() => rejectRemovedFlags(['--dry-run', '--batch', '--source=cloud', '--days=7'])).not.toThrow();
  });
});

describe('acquireLock', () => {
  const dir = useTempDir('judge-lock-');
  const LOCK_NAME = '.judge-evaluations.lock';
  const lockFile = (): string => join(dir(), LOCK_NAME);
  const owner = (): string => readFileSync(lockFile(), 'utf-8');
  const exitedPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes a free lock and records this pid', () => {
    expect(acquireLock(lockFile())).toBe(true);
    expect(owner()).toBe(String(process.pid));
  });

  it('refuses a lock held by a live process', () => {
    writeFileSync(lockFile(), String(process.ppid));

    expect(acquireLock(lockFile())).toBe(false);
    expect(owner()).toBe(String(process.ppid));
  });

  it.each([
    ['an exited process', () => String(exitedPid())],
    ['a malformed pid', () => 'not-a-pid'],
    ['an empty file, which no current writer leaves behind', () => ''],
  ])('reclaims a lock left by %s', (_label, previousOwner) => {
    writeFileSync(lockFile(), previousOwner());

    expect(acquireLock(lockFile())).toBe(true);
    expect(owner()).toBe(String(process.pid));
    expect(readdirSync(dir())).toEqual([LOCK_NAME]);
  });

  it('refuses a second acquire once this process holds the lock', () => {
    expect(acquireLock(lockFile())).toBe(true);
    expect(acquireLock(lockFile())).toBe(false);
    expect(readdirSync(dir())).toEqual([LOCK_NAME]);
  });
});
