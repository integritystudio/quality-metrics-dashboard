#!/usr/bin/env tsx
/**
 * Ship locally-derived evaluations to the cloud `evaluations` table.
 *
 * **This closes the seam that killed the dashboard.** The hooks and the judge
 * write `evaluations-<date>.jsonl` into `TELEMETRY_DIR`; `sync-to-kv` reads the
 * *cloud* (`CloudBackend.queryEvaluations`, which
 * defaults to the `'table'` source — the D1 `evaluations` table). Nothing
 * connected the two: the detached span shipper
 * (`~/.claude/hooks/lib/span-shipper.ts`) matches only
 * `(traces|logs|metrics)-<date>.jsonl`, and the `evaluations` table is fed
 * solely by the HMAC webhook and `obs_inject_evaluations`. Without this stage
 * local evaluations stay on disk and every sync computes an empty dashboard.
 *
 * Transport is chosen per record by the account that produced it (TKR7). The
 * hooks stamp every span with `identityKeyRef` — the identity map's secret name
 * for the signed-in account, or `null` for an unmapped one (TKR6). Since TKR8
 * Phase 1, `derive-evaluations` and `judge-evaluations` copy the stamp of the
 * span or turn they score onto the evaluation record itself, and that stamp
 * routes it. A record without a stamp that names its span (Phase 2: derive and
 * judge records, and the hooks' judge-span `span.id`) takes that span's stamp,
 * which is just as exact. Anything else was written before Phase 1, so it is
 * joined to its source spans instead — by trace id, then by session id when the
 * session saw only one account. The summary's `routedBy[stamp=… span=… join=…]`
 * shows how much still takes the join; once it reads `join=0` the join can be
 * deleted.
 *
 * - **Attributed**: `POST /v1/ingest/backfill?signal=evaluations` with that
 *   account's API key, read from the environment under the ref's name. Ingest
 *   assigns the org from the key, and the flush reads the same line schema as
 *   the webhook's.
 * - **`null`**: withheld and recorded as consumed (TKR3's fail-closed rule).
 * - **Unattributed** (pre-TKR6 spans, or a session that switched account with
 *   no trace hit): the HMAC webhook `POST /v1/evaluations`, as before. It
 *   carries no per-org identity, so rows land in `HOME_ORG_ID`.
 * - **Key not in the environment**: held, so the next run retries it.
 *
 * ## Two properties a caller must know
 *
 * 1. **Event time comes from `evaluatedAtMs`.** Since EVAL-WEBHOOK-EVENT-TIME
 *    (v3.1.17) the flush dates a row by the record's own time. Rows shipped
 *    before that carry receipt time; their real time is `metadata.evaluatedAt`.
 *    `--max-age-hours` is now a bound on how far back a normal run looks.
 * 2. **The shipped index is load-bearing, and must not be a byte offset.** Every
 *    payload carries `evaluationId`, and ingest drops an id the org already
 *    holds (migration 0015), so a re-send of anything shipped since then is a
 *    no-op. Rows shipped before it have no id, and re-sending one of those
 *    inserts a duplicate, since the only other key is `(r2_key, batch_index)`
 *    and every POST allocates a fresh `r2_key`. This tracks a content
 *    fingerprint per record rather than a file offset, so the resume point
 *    does not depend on where a record sits in its file.
 *
 * Usage:
 *   tsx scripts/upload-evaluations.ts                  # ship the default window
 *   tsx scripts/upload-evaluations.ts --dry-run        # preview, no POSTs, no cursor write
 *   tsx scripts/upload-evaluations.ts --days=7         # widen the file window
 *   tsx scripts/upload-evaluations.ts --limit=50       # stop after N records
 *   tsx scripts/upload-evaluations.ts --max-age-hours=48
 *   tsx scripts/upload-evaluations.ts --days=11 --only-keys=manifest.jsonl
 *
 * Derive posts every record itself and writes no file (cloud-read Phase 6), so
 * what this script carries is the records only it delivers:
 * `hook:stop-session-summary`, `hook:stop-quality-evaluation` and
 * `survival-fitness`. The judge posts its own records too (Phase 4) but still
 * appends them to these files, so a judge record young enough to pass the age
 * guard is sent again here, and ingest drops it on its `evaluationId`.
 *
 * `--only-keys` re-ships exactly the records a manifest names, for replacing
 * rows deleted from D1 (docs/roadmap/builtin-key-eval-cleanup.md). Each line
 * of the manifest is `{ref, evaluationName, traceId, evaluatedAtMs}`: a record
 * is sent only when its (name, trace, event time) is listed, always keyed with
 * the listed account's key so it lands in the org the deleted row came from,
 * and without the `--max-age-hours` guard, because the flush dates rows by
 * `evaluatedAtMs`. Everything else in the window is left untouched and
 * unrecorded, so the next normal run treats it exactly as before.
 *
 * Env: INJECT_HMAC_SECRET (required), OBTOOL_INGEST_URL (optional), and one
 * `OBTOOL_API_KEY*` per mapped account (all present under `doppler run … prd`).
 */

import { createHash, createHmac } from 'crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

import {
  BACKFILL_COHORT,
  EVALUATION_ATTRS,
  EVALUATION_RESULT_EVENT,
  LEGACY_EVALUATOR_TYPE_ATTR,
  LEGACY_SCORE_UNIT_ATTR,
  NORMAL_COHORT,
  SEED_COHORT,
} from './eval-record.js';
import { CANARY_COHORT, CANARY_EVALUATOR_TYPE, TELEMETRY_DIR } from './evaluation-constants.js';
import {
  ACCOUNT_INDEX_WINDOW_DAYS,
  IDENTITY_KEY_REF_FIELD,
  IDENTITY_KEY_REF_PATTERN,
  asString,
  buildAccountIndex,
  fileInWindow,
  type AccountIndex,
  type AccountRef,
} from './account-stamps.js';
import { DRY_RUN_FLAG, UPLOAD_EXIT_SEND_FAILED } from './pipeline-stages.js';
import { CliArgError, parseCli, positiveIntArg, positiveNumberArg, type CliSpec } from './cli-args.js';
import { describeFetchError, http1Fetch } from '../../src/lib/core/http1-fetch.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { sleep } from './sleep.js';

export { buildAccountIndex, type AccountIndex, type AccountRef };

/** Default ingest host. Mirrors `INGEST_API_URL` in src/tools/inject-evaluations.ts. */
export const DEFAULT_INGEST_URL = 'https://ingest.integritystudio.ai';

/**
 * Webhook caps, mirrored from `services/obtool-ingest/src/evaluations.ts`.
 * They are module-private there, so this is a copy rather than an import; the
 * copy is deliberately the *stricter* webhook set, not the looser MCP set in
 * `src/lib/validation/api-schemas.ts`. `upload-evaluations.test.ts` asserts
 * they still match the source.
 */
export const MAX_BATCH_SIZE = 100;
const MAX_EVALUATION_BYTES = 10_000;
const WEBHOOK_MAX_NAME_LENGTH = 255;
const WEBHOOK_MAX_EXPLANATION_LENGTH = 2000;

/**
 * File-name window, in days. Matches `SHIP_DAYS` in the span shipper so both
 * transports have the same blind spot rather than two different ones.
 */
const DEFAULT_WINDOW_DAYS = 2;

/**
 * Refuse records older than this. Guards property (1) above: a record shipped
 * later than this would be mis-dated by more than the window the dashboard's
 * shortest period (24h) can tolerate.
 */
const DEFAULT_MAX_AGE_HOURS = 36;


/** Pause between batches so a large first run does not burst the worker. */
export const INTER_BATCH_DELAY_MS = 250;
/** Response body kept in a failed send's log line. */
const RESPONSE_SNIPPET_CHARS = 300;

/** Transient-failure retry budget per batch (429, 5xx, and transport errors). */
const MAX_SEND_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
/** Per-request ceiling; a hung connection would otherwise stall the whole run. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Recorded on every row this script ships, so cloud rows are attributable. */
const UPLOAD_SERVICE_NAME = 'dashboard:upload-evaluations';

/**
 * `evaluations-YYYY-MM-DD.jsonl`, written by the hooks and the judge. Derive's
 * old `derived-evaluations-<date>.jsonl` files are not read: their records are
 * all older than the age guard. The date is the one capture group
 * `fileInWindow` reads.
 */
const EVAL_FILE_PATTERN = /^evaluations-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Top-level span id a record may carry: derive and judge records (TKR8 Phase 2). */
const SPAN_ID_FIELD = 'spanId';
/**
 * Top-level schema URL a record carries (AA3 § Migration, stamped since
 * 2026-10-07). Shipped as `metadata.schemaUrl`, the webhook's only slot for
 * it, so a D1 row records the attribute schema it was written under.
 */
const SCHEMA_URL_FIELD = 'schemaUrl';

const WEBHOOK_PATH = '/v1/evaluations';
const KEYED_PATH = '/v1/ingest/backfill?signal=evaluations';
const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
/** Summary label for records sent through the org-less webhook. */
export const WEBHOOK_DESTINATION = 'webhook';

const STATE_FILENAME = '.eval-upload-state.json';

/** Truncated sha256 is enough to separate records within a two-day window. */
const FINGERPRINT_LENGTH = 16;
/**
 * Unlike the fingerprint, an evaluation id must stay unique across an org's
 * whole history in D1, not one two-day window, so it keeps twice the bits.
 */
const EVALUATION_ID_LENGTH = 32;

/** Fingerprints already shipped, grouped by source file so they prune together. */
export type ShippedIndex = Record<string, string[]>;

/** The cohorts the webhook's `cohort` field accepts (the parent's `evaluationCohortSchema`). */
const WEBHOOK_COHORTS: ReadonlySet<string> = new Set([NORMAL_COHORT, SEED_COHORT, CANARY_COHORT, BACKFILL_COHORT]);

export interface EvaluationPayload {
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

export interface MapResult {
  payload?: EvaluationPayload;
  /**
   * The record's own account stamp (TKR8 Phase 1); absent when the record has
   * none. Kept off `payload` on purpose: the stamp routes the record and is
   * never shipped.
   */
  accountRef?: AccountRef;
  /** Why the record was dropped; absent when `payload` is set. */
  skip?: 'not-an-evaluation' | 'canary' | 'no-name' | 'no-score' | 'too-large' | 'too-old';
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Map one on-disk record to a webhook payload.
 *
 * Three producers write these files with three different attribute sets —
 * `derive-evaluations` (legacy overloaded `evaluator.type`, no cohort, no
 * trace id), `hook:stop-session-summary` (cohort + kind), and
 * `hook:stop-quality-evaluation` (cohort + kind + `trace.id`/`span.id`). All
 * three are read here; a reader that knows only one shape drops most of the
 * corpus silently.
 */
export function mapRecord(record: unknown, nowMs: number, maxAgeMs: number): MapResult {
  if (typeof record !== 'object' || record === null) return { skip: 'not-an-evaluation' };
  const r = record as Record<string, unknown>;
  if (r.name !== EVALUATION_RESULT_EVENT) return { skip: 'not-an-evaluation' };

  const attrs = (typeof r.attributes === 'object' && r.attributes !== null)
    ? r.attributes as Record<string, unknown>
    : {};

  const cohort = asString(attrs[EVALUATION_ATTRS.COHORT]);
  const legacyType = asString(attrs[LEGACY_EVALUATOR_TYPE_ATTR]);
  // Canary scores are synthetic and would drag every average they land in.
  // Checked on both fields for the same reason `filterCanary` in sync-to-kv
  // does: pre-OBP16 records mark a canary in the overloaded legacy field,
  // post-OBP16 ones in `cohort`.
  if (cohort === CANARY_COHORT || legacyType === CANARY_EVALUATOR_TYPE) return { skip: 'canary' };

  const timestamp = asString(r.timestamp);
  const tMs = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isNaN(tMs) && nowMs - tMs > maxAgeMs) return { skip: 'too-old' };

  const evaluationName = asString(attrs[EVALUATION_ATTRS.NAME]);
  if (!evaluationName) return { skip: 'no-name' };

  const scoreRaw = attrs[EVALUATION_ATTRS.SCORE_VALUE];
  const scoreValue = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : undefined;
  // The webhook requires one of scoreValue/scoreLabel/errorType; these records
  // only ever carry a numeric score, so a missing one is unshippable.
  if (scoreValue === undefined) return { skip: 'no-score' };

  const evaluator = asString(attrs[EVALUATION_ATTRS.PRODUCER])
    ?? asString(attrs['gen_ai.evaluation.evaluator'])
    ?? 'unknown';
  const evaluatorType = asString(attrs[EVALUATION_ATTRS.EVALUATOR_KIND])
    ?? legacyType
    ?? 'rule';

  const explanation = asString(attrs[EVALUATION_ATTRS.EXPLANATION]);
  // COMPAT until 2026-10-29: records written before 2026-09-29 carry the unit under the old key.
  const scoreUnit = asString(attrs[EVALUATION_ATTRS.SCORE_UNIT]) ?? asString(attrs[LEGACY_SCORE_UNIT_ATTR]);
  const scoreLabel = asString(attrs[EVALUATION_ATTRS.SCORE_LABEL]);
  // toOTelRecord puts the trace id top-level; the quality-evaluation hook puts
  // it in attributes. Read both.
  const traceId = asString(r.traceId) ?? asString(attrs['trace.id']);
  const spanId = asString(r.spanId) ?? asString(attrs['span.id']);
  const sessionId = asString(attrs[EVALUATION_ATTRS.SESSION_ID]);
  const judgeModel = asString(attrs[EVALUATION_ATTRS.JUDGE_MODEL]);
  const responseId = asString(attrs[EVALUATION_ATTRS.RESPONSE_ID]);

  const payload: EvaluationPayload = {
    evaluationName: truncate(evaluationName, WEBHOOK_MAX_NAME_LENGTH),
    evaluator: truncate(evaluator, WEBHOOK_MAX_NAME_LENGTH),
    evaluatorType: truncate(evaluatorType, WEBHOOK_MAX_NAME_LENGTH),
    scoreValue,
    serviceName: UPLOAD_SERVICE_NAME,
  };
  if (scoreUnit) payload.scoreUnit = scoreUnit;
  if (scoreLabel) payload.scoreLabel = truncate(scoreLabel, WEBHOOK_MAX_NAME_LENGTH);
  if (explanation) payload.explanation = truncate(explanation, WEBHOOK_MAX_EXPLANATION_LENGTH);
  if (traceId) payload.traceId = traceId;
  if (spanId) payload.spanId = spanId;
  if (sessionId) payload.sessionId = sessionId;
  if (responseId) payload.responseId = responseId;
  // Only the webhook's enum values: one outside it would get the whole batch rejected.
  if (cohort && WEBHOOK_COHORTS.has(cohort)) payload.cohort = cohort;
  // Top-level since 2026-09-30 so readers populate EvaluationResult.judgeModel; the
  // metadata copy it replaced was never read back (JUDGE-MODEL-METADATA-ONLY).
  if (judgeModel) payload.judgeModel = truncate(judgeModel, WEBHOOK_MAX_NAME_LENGTH);

  // Supply evaluatedAtMs so the flush dates the row to when the evaluation
  // was produced, not when this batch arrived (EVAL-WEBHOOK-EVENT-TIME).
  if (!Number.isNaN(tMs)) payload.evaluatedAtMs = tMs;

  // Fields the webhook has no slot for ride in `metadata`, which the flush keeps
  // in the row's `attributes`. evaluatedAt keeps the ISO string form for auditability.
  const metadata: Record<string, unknown> = {};
  if (timestamp) metadata.evaluatedAt = timestamp;
  const schemaUrl = asString(r[SCHEMA_URL_FIELD]);
  if (schemaUrl) metadata.schemaUrl = schemaUrl;
  if (Object.keys(metadata).length > 0) payload.metadata = metadata;
  payload.evaluationId = evaluationId(r);

  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_EVALUATION_BYTES) {
    // Explanation is the only unbounded-ish field left; drop it and retry once.
    delete payload.explanation;
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_EVALUATION_BYTES) return { skip: 'too-large' };
  }

  if (IDENTITY_KEY_REF_FIELD in r) {
    const raw = r[IDENTITY_KEY_REF_FIELD];
    return { payload, accountRef: typeof raw === 'string' ? raw : null };
  }
  return { payload };
}

/**
 * Identify a record by its content, not its position.
 *
 * Built from the raw line so it is stable under `derive`'s wholesale rewrite
 * and independent of how this script happens to map fields today — a mapping
 * change must not silently re-ship the whole window.
 *
 * The fields TKR8 added to existing records are left out: the account stamp
 * (Phase 1) and the top-level span id (Phase 2). `derive` regenerates its rule
 * records on every run, so every record it had already shipped would otherwise
 * come back with a new fingerprint and ship twice. `toOTelRecord` writes them
 * as the last keys, so dropping them and re-serializing yields exactly the line
 * written before either existed. Two records that differ only in span id were
 * already identical lines before Phase 2, so this merges nothing that was
 * previously distinct.
 */
export function fingerprint(line: string): string {
  return createHash('sha256').update(withoutAddedFields(line.trim())).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * The id the ingest worker dedups on (`evaluation_id`, migration 0015): a
 * re-send of a record it already stored is dropped server-side, whatever this
 * script's state file says.
 *
 * Content-derived like `fingerprint`, but it keeps the span id: two parallel
 * spans scored in the same millisecond differ only there, and are two
 * evaluations. Only the account stamp is left out — it routes the record, and a
 * cloud-sourced derive stamps records the local one could not, so including it
 * would give the same evaluation two ids.
 */
export function evaluationId(record: Record<string, unknown>): string {
  const { [IDENTITY_KEY_REF_FIELD]: _stamp, ...rest } = record;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, EVALUATION_ID_LENGTH);
}

/** Top-level record fields excluded from the fingerprint (see `fingerprint`). */
const FINGERPRINT_EXCLUDED_FIELDS = [SPAN_ID_FIELD, IDENTITY_KEY_REF_FIELD] as const;

function withoutAddedFields(line: string): string {
  if (!FINGERPRINT_EXCLUDED_FIELDS.some((f) => line.includes(`"${f}"`))) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof parsed !== 'object' || parsed === null) return line;
  const rest = { ...(parsed as Record<string, unknown>) };
  for (const field of FINGERPRINT_EXCLUDED_FIELDS) delete rest[field];
  return JSON.stringify(rest);
}

export function loadShipped(dir: string): ShippedIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, STATE_FILENAME), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const index: ShippedIndex = {};
    for (const [file, fps] of Object.entries(parsed)) {
      if (Array.isArray(fps)) index[file] = fps.filter((f): f is string => typeof f === 'string');
    }
    return index;
  } catch {
    return {};
  }
}

/** Atomic: a torn state file would re-ship a window and duplicate every row in it. */
export function saveShipped(dir: string, index: ShippedIndex): void {
  const target = join(dir, STATE_FILENAME);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, target);
}

/** Drop state for files that have aged out, so it cannot grow without bound. */
export function pruneShipped(index: ShippedIndex, windowDays: number, nowMs: number): ShippedIndex {
  const pruned: ShippedIndex = {};
  for (const [file, fps] of Object.entries(index)) {
    if (inWindow(file, windowDays, nowMs)) pruned[file] = fps;
  }
  return pruned;
}

function inWindow(file: string, windowDays: number, nowMs: number): boolean {
  return fileInWindow(file, EVAL_FILE_PATTERN, windowDays, nowMs);
}

/** Evaluation files in the date window, oldest first. */
export function windowFiles(dir: string, windowDays: number, nowMs: number): string[] {
  try {
    return readdirSync(dir).filter((f) => inWindow(f, windowDays, nowMs)).sort();
  } catch {
    return [];
  }
}

/** One manifest entry: which record to re-ship, and under which account's key. */
export interface ManifestEntry {
  ref: string;
  evaluationName: string;
  traceId: string;
  evaluatedAtMs: number;
}

/** A record's identity for `--only-keys`: name, trace and event time, which a D1 row also carries. */
export function manifestKey(evaluationName: string, traceId: string, evaluatedAtMs: number): string {
  return `${evaluationName}|${traceId}|${evaluatedAtMs}`;
}

/**
 * Parse a `--only-keys` manifest (JSONL) into key → account ref. Throws on a
 * malformed line or a ref that is not an identity-map secret name: a manifest
 * drives production writes, so a partial read must not ship a partial set.
 */
export function parseKeyManifest(text: string): Map<string, string> {
  const manifest = new Map<string, string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const e = JSON.parse(line) as Partial<ManifestEntry>;
    if (typeof e.ref !== 'string' || !IDENTITY_KEY_REF_PATTERN.test(e.ref)
      || typeof e.evaluationName !== 'string' || !e.evaluationName
      || typeof e.traceId !== 'string'
      || typeof e.evaluatedAtMs !== 'number' || !Number.isInteger(e.evaluatedAtMs)) {
      throw new Error(`manifest line ${i + 1} is not {ref, evaluationName, traceId, evaluatedAtMs}`);
    }
    manifest.set(manifestKey(e.evaluationName, e.traceId, e.evaluatedAtMs), e.ref);
  });
  return manifest;
}

/** The manifest key of a mapped payload; `undefined` when it has no event time to match on. */
export function payloadManifestKey(payload: EvaluationPayload): string | undefined {
  if (payload.evaluatedAtMs === undefined) return undefined;
  return manifestKey(payload.evaluationName, payload.traceId ?? '', payload.evaluatedAtMs);
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
  const spanId = mapped.payload!.spanId;
  if (spanId && index.bySpan.has(spanId)) return { route: routeForRef(index.bySpan.get(spanId)!), basis: 'span' };
  return { route: { kind: 'webhook' }, basis: 'join' };
}

function signature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export interface SendRequest { url: string; headers: Record<string, string>; body: string }

export function webhookRequest(baseUrl: string, batch: EvaluationPayload[], secret: string): SendRequest {
  const body = JSON.stringify({ evaluations: batch });
  return {
    url: `${baseUrl}${WEBHOOK_PATH}`,
    headers: { 'Content-Type': 'application/json', 'x-signature': signature(body, secret) },
    body,
  };
}

/** The org comes from the key, so this is the path that keeps accounts apart. */
export function keyedRequest(baseUrl: string, batch: EvaluationPayload[], apiKey: string): SendRequest {
  return {
    url: `${baseUrl}${KEYED_PATH}`,
    headers: { 'Content-Type': NDJSON_CONTENT_TYPE, Authorization: `Bearer ${apiKey}` },
    body: batch.map((p) => JSON.stringify(p)).join('\n') + '\n',
  };
}

export interface SendResult { ok: boolean; detail: string; retryable: boolean }

/** `{ k=v … }` summary for a counts record; yields `'none'` for an empty map. */
export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
}

/** Destination key for a route: the env-var ref for keyed routes, or `WEBHOOK_DESTINATION`. */
export function destinationFor(route: Route): string {
  return route.kind === 'keyed' ? route.ref : WEBHOOK_DESTINATION;
}

/** Resolve the ingest base URL and HMAC secret from the environment. */
export function resolveSendConfig(): { baseUrl: string; secret: string | undefined } {
  return {
    baseUrl: asString(process.env.OBTOOL_INGEST_URL) ?? DEFAULT_INGEST_URL,
    secret: asString(process.env.INJECT_HMAC_SECRET),
  };
}

/**
 * One POST attempt. Never throws.
 *
 * A thrown `fetch` here would skip the caller's `saveShipped`, losing the
 * fingerprints of batches this run already delivered — and because the
 * evaluations INSERT keys on a per-POST `r2_key`, the next run would re-send
 * them as duplicates rather than have them ignored. So transport failures are
 * returned as values, not exceptions.
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
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `transport: ${describeFetchError(err)}`,
      retryable: true,
    };
  }
}

/** Retry transient failures with exponential backoff; log once on exhaustion. */
export async function postBatch(request: SendRequest): Promise<SendResult> {
  let last: SendResult = { ok: false, detail: 'no attempt made', retryable: false };
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    last = await postBatchOnce(request);
    if (last.ok || !last.retryable) return last;
    if (attempt < MAX_SEND_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[upload-evaluations] attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed (${last.detail}) — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  console.error(`[upload-evaluations] giving up after ${MAX_SEND_ATTEMPTS} attempts: ${last.detail}`);
  return last;
}

const ONLY_KEYS_ARG = '--only-keys';

interface Options {
  dryRun: boolean;
  windowDays: number;
  maxAgeMs: number;
  limit: number;
  onlyKeysPath?: string;
}

const DAYS_ARG = '--days';
const MAX_AGE_HOURS_ARG = '--max-age-hours';
const LIMIT_ARG = '--limit';
const UPLOAD_CLI: CliSpec = { values: [DAYS_ARG, MAX_AGE_HOURS_ARG, LIMIT_ARG, ONLY_KEYS_ARG], switches: [DRY_RUN_FLAG] };

function parseArgs(argv: string[]): Options {
  const cli = parseCli(argv, UPLOAD_CLI);
  return {
    dryRun: cli.has(DRY_RUN_FLAG),
    windowDays: positiveIntArg(DAYS_ARG, cli.value(DAYS_ARG)) ?? DEFAULT_WINDOW_DAYS,
    maxAgeMs: (positiveNumberArg(MAX_AGE_HOURS_ARG, cli.value(MAX_AGE_HOURS_ARG)) ?? DEFAULT_MAX_AGE_HOURS) * TIME_MS.HOUR,
    limit: positiveIntArg(LIMIT_ARG, cli.value(LIMIT_ARG)) ?? Number.POSITIVE_INFINITY,
    onlyKeysPath: cli.value(ONLY_KEYS_ARG),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof CliArgError)) throw err;
    console.error(`[upload-evaluations] ${err.message}`);
    return 1;
  }
  const secret = process.env.INJECT_HMAC_SECRET;
  if (!secret && !opts.dryRun) {
    console.error('[upload-evaluations] INJECT_HMAC_SECRET is not set — nothing can be signed. Run under `doppler run --project integrity-studio --config prd`.');
    return 1;
  }
  // asString, not `??`: an empty OBTOOL_INGEST_URL must fall back to the
  // default host, and `??` would keep the empty string and POST to `/v1/...`.
  const baseUrl = asString(process.env.OBTOOL_INGEST_URL) ?? DEFAULT_INGEST_URL;

  const manifest = opts.onlyKeysPath ? parseKeyManifest(readFileSync(opts.onlyKeysPath, 'utf8')) : undefined;
  // The flush dates rows by evaluatedAtMs, so a targeted re-ship of old records
  // is correctly dated and needs no age guard.
  const maxAgeMs = manifest ? Number.POSITIVE_INFINITY : opts.maxAgeMs;
  const matchedKeys = new Set<string>();
  let notInManifest = 0;

  const nowMs = Date.now();
  const shipped = pruneShipped(loadShipped(TELEMETRY_DIR), opts.windowDays, nowMs);
  const files = windowFiles(TELEMETRY_DIR, opts.windowDays, nowMs);
  if (files.length === 0) {
    console.log(`[upload-evaluations] no evaluation files in the last ${opts.windowDays}d`);
    return 0;
  }

  const accounts = buildAccountIndex(TELEMETRY_DIR, ACCOUNT_INDEX_WINDOW_DAYS, nowMs);
  const skips: Record<string, number> = {};
  const sentByDestination: Record<string, number> = {};
  let sent = 0;
  let parseErrors = 0;
  let alreadyShipped = 0;
  let withheld = 0;
  const heldForKey: Record<string, number> = {};
  const routedBy: Record<RouteBasis, number> = { stamp: 0, span: 0, join: 0 };

  // try/finally, not a trailing save: an unexpected throw anywhere below would
  // otherwise skip saveShipped and lose the fingerprints of batches this run
  // already delivered, which the next run re-sends as duplicates.
  try {
  for (const file of files) {
    if (sent >= opts.limit) break;
    const done = new Set(shipped[file] ?? []);

    /** One pending batch per destination: `WEBHOOK_DESTINATION` or a key ref. */
    const batches = new Map<string, { payload: EvaluationPayload; fp: string }[]>();
    /** Confirmed-delivered fingerprints for this file, recorded only after a 2xx. */
    const delivered: string[] = [...done];

    const flush = async (destination: string): Promise<boolean> => {
      const batch = batches.get(destination) ?? [];
      if (batch.length === 0) return true;
      if (!opts.dryRun) {
        const payloads = batch.map((b) => b.payload);
        const request = destination === WEBHOOK_DESTINATION
          ? webhookRequest(baseUrl, payloads, secret!)
          : keyedRequest(baseUrl, payloads, process.env[destination]!);
        const res = await postBatch(request);
        if (!res.ok) {
          console.error(`[upload-evaluations] POST failed for ${file} (${destination}): ${res.detail}`);
          return false;
        }
      }
      sent += batch.length;
      sentByDestination[destination] = (sentByDestination[destination] ?? 0) + batch.length;
      // Record only what the worker accepted. A batch that never got a 2xx is
      // left unrecorded so the next run retries it — the one direction that
      // errs toward a duplicate rather than toward silent data loss.
      for (const b of batch) delivered.push(b.fp);
      batches.delete(destination);
      if (!opts.dryRun) await sleep(INTER_BATCH_DELAY_MS);
      return true;
    };
    const pendingCount = (): number => [...batches.values()].reduce((n, b) => n + b.length, 0);

    let ok = true;
    for (const line of readFileSync(join(TELEMETRY_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      if (sent + pendingCount() >= opts.limit) break;
      const fp = fingerprint(line);
      if (done.has(fp)) { alreadyShipped++; continue; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }
      const mapped = mapRecord(parsed, nowMs, maxAgeMs);
      const key = manifest && mapped.payload ? payloadManifestKey(mapped.payload) : undefined;
      if (manifest && (key === undefined || !manifest.has(key))) {
        // Not ours to touch: left unrecorded so a normal run handles it as before.
        notInManifest++;
        continue;
      }
      if (mapped.skip) {
        skips[mapped.skip] = (skips[mapped.skip] ?? 0) + 1;
        // Remember the decision so a permanently-unshippable record is not
        // re-examined, and cannot be shipped later by a widened --max-age-hours.
        if (mapped.skip !== 'too-old') delivered.push(fp);
        continue;
      }
      const { route, basis } = key !== undefined
        ? { route: { kind: 'keyed', ref: manifest!.get(key)! } as Route, basis: 'stamp' as RouteBasis }
        : routeRecord(mapped, accounts);
      if (key !== undefined) matchedKeys.add(key);
      routedBy[basis]++;
      if (route.kind === 'withheld') {
        // Unmapped account: consumed unsent, never re-examined (TKR3).
        withheld++;
        delivered.push(fp);
        continue;
      }
      if (route.kind === 'keyed' && !asString(process.env[route.ref])) {
        // Left unrecorded so a run that has the key ships it.
        heldForKey[route.ref] = (heldForKey[route.ref] ?? 0) + 1;
        continue;
      }
      const destination = destinationFor(route);
      const batch = batches.get(destination) ?? [];
      batch.push({ payload: mapped.payload!, fp });
      batches.set(destination, batch);
      if (batch.length >= MAX_BATCH_SIZE && !(await flush(destination))) { ok = false; break; }
    }
    for (const destination of [...batches.keys()]) {
      if (!ok) break;
      ok = await flush(destination);
    }

    shipped[file] = delivered;
    if (!ok) {
      console.error('[upload-evaluations] aborted on send failure — state saved up to the last accepted batch');
      return UPLOAD_EXIT_SEND_FAILED;
    }
  }
  } finally {
    if (!opts.dryRun) saveShipped(TELEMETRY_DIR, shipped);
  }

  console.log(
    `[upload-evaluations]${opts.dryRun ? ' dry-run:' : ''} ` +
    `sent=${sent} files=${files.length} alreadyShipped=${alreadyShipped} skipped[${formatCounts(skips)}]` +
    ` byDestination[${formatCounts(sentByDestination)}] withheld=${withheld}` +
    ` routedBy[${formatCounts(routedBy)}]` +
    (Object.keys(heldForKey).length ? ` heldForKey[${formatCounts(heldForKey)}]` : '') +
    (parseErrors ? ` parseErrors=${parseErrors}` : '') +
    (manifest ? ` onlyKeys[matched=${matchedKeys.size} of ${manifest.size} notInManifest=${notInManifest}]` : ''),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error('[upload-evaluations] fatal:', err);
    process.exit(1);
  });
}
