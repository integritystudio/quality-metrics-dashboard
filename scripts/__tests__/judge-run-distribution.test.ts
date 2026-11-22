import { describe, expect, it } from 'vitest';
import { CliArgError } from '../cli-args.js';
import { CONSOLIDATED_PRODUCER } from '../judge-consolidated.js';
import {
  EVALUATOR_FLAG,
  JSON_FLAG,
  SINCE_FLAG,
  parseRunDistributionArgs,
  receiptGroupsSql,
  scheduledRunLabel,
  summarizeRuns,
  type ReceiptGroup,
} from '../judge-run-distribution.js';

type LocalTime = readonly [year: number, monthIndex: number, day: number, hour: number, minute: number];
const localMs = (time: LocalTime): number => new Date(...time).getTime();

const AT = {
  eveningRunStart: [2026, 10, 21, 18, 0],
  eveningRunPost: [2026, 10, 21, 18, 8],
  eveningRunLate: [2026, 10, 21, 19, 0],
  morningRunStart: [2026, 10, 21, 6, 0],
  beforeEveningRun: [2026, 10, 21, 17, 59],
  afterMidnight: [2026, 10, 22, 1, 30],
  monthStart: [2026, 10, 1, 0, 5],
} as const satisfies Record<string, LocalTime>;

const SINCE_MS = 1_795_046_400_000;

const group = (overrides: Partial<ReceiptGroup>): ReceiptGroup => ({
  hour_ms: localMs(AT.eveningRunStart),
  evaluation_name: 'coherence',
  score_value: 1,
  judge_model: 'claude-haiku-5-5',
  has_judge_attrs: 0,
  n: 1,
  ...overrides,
});

describe('scheduledRunLabel', () => {
  it('assigns a receipt to the run that started at or before it', () => {
    expect(scheduledRunLabel(localMs(AT.eveningRunPost))).toBe('2026-11-21 18:00');
    expect(scheduledRunLabel(localMs(AT.morningRunStart))).toBe('2026-11-21 06:00');
    expect(scheduledRunLabel(localMs(AT.beforeEveningRun))).toBe('2026-11-21 06:00');
  });

  it('assigns a receipt before the first run of the day to the previous evening', () => {
    expect(scheduledRunLabel(localMs(AT.afterMidnight))).toBe('2026-11-21 18:00');
    expect(scheduledRunLabel(localMs(AT.monthStart))).toBe('2026-10-31 18:00');
  });
});

describe('summarizeRuns', () => {
  it('folds groups into runs with model counts, judge-attribute coverage and per-criterion distributions', () => {
    const runs = summarizeRuns([
      group({ score_value: 1, n: 3, has_judge_attrs: 1 }),
      group({ score_value: 0.5, n: 1, hour_ms: localMs(AT.eveningRunLate) }),
      group({ score_value: null, n: 2, judge_model: null }),
      group({ hour_ms: localMs(AT.morningRunStart), evaluation_name: 'relevance', score_value: 0.25, n: 4 }),
    ]);

    expect(Object.keys(runs)).toEqual(['2026-11-21 06:00', '2026-11-21 18:00']);
    expect(runs['2026-11-21 18:00']).toEqual({
      rows: 6,
      judgeModels: { 'claude-haiku-5-5': 4, '(none)': 2 },
      withJudgeAttrs: 3,
      criteria: { coherence: { n: 6, mean: 0.875, dist: { '0.50': 1, '1.00': 3, null: 2 } } },
    });
    expect(runs['2026-11-21 06:00']?.criteria.relevance).toEqual({ n: 4, mean: 0.25, dist: { '0.25': 4 } });
  });

  it('reports no mean for a criterion with only unscored rows', () => {
    const runs = summarizeRuns([group({ score_value: null })]);
    expect(runs['2026-11-21 18:00']?.criteria.coherence?.mean).toBeNull();
  });
});

describe('receiptGroupsSql', () => {
  it('filters on the evaluator and receipt time and flags the judge identity attributes', () => {
    const sql = receiptGroupsSql(CONSOLIDATED_PRODUCER, SINCE_MS);
    expect(sql).toContain(`evaluator = '${CONSOLIDATED_PRODUCER}'`);
    expect(sql).toContain(`>= ${SINCE_MS}`);
    expect(sql).toContain("LIKE '%integritystudio.evaluation.judge.%'");
  });
});

describe('parseRunDistributionArgs', () => {
  it('defaults the evaluator to the consolidated judge', () => {
    expect(parseRunDistributionArgs([SINCE_FLAG, '2026-11-21'])).toEqual({
      sinceMs: Date.parse('2026-11-21'),
      evaluator: CONSOLIDATED_PRODUCER,
      json: false,
    });
  });

  it('takes an evaluator and the json switch', () => {
    const args = parseRunDistributionArgs([SINCE_FLAG, '2026-11-21T13:00:00Z', EVALUATOR_FLAG, 'dashboard:judge-evaluations', JSON_FLAG]);
    expect(args).toEqual({ sinceMs: Date.parse('2026-11-21T13:00:00Z'), evaluator: 'dashboard:judge-evaluations', json: true });
  });

  it.each([
    [[]],
    [[SINCE_FLAG, 'yesterday']],
    [[SINCE_FLAG, '2026-11-21', EVALUATOR_FLAG, "x'; DROP TABLE evaluations; --"]],
    [[SINCE_FLAG, '2026-11-21', '--days', '7']],
  ])('rejects %j', argv => {
    expect(() => parseRunDistributionArgs(argv)).toThrow(CliArgError);
  });
});
