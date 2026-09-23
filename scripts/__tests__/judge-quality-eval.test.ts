import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseArgs,
  refusalReason,
  resolveAgreementPath,
  readAgreementTurns,
  resultsFilePath,
  estimateCallInputTokens,
  estimateReferenceSpend,
  compareToReference,
  closerConfiguration,
  turnKey,
  YES_FLAG,
  AGREEMENT_FLAG,
  MARKER_FILENAME,
  RESULTS_PREFIX,
  PROMPT_OVERHEAD_TOKENS_ESTIMATE,
  OUTPUT_TOKENS_PER_CALL_ESTIMATE,
  type QualityTurn,
} from '../judge-quality-eval.js';
import { RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, type Turn } from '../judge-evaluations.js';
import { RELEVANCE_CRITERIA, FAITHFULNESS_CRITERIA } from '../../../src/lib/judge/llm-judge-config.js';
import { TOKENS_PER_CHAR } from '../../../src/lib/core/constants-models.js';

const PRICING = { input: 5.0, output: 25.0, provider: 'anthropic' } as const;
const ONE_MILLION = 1_000_000;
/** 0–1 values that land exactly on the 1–5 grid: 0 → 1, 0.25 → 2, 0.5 → 3, 0.75 → 4, 1 → 5. */
const SCORE_1 = 0;
const SCORE_3 = 0.5;
const SCORE_4 = 0.75;
const SCORE_5 = 1;

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-02-09T01:11:15.525Z',
    userText: 'u'.repeat(400),
    assistantText: 'a'.repeat(800),
    toolResults: [],
    ...overrides,
  };
}

function makeQualityTurn(overrides: Partial<QualityTurn>): QualityTurn {
  return {
    sessionId: 's1',
    timestamp: '2026-02-09T01:11:15.525Z',
    hasTools: false,
    expected: [RELEVANCE_EVAL_NAME],
    perCriterion: {},
    consolidated: {},
    reference: {},
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('requires --yes', () => {
    expect(parseArgs([]).error).toContain(YES_FLAG);
  });

  it('accepts --yes with an agreement path', () => {
    expect(parseArgs([YES_FLAG, AGREEMENT_FLAG, 'a.json'])).toEqual({ yes: true, agreementPath: 'a.json' });
  });

  it('rejects --agreement without a value', () => {
    expect(parseArgs([AGREEMENT_FLAG, YES_FLAG]).error).toContain('needs a path');
  });

  it('rejects unknown flags, including --force', () => {
    expect(parseArgs([YES_FLAG, '--force']).error).toContain('Unknown argument: --force');
  });
});

describe('run-once files', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'judge-quality-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('allows a run in an empty directory', () => {
    expect(refusalReason(dir)).toBeUndefined();
  });

  it('refuses while the marker exists', () => {
    writeFileSync(join(dir, MARKER_FILENAME), '{}');
    expect(refusalReason(dir)).toContain('marker exists');
  });

  it('refuses once a results file exists', () => {
    writeFileSync(resultsFilePath(dir, new Date('2026-09-22T00:00:00Z')), '{}');
    expect(refusalReason(dir)).toContain(`${RESULTS_PREFIX}2026-09-22.json`);
  });

  it('is not blocked by judge-agreement results', () => {
    writeFileSync(join(dir, 'judge-agreement-2026-09-22.json'), '{}');
    expect(refusalReason(dir)).toBeUndefined();
  });

  it('picks the newest agreement file unless one is named', () => {
    writeFileSync(join(dir, 'judge-agreement-2026-09-21.json'), '{}');
    writeFileSync(join(dir, 'judge-agreement-2026-09-22.json'), '{}');
    expect(resolveAgreementPath(dir)).toBe(join(dir, 'judge-agreement-2026-09-22.json'));
    expect(resolveAgreementPath(dir, 'explicit.json')).toBe('explicit.json');
  });

  it('returns undefined when there is no agreement file', () => {
    expect(resolveAgreementPath(dir)).toBeUndefined();
  });

  it('rejects a file without a turns array', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{"agreement":{}}');
    expect(() => readAgreementTurns(path)).toThrow('no turns array');
  });
});

describe('turnKey', () => {
  it('distinguishes turns of one session by timestamp', () => {
    const a = turnKey({ sessionId: 's', timestamp: 't1' });
    const b = turnKey({ sessionId: 's', timestamp: 't2' });
    expect(a).not.toBe(b);
  });
});

describe('estimateCallInputTokens', () => {
  it('counts only the parts the criterion reads', () => {
    // faithfulness reads output + context, never the user's input.
    const short = makeTurn({ userText: 'u', toolResults: ['c'.repeat(2000)] });
    const long = makeTurn({ userText: 'u'.repeat(4000), toolResults: ['c'.repeat(2000)] });
    expect(estimateCallInputTokens(long, FAITHFULNESS_CRITERIA)).toBe(estimateCallInputTokens(short, FAITHFULNESS_CRITERIA));
    expect(estimateCallInputTokens(long, RELEVANCE_CRITERIA)).toBeGreaterThan(estimateCallInputTokens(short, RELEVANCE_CRITERIA));
    expect(estimateCallInputTokens(makeTurn(), FAITHFULNESS_CRITERIA)).toBeGreaterThanOrEqual(PROMPT_OVERHEAD_TOKENS_ESTIMATE);
  });
});

describe('estimateReferenceSpend', () => {
  it('prices one call per selected criterion at the reference rates', () => {
    const turn = makeTurn();
    const estimate = estimateReferenceSpend([turn], PRICING);
    // A turn without tool results selects relevance and coherence only.
    expect(estimate.calls).toBe(2);
    expect(estimate.outputTokens).toBe(2 * OUTPUT_TOKENS_PER_CALL_ESTIMATE);
    const expectedUsd = (estimate.inputTokens * PRICING.input + estimate.outputTokens * PRICING.output) / ONE_MILLION;
    expect(estimate.usd).toBeCloseTo(expectedUsd, 10);
    expect(estimate.inputTokens).toBeGreaterThan(Math.ceil(1200 * TOKENS_PER_CHAR));
  });
});

describe('compareToReference', () => {
  const turns: QualityTurn[] = [
    makeQualityTurn({
      perCriterion: { [RELEVANCE_EVAL_NAME]: SCORE_5, [COHERENCE_EVAL_NAME]: SCORE_3 },
      consolidated: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_5 },
      reference: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_3 },
    }),
  ];

  it('scores exact match and MAE against the reference', () => {
    const pc = compareToReference(turns, 'perCriterion');
    expect(pc.byCriterion[RELEVANCE_EVAL_NAME]).toMatchObject({ paired: 1, exactMatchRate: 0, meanAbsDiff: 1 });
    expect(pc.byCriterion[COHERENCE_EVAL_NAME]).toMatchObject({ paired: 1, exactMatchRate: 1, meanAbsDiff: 0 });
    expect(pc.overall).toMatchObject({ paired: 2, exactMatchRate: 0.5, meanAbsDiff: 0.5 });
  });

  it('signs the bias: positive when the configuration is more lenient', () => {
    const cons = compareToReference(turns, 'consolidated');
    expect(cons.byCriterion[COHERENCE_EVAL_NAME]!.meanSignedDiff).toBe(2);
    const harsh = compareToReference(
      [makeQualityTurn({ perCriterion: { [RELEVANCE_EVAL_NAME]: SCORE_1 }, reference: { [RELEVANCE_EVAL_NAME]: SCORE_5 } })],
      'perCriterion',
    );
    expect(harsh.byCriterion[RELEVANCE_EVAL_NAME]!.meanSignedDiff).toBe(-4);
  });

  it('counts scores present on only one side instead of pairing them', () => {
    const summary = compareToReference(
      [makeQualityTurn({
        perCriterion: { [FAITHFULNESS_EVAL_NAME]: SCORE_3 },
        reference: { [RELEVANCE_EVAL_NAME]: SCORE_4 },
      })],
      'perCriterion',
    );
    expect(summary.byCriterion[FAITHFULNESS_EVAL_NAME]).toMatchObject({ paired: 0, configOnly: 1, meanSignedDiff: null });
    expect(summary.byCriterion[RELEVANCE_EVAL_NAME]).toMatchObject({ paired: 0, referenceOnly: 1 });
  });
});

describe('closerConfiguration', () => {
  it('names the configuration with the lower MAE per criterion', () => {
    const turns: QualityTurn[] = [
      makeQualityTurn({
        perCriterion: { [RELEVANCE_EVAL_NAME]: SCORE_5, [COHERENCE_EVAL_NAME]: SCORE_3 },
        consolidated: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_5 },
        reference: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_3 },
      }),
    ];
    const verdict = closerConfiguration(compareToReference(turns, 'perCriterion'), compareToReference(turns, 'consolidated'));
    expect(verdict).toEqual({ [COHERENCE_EVAL_NAME]: 'perCriterion', [RELEVANCE_EVAL_NAME]: 'consolidated' });
  });

  it('calls a tie when either side is unpaired or both are equal', () => {
    const turns: QualityTurn[] = [
      makeQualityTurn({
        perCriterion: { [RELEVANCE_EVAL_NAME]: SCORE_4 },
        consolidated: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_4 },
        reference: { [RELEVANCE_EVAL_NAME]: SCORE_4, [COHERENCE_EVAL_NAME]: SCORE_4 },
      }),
    ];
    const verdict = closerConfiguration(compareToReference(turns, 'perCriterion'), compareToReference(turns, 'consolidated'));
    expect(verdict).toEqual({ [COHERENCE_EVAL_NAME]: 'tie', [RELEVANCE_EVAL_NAME]: 'tie' });
  });
});
