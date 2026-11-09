/**
 * Map, route and send evaluation records to the ingest worker. Shared by
 * `post-evaluations` (derive and the judge post through it) and the judge's
 * log-event backup (`evaluation-events`).
 *
 * Each record is routed by the account that produced it (`routeRecord`): its
 * own `identityKeyRef` stamp (TKR8 Phase 1), else the stamp of the span it
 * names (Phase 2), else the webhook.
 *
 * - **Keyed**: `POST /v1/ingest/backfill?signal=evaluations` with that
 *   account's API key; ingest assigns the org from the key.
 * - **`null` stamp**: withheld (TKR3, fail closed).
 * - **Unstamped**: the HMAC webhook `POST /v1/evaluations`; rows land in
 *   `HOME_ORG_ID`.
 * - **Key not in the environment**: held, so a later run can send it.
 *
 * The flush dates a row by `evaluatedAtMs` (EVAL-WEBHOOK-EVENT-TIME), and
 * ingest keeps one row per `(org_id, evaluation_id)` (migration 0015), so a
 * re-send is dropped.
 */

import { createHash, createHmac } from 'node:crypto';

import { EVALUATION_ATTRS, EVALUATION_RESULT_EVENT, LEGACY_EVALUATOR_TYPE_ATTR } from './eval-record.js';
import {
  IDENTITY_KEY_REF_FIELD,
  IDENTITY_KEY_REF_PATTERN,
  asString,
  type AccountIndex,
  type AccountRef,
} from './account-stamps.js';
import { runWithRetry } from './pipeline-stages.js';
import { describeFetchError } from '../../src/lib/core/describe-unknown.js';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import {
  WEBHOOK_MAX_BATCH_SIZE,
  WEBHOOK_MAX_EXPLANATION_LENGTH,
  WEBHOOK_MAX_NAME_LENGTH,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
} from '../../src/lib/core/obtool-contract.js';
import { evaluationCohortSchema, INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES } from '../../src/lib/core/shared-schemas.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { getOrThrow } from './collections.js';
import { GENAI_EVALUATION_ATTRIBUTES } from '../../src/lib/otel/genai-attributes.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../src/lib/http-constants.js';

export const INGEST_URL_ENV = 'OBTOOL_INGEST_URL';
export const INGEST_URL_NOT_SET_MESSAGE = `${INGEST_URL_ENV} is not set, so there is no ingest host to send to`;

/** The webhook's batch cap (`obtool-contract.ts`, shared with the ingest worker). */
export const MAX_BATCH_SIZE = WEBHOOK_MAX_BATCH_SIZE;
/**
 * Per-evaluation byte cap. Still module-private in
 * `services/obtool-ingest/src/evaluations.ts`, so this is a copy;
 * `evaluation-delivery.test.ts` asserts it still matches the source.
 */
const MAX_EVALUATION_BYTES = 10_000;

/** Pause between batches so a large first run does not burst the worker. */
export const INTER_BATCH_DELAY_MS = 250;

/** Response body kept in a failed send's log line. */
const RESPONSE_SNIPPET_CHARS = 300;

/** Transient-failure backoff per batch (429, 5xx, and transport errors): the wait before each retry. */
const SEND_RETRY_DELAYS_MS: readonly number[] = [TIME_MS.SECOND / 2, TIME_MS.SECOND, 2 * TIME_MS.SECOND];
const MAX_SEND_ATTEMPTS = SEND_RETRY_DELAYS_MS.length + 1;
/** Per-request ceiling; a hung connection would otherwise stall the whole run. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Recorded on every posted row and backup event. The value keeps the name of
 * the uploader it came from, so rows from before and after stay one series.
 */
export const EVALUATION_SERVICE_NAME = 'dashboard:upload-evaluations';

/**
 * Routing-only field emitted by `toOTelRecord` when an `EvalRecord` sets
 * `stableEvaluationKey`. Never shipped to ingest. When present,
 * `evaluationId()` hashes only its value so the dedup key is stable across
 * derive runs that anchor on a changing last-span.
 */
const STABLE_EVALUATION_KEY_FIELD = 'stableEvaluationKey';
/**
 * Top-level schema URL a record carries (AA3 § Migration, stamped since
 * 2026-10-07). Shipped as `metadata.schemaUrl`, the webhook's only slot for
 * it, so a D1 row records the attribute schema it was written under.
 */
const SCHEMA_URL_FIELD = 'schemaUrl';

const WEBHOOK_PATH = '/v1/evaluations';
const KEYED_PATH = '/v1/ingest/backfill?signal=evaluations';
/** Summary label for records sent through the org-less webhook. */
export const WEBHOOK_DESTINATION = 'webhook';

/** An evaluation id must stay unique across an org's whole history in D1. */
const EVALUATION_ID_LENGTH = 32;

/** The cohorts the webhook's `cohort` field accepts, read from the same schema the ingest validator uses. */
const WEBHOOK_COHORTS: ReadonlySet<string> = new Set(evaluationCohortSchema.options);

export type EvaluationPayload = {
  evaluationName: string;
  evaluator: string;
  evaluatorType: string;
  scoreValue?: number;
  scoreLabel?: string;
  scoreUnit?: string;
  explanation?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  /** Provider-assigned id of the scored response (semconv `gen_ai.response.id`); a correlation id. */
  responseId?: string;
  serviceName?: string;
  /** Sampling population; the webhook rejects a value outside its enum. */
  cohort?: string;
  /** Model id of the LLM judge that produced the score. Its own field since 2026-09-30; was `metadata.judgeModel`. */
  judgeModel?: string;
  /** Client-supplied event time (Unix ms). When set the flush dates the row to
   *  this time instead of the batch-receipt time, so period aggregations are
   *  correct for batched uploads. */
  evaluatedAtMs?: number;
  /** Server-side identity; see `evaluationId`. */
  evaluationId?: string;
  metadata?: Record<string, unknown>;
}

export type MapSkip = 'not-an-evaluation' | 'shipped-as-event' | 'no-name' | 'no-score' | 'too-large';

type MapResult =
  | {
    payload: EvaluationPayload;
    /**
     * The record's own account stamp (TKR8 Phase 1); absent when the record has
     * none. Kept off `payload` on purpose: the stamp routes the record and is
     * never shipped.
     */
    accountRef?: AccountRef;
    skip?: undefined;
  }
  /** A dropped record, and why. */
  | { payload?: undefined; accountRef?: undefined; skip: MapSkip };

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** The record's `attributes` object, or an empty one when it carries none. */
function recordAttributes(r: Record<string, unknown>): Record<string, unknown> {
  return (typeof r.attributes === 'object' && r.attributes !== null)
    ? r.attributes as Record<string, unknown>
    : {};
}

/** The record's event time in ms, or NaN when it has none to parse. */
function recordEventMs(r: Record<string, unknown>): number {
  const timestamp = asString(r.timestamp);
  return timestamp ? Date.parse(timestamp) : NaN;
}

/**
 * The webhook requires one of scoreValue/scoreLabel/errorType; these records
 * only ever carry a numeric score, so a missing one is unshippable.
 */
function scoreValueOf(attrs: Record<string, unknown>): number | undefined {
  const raw = attrs[EVALUATION_ATTRS.SCORE_VALUE];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

type RecordCore = {
  evaluationName: string;
  scoreValue: number;
  cohort: string | undefined;
  tMs: number;
};

/** The fields every payload needs, or the reason this record cannot ship. */
function readCore(r: Record<string, unknown>, attrs: Record<string, unknown>): RecordCore | MapSkip {
  const cohort = asString(attrs[EVALUATION_ATTRS.COHORT]);
  const tMs = recordEventMs(r);

  const evaluationName = asString(attrs[EVALUATION_ATTRS.NAME]);
  if (!evaluationName) return 'no-name';

  const scoreValue = scoreValueOf(attrs);
  if (scoreValue === undefined) return 'no-score';

  return { evaluationName, scoreValue, cohort, tMs };
}

/** Score-shaped optional fields; an absent one is left off the payload entirely. */
function scoreFields(attrs: Record<string, unknown>): Partial<EvaluationPayload> {
  const fields: Partial<EvaluationPayload> = {};
  const scoreUnit = asString(attrs[EVALUATION_ATTRS.SCORE_UNIT]);
  if (scoreUnit) fields.scoreUnit = scoreUnit;
  const scoreLabel = asString(attrs[EVALUATION_ATTRS.SCORE_LABEL]);
  if (scoreLabel) fields.scoreLabel = truncate(scoreLabel, WEBHOOK_MAX_NAME_LENGTH);
  const explanation = asString(attrs[EVALUATION_ATTRS.EXPLANATION]);
  if (explanation) fields.explanation = truncate(explanation, WEBHOOK_MAX_EXPLANATION_LENGTH);
  // Top-level since 2026-09-30 so readers populate EvaluationResult.judgeModel; the
  // metadata copy it replaced was never read back (JUDGE-MODEL-METADATA-ONLY).
  const judgeModel = asString(attrs[EVALUATION_ATTRS.JUDGE_MODEL]);
  if (judgeModel) fields.judgeModel = truncate(judgeModel, WEBHOOK_MAX_NAME_LENGTH);
  return fields;
}

/**
 * Correlation ids. Trace and span are the record's own context, the operation evaluated (semconv).
 * The hook's bare `trace.id` / `span.id` attributes are not read: they name the judge's call, not that operation.
 */
function idFields(r: Record<string, unknown>, attrs: Record<string, unknown>): Partial<EvaluationPayload> {
  const fields: Partial<EvaluationPayload> = {};
  const traceId = asString(r.traceId);
  if (traceId) fields.traceId = traceId;
  const spanId = asString(r.spanId);
  if (spanId) fields.spanId = spanId;
  const sessionId = asString(attrs[EVALUATION_ATTRS.SESSION_ID]);
  if (sessionId) fields.sessionId = sessionId;
  const responseId = asString(attrs[EVALUATION_ATTRS.RESPONSE_ID]);
  if (responseId) fields.responseId = responseId;
  return fields;
}

/**
 * Fields the webhook has no slot for ride in `metadata`, which the flush keeps
 * in the row's `attributes`. evaluatedAt keeps the ISO string form for auditability.
 */
function recordMetadata(r: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const timestamp = asString(r.timestamp);
  if (timestamp) metadata.evaluatedAt = timestamp;
  const schemaUrl = asString(r[SCHEMA_URL_FIELD]);
  if (schemaUrl) metadata.schemaUrl = schemaUrl;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Explanation is the only unbounded-ish field left, so it is dropped and the size retried once. */
function fitsWebhookLimit(payload: EvaluationPayload): boolean {
  if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_EVALUATION_BYTES) return true;
  delete payload.explanation;
  return Buffer.byteLength(JSON.stringify(payload)) <= MAX_EVALUATION_BYTES;
}

function buildPayload(core: RecordCore, r: Record<string, unknown>, attrs: Record<string, unknown>): EvaluationPayload {
  const evaluator = asString(attrs[EVALUATION_ATTRS.PRODUCER])
    ?? asString(attrs[GENAI_EVALUATION_ATTRIBUTES.EVALUATOR])
    ?? 'unknown';
  const evaluatorType = asString(attrs[EVALUATION_ATTRS.EVALUATOR_KIND])
    ?? asString(attrs[LEGACY_EVALUATOR_TYPE_ATTR])
    ?? 'rule';

  const payload: EvaluationPayload = {
    evaluationName: truncate(core.evaluationName, WEBHOOK_MAX_NAME_LENGTH),
    evaluator: truncate(evaluator, WEBHOOK_MAX_NAME_LENGTH),
    evaluatorType: truncate(evaluatorType, WEBHOOK_MAX_NAME_LENGTH),
    scoreValue: core.scoreValue,
    serviceName: EVALUATION_SERVICE_NAME,
    ...scoreFields(attrs),
    ...idFields(r, attrs),
  };

  // Only the webhook's enum values: one outside it would get the whole batch rejected.
  if (core.cohort && WEBHOOK_COHORTS.has(core.cohort)) payload.cohort = core.cohort;
  // Supply evaluatedAtMs so the flush dates the row to when the evaluation
  // was produced, not when this batch arrived (EVAL-WEBHOOK-EVENT-TIME).
  if (!Number.isNaN(core.tMs)) payload.evaluatedAtMs = core.tMs;
  const metadata = recordMetadata(r);
  if (metadata) payload.metadata = metadata;
  payload.evaluationId = evaluationId(r);
  return payload;
}

/**
 * Map one record, as `toOTelRecord` writes it, to a webhook payload. Derive's
 * records carry only the legacy overloaded `evaluator.type`; the judge's carry
 * cohort and kind.
 */
export function mapRecord(record: unknown): MapResult {
  if (typeof record !== 'object' || record === null) return { skip: 'not-an-evaluation' };
  const r = record as Record<string, unknown>;
  if (r.name !== EVALUATION_RESULT_EVENT) return { skip: 'not-an-evaluation' };
  // Only `appendEvaluation` stamps an id, and it also writes the record as a log event the span
  // shipper carries under the writer's own key (HDF12); a webhook copy would only be dropped (RSR3).
  if (stampedEvaluationId(r)) return { skip: 'shipped-as-event' };

  const attrs = recordAttributes(r);
  const core = readCore(r, attrs);
  if (typeof core === 'string') return { skip: core };

  const payload = buildPayload(core, r, attrs);
  if (!fitsWebhookLimit(payload)) return { skip: 'too-large' };

  if (IDENTITY_KEY_REF_FIELD in r) {
    const raw = r[IDENTITY_KEY_REF_FIELD];
    return { payload, accountRef: typeof raw === 'string' ? raw : null };
  }
  return { payload };
}

/**
 * The id the ingest worker dedups on (`evaluation_id`, migration 0015): a
 * re-send of a record it already stored is dropped server-side.
 *
 * Content-derived, span id included: two parallel spans scored in the same
 * millisecond differ only there, and are two evaluations. Only the account stamp is left out — it routes the record, and a
 * cloud-sourced derive stamps records the local one could not, so including it
 * would give the same evaluation two ids.
 *
 * A record the hooks stamped with `integritystudio.evaluation.id` (HDF12) keeps
 * that id verbatim: ingest projects its log event into the table under that id.
 * `mapRecord` no longer sends such a record (`shipped-as-event`), so this branch
 * only keeps any other caller's id consistent with the row ingest already holds.
 */
export function evaluationId(record: Record<string, unknown>): string {
  const stampedId = stampedEvaluationId(record);
  if (stampedId) return stampedId;
  const { [IDENTITY_KEY_REF_FIELD]: _stamp, [STABLE_EVALUATION_KEY_FIELD]: stableKey, ...rest } = record;
  if (typeof stableKey === 'string' && stableKey.length > 0) {
    return createHash('sha256').update(stableKey).digest('hex').slice(0, EVALUATION_ID_LENGTH);
  }
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, EVALUATION_ID_LENGTH);
}

/** The shape `appendEvaluation` writes; anything else falls back to the content hash rather than collapse rows. */
const STAMPED_EVALUATION_ID_PATTERN = new RegExp(`^[0-9a-f]{${EVALUATION_ID_LENGTH}}$`);

function stampedEvaluationId(record: Record<string, unknown>): string | undefined {
  const attrs = record.attributes;
  if (typeof attrs !== 'object' || attrs === null) return undefined;
  const id = (attrs as Record<string, unknown>)[INTEGRITYSTUDIO_EVALUATION_ATTRIBUTES.ID];
  return typeof id === 'string' && STAMPED_EVALUATION_ID_PATTERN.test(id) ? id : undefined;
}

/** Where one record goes. */
export type Route =
  | { kind: 'keyed'; ref: string }
  | { kind: 'withheld' }
  | { kind: 'webhook' };

function routeForRef(ref: AccountRef): Route {
  if (ref === null) return { kind: 'withheld' };
  // A ref that is not an identity-map secret name is not read from the
  // environment; the record ships as it did before stamping existed.
  return IDENTITY_KEY_REF_PATTERN.test(ref) ? { kind: 'keyed', ref } : { kind: 'webhook' };
}

/** How a record's route was decided: its own stamp, its span's stamp, or the unstamped fallback. */
export type RouteBasis = 'stamp' | 'span' | 'join';

/**
 * Route a mapped record. Its own stamp wins outright — it names the account of
 * the span or turn that was scored. Next, the stamp of the span it names.
 * A record with neither routes to the webhook destination, as spans do (TKR9).
 */
export function routeRecord(mapped: MapResult, index: AccountIndex): { route: Route; basis: RouteBasis } {
  if (mapped.accountRef !== undefined) return { route: routeForRef(mapped.accountRef), basis: 'stamp' };
  const spanId = mapped.payload?.spanId;
  if (spanId && index.bySpan.has(spanId)) return { route: routeForRef(getOrThrow(index.bySpan, spanId)), basis: 'span' };
  return { route: { kind: 'webhook' }, basis: 'join' };
}

function signature(payload: string, secret: string): string {
  return `${WEBHOOK_SIGNATURE_PREFIX}${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

type SendRequest = { url: string; headers: Record<string, string>; body: string }

export function webhookRequest(baseUrl: string, batch: EvaluationPayload[], secret: string): SendRequest {
  const body = JSON.stringify({ evaluations: batch });
  return {
    url: `${baseUrl}${WEBHOOK_PATH}`,
    headers: { [CONTENT_TYPE_HEADER]: ContentType.Json, [WEBHOOK_SIGNATURE_HEADER]: signature(body, secret) },
    body,
  };
}

/** The org comes from the key, so this is the path that keeps accounts apart. */
export function keyedRequest(baseUrl: string, batch: EvaluationPayload[], apiKey: string): SendRequest {
  return {
    url: `${baseUrl}${KEYED_PATH}`,
    headers: { [CONTENT_TYPE_HEADER]: ContentType.Ndjson, Authorization: `Bearer ${apiKey}` },
    body: `${batch.map((p) => JSON.stringify(p)).join('\n')}\n`,
  };
}

type SendResult = { ok: boolean; detail: string; retryable: boolean }

/** `{ k=v … }` summary for a counts record; yields `'none'` for an empty map. */
export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
}

/** Destination key for a route: the env-var ref for keyed routes, or `WEBHOOK_DESTINATION`. */
export function destinationFor(route: Route): string {
  return route.kind === 'keyed' ? route.ref : WEBHOOK_DESTINATION;
}

export type Delivery =
  | { kind: 'send'; destination: string }
  | { kind: 'withheld' }
  | { kind: 'held-for-key'; ref: string };

export function deliveryFor(route: Route, env: NodeJS.ProcessEnv = process.env): Delivery {
  if (route.kind === 'withheld') return { kind: 'withheld' };
  if (route.kind === 'keyed' && !asString(env[route.ref])) return { kind: 'held-for-key', ref: route.ref };
  return { kind: 'send', destination: destinationFor(route) };
}

/**
 * Resolve the ingest base URL and HMAC secret from the environment. `asString`,
 * not `??`: an empty OBTOOL_INGEST_URL must read as unset, and `??` would keep
 * the empty string and POST to `/v1/...`.
 */
export function resolveSendConfig(): { baseUrl: string | undefined; secret: string | undefined } {
  return {
    baseUrl: asString(process.env[INGEST_URL_ENV]),
    secret: asString(process.env.INJECT_HMAC_SECRET),
  };
}

/**
 * One POST attempt. Never throws: a transport failure is returned as a
 * retryable result, so the caller's batch loop decides what happens next.
 */
async function postBatchOnce(request: SendRequest): Promise<SendResult> {
  try {
    // HTTP/1.1: over the built-in fetch's HTTP/2 session, one destroyed
    // session failed every later send (NODE-FETCH-HTTP2-DEAD-SESSION).
    const response = await http1Fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      // Without this a hung connection stalls the run indefinitely.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      detail: `${response.status} ${text.slice(0, RESPONSE_SNIPPET_CHARS)}`,
      // 4xx other than 429 is a payload problem — retrying re-sends the same
      // bytes to the same verdict, so only throttling and server faults retry.
      retryable: response.status === HttpStatus.TooManyRequests || response.status >= HttpStatus.InternalServerError,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `transport: ${describeFetchError(err)}`,
      retryable: true,
    };
  }
}

/**
 * Send one batch to a destination from `destinationFor`. A keyed destination
 * is read from the environment, so callers must have checked the key is set
 * (the held-for-key rule); the webhook needs `secret`.
 */
export async function sendBatch(
  destination: string,
  payloads: EvaluationPayload[],
  baseUrl: string | undefined,
  secret: string | undefined,
): Promise<SendResult> {
  if (baseUrl === undefined) throw new Error(INGEST_URL_NOT_SET_MESSAGE);
  if (destination === WEBHOOK_DESTINATION) {
    if (secret === undefined) throw new Error('The webhook destination needs INJECT_HMAC_SECRET');
    return postBatch(webhookRequest(baseUrl, payloads, secret));
  }
  const apiKey = process.env[destination];
  if (apiKey === undefined) throw new Error(`${destination} is not set; check held-for-key before sending`);
  return postBatch(keyedRequest(baseUrl, payloads, apiKey));
}

/** Retry transient failures with exponential backoff; log once on exhaustion. */
export async function postBatch(request: SendRequest): Promise<SendResult> {
  const last = await runWithRetry<SendResult>({
    attempt: async () => postBatchOnce(request),
    shouldRetry: (result) => !result.ok && result.retryable,
    delaysMs: SEND_RETRY_DELAYS_MS,
    onRetry: (waitMs, failedAttempt, totalAttempts, result) => {
      console.warn(`[ingest] attempt ${failedAttempt}/${totalAttempts} failed (${result.detail}) — retrying in ${waitMs}ms`);
    },
  });
  if (!last.ok && last.retryable) {
    console.error(`[ingest] giving up after ${MAX_SEND_ATTEMPTS} attempts: ${last.detail}`);
  }
  return last;
}
