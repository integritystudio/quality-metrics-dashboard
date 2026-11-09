import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import type { EvalRecord } from '../eval-record.js';
import { HAIKU_MODEL, RELEVANCE_EVAL_NAME } from '../judge-criteria.js';
import { turnJudgedKey } from '../judge-dedup.js';
import { addPendingKeys, readPendingEvaluations, writePendingEvaluations } from '../judge-pending.js';
import { makeTurn } from './support/fixtures.js';
import { useTempDir } from './support/temp-dir.js';

const turn = makeTurn();

function pendingRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName: RELEVANCE_EVAL_NAME,
    scoreValue: 0.75,
    explanation: 'on topic',
    evaluator: 'dashboard:judge-consolidated',
    evaluatorKind: 'llm',
    cohort: 'normal',
    judgeModel: HAIKU_MODEL,
    traceId: turn.traceId,
    sessionId: turn.sessionId,
    stableEvaluationKey: turnJudgedKey(turn, RELEVANCE_EVAL_NAME, HAIKU_MODEL),
    ...overrides,
  };
}

describe('judge pending file', () => {
  // A temp path, never the default: that is the file the scheduled judge reads.
  const dir = useTempDir('judge-pending-');
  const pendingFile = (): string => join(dir(), 'pending.jsonl');

  it('reads no records when no post has failed', () => {
    expect(readPendingEvaluations(pendingFile())).toEqual({ records: [], dropped: 0 });
  });

  it('gives back the records a failed post left', () => {
    const records = [pendingRecord(), pendingRecord({ evaluationName: 'coherence', stableEvaluationKey: 'k2' })];

    writePendingEvaluations(records, pendingFile());

    expect(readPendingEvaluations(pendingFile())).toEqual({ records, dropped: 0 });
  });

  it('removes the file once nothing is pending', () => {
    writePendingEvaluations([pendingRecord()], pendingFile());

    writePendingEvaluations([], pendingFile());

    expect(existsSync(pendingFile())).toBe(false);
  });

  it('drops and counts lines it cannot post again with a stable id', () => {
    const { stableEvaluationKey: _key, ...unkeyed } = pendingRecord();
    writeFileSync(pendingFile(), `${JSON.stringify(pendingRecord())}\nnot json\n${JSON.stringify(unkeyed)}\n`);

    const { records, dropped } = readPendingEvaluations(pendingFile());

    expect(records).toEqual([pendingRecord()]);
    expect(dropped).toBe(2);
  });

  it('marks a pending record\'s turn and criterion as judged by its model', () => {
    const keys = new Set<string>();

    addPendingKeys(keys, [pendingRecord()]);

    expect(keys.has(turnJudgedKey(turn, RELEVANCE_EVAL_NAME, HAIKU_MODEL))).toBe(true);
  });
});
