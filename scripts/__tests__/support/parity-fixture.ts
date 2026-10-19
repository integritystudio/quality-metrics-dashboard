import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { CloudBackend } from '../../../../src/backends/cloud.js';
import type { EvaluationResult } from '../../../../src/backends/index.js';
import {
  createFixtureServer,
  evalToWire,
  type EvalWireRow,
  type FixtureServer,
  type TraceWireRow,
} from '../../../src/__tests__/support/fixture-server.js';
import { computeOrgEntries, type OrgComputation } from '../../sync-to-kv.js';

/** The `evaluator_type` of a row with no kind: it reads back with neither a kind nor a legacy type. */
const NO_EVALUATOR_TYPE = '';

/** The sync reads the fixture as a non-home org: no local calibration or degradation state. */
const IS_HOME_ORG = false;

/**
 * An evaluation as the `/v1/evaluations` row that CloudBackend reads back to it.
 * The kind rides in `evaluator_type` and the cohort in `attributes`; the legacy
 * `evaluatorType`, `judgeModel` and residual attributes are not carried.
 */
export function evaluationToWire(evaluation: EvaluationResult, id: number): EvalWireRow {
  const row = evalToWire({
    evaluationName: evaluation.evaluationName,
    timestamp: evaluation.timestamp,
    traceId: evaluation.traceId,
    spanId: evaluation.spanId,
    sessionId: evaluation.sessionId,
    evaluator: evaluation.evaluator,
    scoreLabel: evaluation.scoreLabel,
    explanation: evaluation.explanation,
    agentName: evaluation.agentName,
    trajectoryLength: evaluation.trajectoryLength,
    evaluatorType: evaluation.evaluatorKind ?? NO_EVALUATOR_TYPE,
  }, id);
  return {
    ...row,
    score_value: evaluation.scoreValue ?? null,
    ...(evaluation.cohort !== undefined && { attributes: JSON.stringify({ cohort: evaluation.cohort }) }),
  };
}

export type ParityRows = {
  evaluations: EvaluationResult[];
  spans?: TraceWireRow[];
}

export type ParityFixture = {
  /** The sync's reader: a real CloudBackend over the same fixture server the dev routes read. */
  syncBackend: () => CloudBackend;
}

/**
 * Serves `rows` from a local obtool-api fixture for the whole file, windowed by
 * date as the API reads. The dev routes reach it through the data-loader (via
 * `OBTOOL_API_URL`, set before their first read) and the sync through
 * {@link ParityFixture.syncBackend}, so both sides read identical wire data.
 */
export function serveParityFixture(rows: ParityRows): ParityFixture {
  let fixture: FixtureServer | undefined;
  let backend: CloudBackend | undefined;
  const previousApiUrl = process.env.OBTOOL_API_URL;

  beforeAll(async () => {
    fixture = await createFixtureServer({ dateWindow: true });
    process.env.OBTOOL_API_URL = fixture.url;
    // obtool-api serves the newest id first: descending ids keep fixture order as served order.
    fixture.setEvals(rows.evaluations.map((evaluation, index) => evaluationToWire(evaluation, rows.evaluations.length - index)));
    fixture.setTraces(rows.spans ?? []);
    backend = new CloudBackend({ baseUrl: fixture.url });
  });

  afterAll(async () => {
    if (previousApiUrl === undefined) delete process.env.OBTOOL_API_URL;
    else process.env.OBTOOL_API_URL = previousApiUrl;
    await fixture?.close();
  });

  return {
    syncBackend() {
      if (!backend) throw new Error('serveParityFixture: syncBackend() called before beforeAll');
      return backend;
    },
  };
}

/**
 * Before each test, pins `Date` to `now` and runs the sync over the fixture;
 * returns an accessor for that test's result.
 */
export function syncEachTest(fixture: ParityFixture, now: Date): () => OrgComputation {
  let synced: OrgComputation | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    synced = await computeOrgEntries(fixture.syncBackend(), now, IS_HOME_ORG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  return () => {
    if (!synced) throw new Error('syncEachTest: result read before beforeEach');
    return synced;
  };
}

/** The parsed value the sync wrote under `key`, or `undefined` when it wrote none. */
export function kvValue<T = unknown>(result: OrgComputation, key: string): T | undefined {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as T : undefined;
}
