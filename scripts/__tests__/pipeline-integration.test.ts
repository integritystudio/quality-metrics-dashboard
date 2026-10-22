/**
 * M34: the record contract between derive, the judge and sync. Both producers
 * post OTel `gen_ai.evaluation.result` events that sync later reads back from
 * the cloud; these tests pin, across a JSON round trip, the fields it reads.
 * Seed metrics, canaries and dedup are judge-evaluations.test.ts's.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { trackTaskActivity, deriveTaskCompletionPerSession, sessionTasks } from '../derive-evaluations.js';
import { seedEvaluations } from '../judge-evaluations.js';
import { EVALUATION_ATTRS, toOTelRecord, type EvalRecord } from '../eval-record.js';
import { turnKeyOf } from '../judge-dedup.js';
import { TOOL_CORRECTNESS_CRITERIA } from '../judge-criteria.js';
import { evaluatorKindSchema, evaluationCohortSchema } from '../../../src/lib/core/shared-schemas.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';
import { makeToolTurn, SEED_RECORDS } from './support/fixtures.js';
import { SPAN_SESSION, taskSpan } from './support/spans.js';
import { defined } from '../../src/__tests__/support/defined.js';

type WireRecord = { timestamp: string; attributes: Record<string, unknown> };

/** A record as the backend reads it back: the OTel event after a JSON round trip. */
function overTheWire(record: EvalRecord): WireRecord {
  return JSON.parse(JSON.stringify(toOTelRecord(record))) as WireRecord;
}

function derivedTaskCompletion(): EvalRecord {
  trackTaskActivity(taskSpan('TaskCreate', { status: 'pending', id: 'task-1' }));
  trackTaskActivity(taskSpan('TaskUpdate', { status: 'completed', id: 'task-1' }));
  return defined(deriveTaskCompletionPerSession()[0]);
}

function isUnitScore(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

beforeEach(() => {
  sessionTasks.clear();
});

describe('pipeline contract: derive → OTel', () => {
  it('sends a completed task as a rule-scored evaluation whose timestamp keys judge dedup', () => {
    const derived = derivedTaskCompletion();

    const wire = overTheWire(derived);

    expect(wire.timestamp).toBe(derived.timestamp);
    expect(turnKeyOf(wire.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(wire.attributes).toMatchObject({
      [GENAI_EVALUATION_ATTRIBUTES.NAME]: 'task_completion',
      [GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]: 1,
      [GENAI_EVALUATION_ATTRIBUTES.EXPLANATION]: expect.any(String),
      [EVALUATION_ATTRS.PRODUCER]: 'rule',
      [EVALUATION_ATTRS.EVALUATOR_KIND]: 'rule',
      [EVALUATION_ATTRS.COHORT]: 'normal',
      [SESSION_ATTRIBUTES.ID]: SPAN_SESSION,
    });
  });
});

describe('pipeline contract: derive + judge → sync', () => {
  it('sends every derived and seeded record with a 0-1 score and a kind and cohort the backend accepts', () => {
    const records = [derivedTaskCompletion(), ...seedEvaluations([makeToolTurn()], new Set()).evals];

    const attributes = records.map(r => overTheWire(r).attributes);

    expect(attributes.map(a => a[GENAI_EVALUATION_ATTRIBUTES.NAME]))
      .toEqual(['task_completion', ...SEED_RECORDS, TOOL_CORRECTNESS_CRITERIA.name]);
    expect(attributes.filter(a => !isUnitScore(a[GENAI_EVALUATION_ATTRIBUTES.SCORE_VALUE]))).toEqual([]);
    expect(attributes.filter(a => !evaluatorKindSchema.safeParse(a[EVALUATION_ATTRS.EVALUATOR_KIND]).success)).toEqual([]);
    expect(attributes.filter(a => !evaluationCohortSchema.safeParse(a[EVALUATION_ATTRS.COHORT]).success)).toEqual([]);
  });
});
