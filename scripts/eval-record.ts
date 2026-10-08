/**
 * The evaluation record derive and the judge write, and its OTel log-record
 * serialization. Split out of judge-evaluations.ts so a stage that only writes
 * records does not load the judge.
 */

import type { EvaluatorType, EvaluatorKind, EvaluationCohort } from '../../src/lib/validation/dashboard-schemas.js';
import { IDENTITY_KEY_REF_FIELD, type AccountRef } from './account-stamps.js';

export const SESSION_ID_PREVIEW_LEN = 8;

export const EVAL_SCORE_PRECISION = 4;

/** Decimal places in a record's fallback reason line. Restated here rather than
 * imported from `src/lib/constants.ts`, which is Vite-only and unreachable from scripts. */
export const SCORE_PREVIEW_DECIMALS = 2;

/** Producer recorded on every record this script writes. */
export const PRODUCER = 'dashboard:judge-evaluations';

export const SEED_EVALUATOR_TYPE = 'seed';

export const RULE_EVALUATOR_TYPE = 'rule';

export const TRACE_BACKFILL_EVALUATOR_TYPE = 'trace-backfill';

/**
 * A seeded or canary score is a SHA-256 of the session and turn key mapped into
 * a range — deterministic and reproducible, with no model and no relationship
 * to the content being scored. That makes its *kind* `rule`; what marks it as
 * not-real-data is the cohort, never the kind (OBP16).
 */
export const SYNTHETIC_EVALUATOR_KIND: EvaluatorKind = 'rule';

export const LLM_EVALUATOR_KIND: EvaluatorKind = 'llm';

/**
 * The legacy `evaluatorType` value for a kind, or `undefined` when the kind has
 * none. Three of the four kinds are also members of the older enum; the fourth,
 * `ground_truth`, is not, and is left unset rather than coerced.
 */
export function legacyEvaluatorType(kind: EvaluatorKind): EvaluatorType | undefined {
  return kind === 'ground_truth' ? undefined : kind;
}

export const NORMAL_COHORT: EvaluationCohort = 'normal';

export const SEED_COHORT: EvaluationCohort = 'seed';

export const BACKFILL_COHORT: EvaluationCohort = 'backfill';

/**
 * On-disk attribute keys. **Every key the hooks also write must stay identical
 * to their `EVALUATION_ATTRS` (`hooks/lib/evaluation-attrs.ts`, re-exported by
 * `quality-signals.ts`)** — both writers append to the same
 * `evaluations-YYYY-MM-DD.jsonl` files, so a divergence splits the corpus into
 * two shapes that no single reader handles.
 *
 * Two optional keys here have no hooks counterpart, on purpose:
 * - `SCORE_UNIT`: the hooks dropped theirs (OBP20) because all their scores are
 *   `ratio_0_1`, but derive's `evaluation_latency` is in `seconds`.
 * - `JUDGE_MODEL`: the hooks dropped theirs (OBP22) because their records link to
 *   a judge span that carries `gen_ai.request.model`; this judge records no span.
 *
 * Custom keys live under `integritystudio.*`: OTel semconv defines none of them
 * and advises against inventing keys under a namespace it owns. That is why
 * `gen_ai.evaluation.evaluator{,.type}` were dropped here (OBP16) and the score
 * unit moved off `gen_ai.evaluation.score.unit` on 2026-09-29.
 */
export const EVALUATION_ATTRS = {
  NAME: 'gen_ai.evaluation.name',
  SCORE_VALUE: 'gen_ai.evaluation.score.value',
  SCORE_LABEL: 'gen_ai.evaluation.score.label',
  SCORE_UNIT: 'integritystudio.evaluation.score.unit',
  EXPLANATION: 'gen_ai.evaluation.explanation',
  EVALUATOR_KIND: 'integritystudio.evaluation.evaluator.kind',
  COHORT: 'integritystudio.evaluation.cohort',
  PRODUCER: 'integritystudio.evaluation.producer',
  JUDGE_MODEL: 'integritystudio.evaluation.judge.model',
  SESSION_ID: 'session.id',
  /** Semconv fallback link to the scored response when no span id is known (TKR8 Phase 2). */
  RESPONSE_ID: 'gen_ai.response.id',
} as const;

/** Legacy overloaded key, read-only — still present on every pre-OBP16 record. */
export const LEGACY_EVALUATOR_TYPE_ATTR = 'gen_ai.evaluation.evaluator.type';

/** COMPAT until 2026-10-29: the score unit's key on records written before 2026-09-29. Read-only. */
export const LEGACY_SCORE_UNIT_ATTR = 'gen_ai.evaluation.score.unit';

export const EVALUATION_RESULT_EVENT = 'gen_ai.evaluation.result';

/**
 * Schema URL stamped on every record `toOTelRecord` writes. Mirrors
 * `EVALUATION_SCHEMA_URL` in the hooks' `evaluation-attrs.ts` (the canonical
 * copy); the two must bump together. A record-level field rather than an
 * attribute, because the evaluations JSONL has no scope envelope. The file it
 * names is served by the IntegrityLandingPage site.
 */
export const EVALUATION_SCHEMA_URL = 'https://integritystudio.ai/schemas/evaluation/1.0.0';

export function normalizeScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/** Canonical evaluation record. Also used by derive-evaluations.ts. */
export interface EvalRecord {
  timestamp: string;
  evaluationName: string;
  scoreValue: number;
  /** Categorical verdict beside the score (`pass`/`fail`, `relevant`/`off-topic`, …); omitted when the producer assigns none. */
  scoreLabel?: string;
  /** e.g. 'seconds', 'ratio_0_1'; omitted when the score is unitless. */
  scoreUnit?: string;
  explanation: string;
  /** Producer — which component wrote this. Never a model id (OBP16). */
  evaluator: string;
  /**
   * @deprecated Overloaded field, kept so the query/export surface keeps
   * filtering. Mirrors `evaluatorKind` where the two enums overlap, and is
   * omitted for `ground_truth`, which has no legacy value — mapping it onto one
   * would be the same misstatement OBP16 removed.
   */
  evaluatorType?: EvaluatorType;
  /** How the score was produced. */
  evaluatorKind: EvaluatorKind;
  /** Whether the score describes real data. */
  cohort: EvaluationCohort;
  /** Judge model — omitted for any score no model produced. */
  judgeModel?: string;
  traceId: string;
  sessionId: string;
  /**
   * Account of the span or turn this scores, copied from its hook stamp (TKR8
   * Phase 1): a secret name, `null` for an unmapped account, absent when the
   * source carried none. Written as a record field, never an attribute, so it
   * routes the upload and is never shipped.
   */
  identityKeyRef?: AccountRef;
  /**
   * The span this scores (TKR8 Phase 2): written top-level beside `traceId`, as
   * an OTel log record's span context, so the evaluation is parented to it.
   */
  spanId?: string;
  /** The scored response's id, set only when `spanId` is unknown (semconv fallback). */
  responseId?: string;
}

export function toOTelRecord(ev: EvalRecord): object {
  const attrs: Record<string, unknown> = {
    [EVALUATION_ATTRS.NAME]: ev.evaluationName,
    [EVALUATION_ATTRS.SCORE_VALUE]: ev.scoreValue,
    [EVALUATION_ATTRS.EXPLANATION]: ev.explanation,
    [EVALUATION_ATTRS.EVALUATOR_KIND]: ev.evaluatorKind,
    [EVALUATION_ATTRS.COHORT]: ev.cohort,
    [EVALUATION_ATTRS.PRODUCER]: ev.evaluator,
    ...(ev.judgeModel && { [EVALUATION_ATTRS.JUDGE_MODEL]: ev.judgeModel }),
  };
  if (ev.scoreUnit) attrs[EVALUATION_ATTRS.SCORE_UNIT] = ev.scoreUnit;
  if (ev.scoreLabel) attrs[EVALUATION_ATTRS.SCORE_LABEL] = ev.scoreLabel;
  if (ev.responseId) attrs[EVALUATION_ATTRS.RESPONSE_ID] = ev.responseId;
  if (ev.sessionId) attrs[EVALUATION_ATTRS.SESSION_ID] = ev.sessionId;
  return {
    timestamp: ev.timestamp,
    name: EVALUATION_RESULT_EVENT,
    attributes: attrs,
    // Envelope metadata, as the hooks' appendEvaluation writes it (AA3
    // § Migration). Safe to add here since derive posts straight to ingest
    // (cloud-read Phase 6) and never re-fingerprints a file.
    schemaUrl: EVALUATION_SCHEMA_URL,
    // Omit rather than emit '' — TraceIdSchema is optional but rejects an
    // empty string, so a written '' is silently dropped on read.
    ...(ev.traceId && { traceId: ev.traceId }),
    // Org-scoping P4: local derive/judge read the owner's own telemetry JSONL,
    // which carries no org dimension — everything they emit is by definition
    // the home org's data, so stamp the constant rather than "group by org"
    // (docs/roadmap/org-scoped-multi-tenancy.md, Phase 4). Omitted when the
    // env is unset so pre-tenancy behavior is byte-identical.
    ...(process.env.HOME_ORG_ID && { org_id: process.env.HOME_ORG_ID }),
    // `spanId` then the stamp, last and in this order, so upload's fingerprint
    // can drop both and recover the exact line this record serialized to
    // before either existed (derive rewrites its records every run).
    ...(ev.spanId && { spanId: ev.spanId }),
    ...(ev.identityKeyRef !== undefined && { [IDENTITY_KEY_REF_FIELD]: ev.identityKeyRef }),
  };
}
