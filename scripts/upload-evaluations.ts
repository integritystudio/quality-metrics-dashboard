#!/usr/bin/env tsx
/**
 * Ship locally-derived evaluations to the cloud `evaluations` table.
 *
 * **This closes the seam that killed the dashboard.** `derive-evaluations` and
 * `judge-evaluations` write `evaluations-<date>.jsonl` into `TELEMETRY_DIR`;
 * `sync-to-kv` reads the *cloud* (`CloudBackend.queryEvaluations`, which
 * defaults to the `'table'` source — the D1 `evaluations` table). Nothing
 * connected the two: the detached span shipper
 * (`~/.claude/hooks/lib/span-shipper.ts`) matches only
 * `(traces|logs|metrics)-<date>.jsonl`, and the `evaluations` table is fed
 * solely by the HMAC webhook and `obs_inject_evaluations`. So local
 * evaluations accumulated on disk forever, `/v1/evaluations` held nothing but
 * its 2026-07-28 e2e fixtures, and every sync run computed an empty dashboard.
 *
 * Transport is chosen per record by the account that produced it (TKR7). The
 * hooks stamp every span with `identityKeyRef` — the identity map's secret name
 * for the signed-in account, or `null` for an unmapped one (TKR6). Evaluations
 * carry no stamp of their own, so each is joined to its source spans by trace
 * id, then by session id when the session saw only one account:
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
 * 1. **Evaluation time is not preserved.** `handleEvaluationsWebhook` stamps
 *    `receivedAtMs = Date.now()` *after* spreading the payload
 *    (`services/obtool-ingest/src/evaluations.ts`), so a client-supplied value
 *    is overwritten, and the flush resolves `timestamp_ns` from it. Rows are
 *    therefore timestamped at *receipt*, not at evaluation. Ship promptly and
 *    often and the error stays under one run interval; back-filling an old
 *    file collapses its whole history onto today. `--max-age-hours` refuses
 *    stale records rather than silently mis-dating them.
 * 2. **The shipped index is load-bearing, and must not be a byte offset.** The
 *    evaluations INSERT is `INSERT OR IGNORE` keyed on `(r2_key, batch_index)`,
 *    and every webhook POST allocates a fresh `r2_key` — so re-sending a record
 *    inserts a duplicate rather than being ignored; nothing downstream will
 *    catch it. A file offset cannot be the resume point either, because
 *    `derive-evaluations` REWRITES each `evaluations-<date>.jsonl` wholesale on
 *    every run and emits its rule lines *before* the preserved ones, so the
 *    prefix shifts whenever the rule count changes. This tracks a content
 *    fingerprint per record instead, which is stable under rewrite.
 *
 * Usage:
 *   tsx scripts/upload-evaluations.ts                  # ship the default window
 *   tsx scripts/upload-evaluations.ts --dry-run        # preview, no POSTs, no cursor write
 *   tsx scripts/upload-evaluations.ts --days=7         # widen the file window
 *   tsx scripts/upload-evaluations.ts --limit=50       # stop after N records
 *   tsx scripts/upload-evaluations.ts --max-age-hours=48
 *
 * Env: INJECT_HMAC_SECRET (required), OBTOOL_INGEST_URL (optional), and one
 * `OBTOOL_API_KEY*` per mapped account (all present under `doppler run … prd`).
 */

import { createHash, createHmac } from 'crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

import {
  CANARY_COHORT,
  CANARY_EVALUATOR_TYPE,
  EVALUATION_ATTRS,
  EVALUATION_RESULT_EVENT,
  LEGACY_EVALUATOR_TYPE_ATTR,
  TELEMETRY_DIR,
} from './judge-evaluations.js';

/** Default ingest host. Mirrors `INGEST_API_URL` in src/tools/inject-evaluations.ts. */
const DEFAULT_INGEST_URL = 'https://ingest.integritystudio.ai';

/**
 * Webhook caps, mirrored from `services/obtool-ingest/src/evaluations.ts`.
 * They are module-private there, so this is a copy rather than an import; the
 * copy is deliberately the *stricter* webhook set, not the looser MCP set in
 * `src/lib/validation/api-schemas.ts`. `upload-evaluations.test.ts` asserts
 * they still match the source.
 */
const MAX_BATCH_SIZE = 100;
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

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Pause between batches so a large first run does not burst the worker. */
const INTER_BATCH_DELAY_MS = 250;

/** Transient-failure retry budget per batch (429, 5xx, and transport errors). */
const MAX_SEND_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
/** Per-request ceiling; a hung connection would otherwise stall the whole run. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Recorded on every row this script ships, so cloud rows are attributable. */
const UPLOAD_SERVICE_NAME = 'dashboard:upload-evaluations';

/** `evaluations-YYYY-MM-DD.jsonl` */
const EVAL_FILE_PATTERN = /^evaluations-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** `traces-YYYY-MM-DD.jsonl` — the stamped spans evaluations are joined to. */
const TRACE_FILE_PATTERN = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Trace files read for the account join, in days. Wider than the upload
 * window because the judge scores backlog turns whose spans are older than
 * the evaluation record itself.
 */
const ACCOUNT_INDEX_WINDOW_DAYS = 7;

/** Record field the hooks' file exporters stamp (`appendJsonl`, TKR6). */
const IDENTITY_KEY_REF_FIELD = 'identityKeyRef';
/** Only identity-map secret names are read from the environment. */
const IDENTITY_KEY_REF_PATTERN = /^OBTOOL_API_KEY(?:_[A-Z0-9]+)*$/;
const SPAN_SESSION_ID_ATTR = 'session.id';

const WEBHOOK_PATH = '/v1/evaluations';
const KEYED_PATH = '/v1/ingest/backfill?signal=evaluations';
const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
/** Summary label for records sent through the org-less webhook. */
const WEBHOOK_DESTINATION = 'webhook';

const STATE_FILENAME = '.eval-upload-state.json';

/** Truncated sha256 is enough to separate records within a two-day window. */
const FINGERPRINT_LENGTH = 16;

/** Fingerprints already shipped, grouped by source file so they prune together. */
export type ShippedIndex = Record<string, string[]>;

export interface EvaluationPayload {
  evaluationName: string;
  evaluator: string;
  evaluatorType: string;
  scoreValue?: number;
  scoreUnit?: string;
  explanation?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  serviceName?: string;
  /** Client-supplied event time (Unix ms). When set the flush dates the row to
   *  this time instead of the batch-receipt time, so period aggregations are
   *  correct for batched uploads. */
  evaluatedAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MapResult {
  payload?: EvaluationPayload;
  /** Why the record was dropped; absent when `payload` is set. */
  skip?: 'not-an-evaluation' | 'canary' | 'no-name' | 'no-score' | 'too-large' | 'too-old';
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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
  const scoreUnit = asString(attrs[EVALUATION_ATTRS.SCORE_UNIT]);
  // toOTelRecord puts the trace id top-level; the quality-evaluation hook puts
  // it in attributes. Read both.
  const traceId = asString(r.traceId) ?? asString(attrs['trace.id']);
  const spanId = asString(r.spanId) ?? asString(attrs['span.id']);
  const sessionId = asString(attrs[EVALUATION_ATTRS.SESSION_ID]);
  const judgeModel = asString(attrs[EVALUATION_ATTRS.JUDGE_MODEL]);

  const payload: EvaluationPayload = {
    evaluationName: truncate(evaluationName, WEBHOOK_MAX_NAME_LENGTH),
    evaluator: truncate(evaluator, WEBHOOK_MAX_NAME_LENGTH),
    evaluatorType: truncate(evaluatorType, WEBHOOK_MAX_NAME_LENGTH),
    scoreValue,
    serviceName: UPLOAD_SERVICE_NAME,
  };
  if (scoreUnit) payload.scoreUnit = scoreUnit;
  if (explanation) payload.explanation = truncate(explanation, WEBHOOK_MAX_EXPLANATION_LENGTH);
  if (traceId) payload.traceId = traceId;
  if (spanId) payload.spanId = spanId;
  if (sessionId) payload.sessionId = sessionId;

  // Supply evaluatedAtMs so the flush dates the row to when the evaluation
  // was produced, not when this batch arrived (EVAL-WEBHOOK-EVENT-TIME).
  if (!Number.isNaN(tMs)) payload.evaluatedAtMs = tMs;

  // `cohort` is not a column on the evaluations table and is dropped by the
  // table read path, so it rides in `metadata`, which the flush preserves into
  // `attributes`. evaluatedAt keeps the ISO string form for auditability.
  const metadata: Record<string, unknown> = {};
  if (cohort) metadata.cohort = cohort;
  if (judgeModel) metadata.judgeModel = judgeModel;
  if (timestamp) metadata.evaluatedAt = timestamp;
  if (Object.keys(metadata).length > 0) payload.metadata = metadata;

  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_EVALUATION_BYTES) {
    // Explanation is the only unbounded-ish field left; drop it and retry once.
    delete payload.explanation;
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_EVALUATION_BYTES) return { skip: 'too-large' };
  }

  return { payload };
}

/**
 * Identify a record by its content, not its position.
 *
 * Built from the raw line so it is stable under `derive`'s wholesale rewrite
 * and independent of how this script happens to map fields today — a mapping
 * change must not silently re-ship the whole window.
 */
export function fingerprint(line: string): string {
  return createHash('sha256').update(line.trim()).digest('hex').slice(0, FINGERPRINT_LENGTH);
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

function inWindow(file: string, windowDays: number, nowMs: number, pattern: RegExp = EVAL_FILE_PATTERN): boolean {
  const m = pattern.exec(file);
  if (!m) return false;
  // Compare on the date in the name, never mtime: derive rewrites these files
  // wholesale, so mtime says nothing about which day's records are inside.
  return Date.parse(`${m[1]}T23:59:59.999Z`) >= nowMs - windowDays * MS_PER_DAY;
}

/** Evaluation files in the date window, oldest first. */
export function windowFiles(dir: string, windowDays: number, nowMs: number): string[] {
  try {
    return readdirSync(dir).filter((f) => inWindow(f, windowDays, nowMs)).sort();
  } catch {
    return [];
  }
}

/** Account ref as stamped: a secret name, or `null` for an unmapped account. */
export type AccountRef = string | null;

export interface AccountIndex {
  byTrace: Map<string, AccountRef>;
  /** Every ref a session's spans carried; more than one means it switched. */
  bySession: Map<string, Set<AccountRef>>;
}

/** Where one record goes. */
export type Route =
  | { kind: 'keyed'; ref: string }
  | { kind: 'withheld' }
  | { kind: 'webhook' };

/**
 * Index stamped spans by trace and session. Unstamped spans (written before
 * TKR6) are skipped, so they cannot outvote a stamped one in the same session.
 */
export function buildAccountIndex(dir: string, windowDays: number, nowMs: number): AccountIndex {
  const index: AccountIndex = { byTrace: new Map(), bySession: new Map() };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => inWindow(f, windowDays, nowMs, TRACE_FILE_PATTERN));
  } catch {
    return index;
  }
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.includes(IDENTITY_KEY_REF_FIELD)) continue;
      // `unknown`, not a cast to Record: JSON.parse returns whatever the line held,
      // and a line reaches here only by containing IDENTITY_KEY_REF_FIELD — which a
      // bare JSON string does too. Asserting the object shape up front makes the
      // guard below look redundant to the type checker while `'x' in "a string"`
      // still throws at runtime.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const span = parsed as Record<string, unknown>;
      if (!(IDENTITY_KEY_REF_FIELD in span)) continue;
      const raw = span[IDENTITY_KEY_REF_FIELD];
      const ref: AccountRef = typeof raw === 'string' ? raw : null;
      const traceId = asString(span.traceId);
      if (traceId) index.byTrace.set(traceId, ref);
      const attrs = (typeof span.attributes === 'object' && span.attributes !== null)
        ? span.attributes as Record<string, unknown>
        : {};
      const sessionId = asString(attrs[SPAN_SESSION_ID_ATTR]);
      if (sessionId) {
        const refs = index.bySession.get(sessionId) ?? new Set<AccountRef>();
        refs.add(ref);
        index.bySession.set(sessionId, refs);
      }
    }
  }
  return index;
}

/**
 * Trace id first — it pins the turn even in a session that ran `/login`.
 * A session id is used only when that session saw a single account.
 */
export function resolveRoute(payload: EvaluationPayload, index: AccountIndex): Route {
  let ref: AccountRef | undefined;
  if (payload.traceId && index.byTrace.has(payload.traceId)) {
    ref = index.byTrace.get(payload.traceId);
  } else if (payload.sessionId) {
    const refs = index.bySession.get(payload.sessionId);
    if (refs?.size === 1) ref = [...refs][0];
  }
  if (ref === undefined) return { kind: 'webhook' };
  if (ref === null) return { kind: 'withheld' };
  // A ref that is not an identity-map secret name is not read from the
  // environment; the record ships as it did before stamping existed.
  return IDENTITY_KEY_REF_PATTERN.test(ref) ? { kind: 'keyed', ref } : { kind: 'webhook' };
}

function signature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

interface SendRequest { url: string; headers: Record<string, string>; body: string }

function webhookRequest(baseUrl: string, batch: EvaluationPayload[], secret: string): SendRequest {
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

interface SendResult { ok: boolean; detail: string; retryable: boolean }

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
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      // Without this a hung connection stalls the run indefinitely.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      detail: `${response.status} ${text.slice(0, 300)}`,
      // 4xx other than 429 is a payload problem — retrying re-sends the same
      // bytes to the same verdict, so only throttling and server faults retry.
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `transport: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }
}

/** Retry transient failures with exponential backoff; log once on exhaustion. */
async function postBatch(request: SendRequest): Promise<SendResult> {
  let last: SendResult = { ok: false, detail: 'no attempt made', retryable: false };
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    last = await postBatchOnce(request);
    if (last.ok || !last.retryable) return last;
    if (attempt < MAX_SEND_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[upload-evaluations] attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed (${last.detail}) — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error(`[upload-evaluations] giving up after ${MAX_SEND_ATTEMPTS} attempts: ${last.detail}`);
  return last;
}

interface Options {
  dryRun: boolean;
  windowDays: number;
  maxAgeMs: number;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const numeric = (flag: string, fallback: number): number => {
    const raw = argv.find((a) => a.startsWith(`${flag}=`))?.split('=')[1];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    windowDays: numeric('--days', DEFAULT_WINDOW_DAYS),
    maxAgeMs: numeric('--max-age-hours', DEFAULT_MAX_AGE_HOURS) * MS_PER_HOUR,
    limit: numeric('--limit', Number.POSITIVE_INFINITY),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  const secret = process.env.INJECT_HMAC_SECRET;
  if (!secret && !opts.dryRun) {
    console.error('[upload-evaluations] INJECT_HMAC_SECRET is not set — nothing can be signed. Run under `doppler run --project integrity-studio --config prd`.');
    return 1;
  }
  // asString, not `??`: an empty OBTOOL_INGEST_URL must fall back to the
  // default host, and `??` would keep the empty string and POST to `/v1/...`.
  const baseUrl = asString(process.env.OBTOOL_INGEST_URL) ?? DEFAULT_INGEST_URL;

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
      if (!opts.dryRun) await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
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
      const mapped = mapRecord(parsed, nowMs, opts.maxAgeMs);
      if (mapped.skip) {
        skips[mapped.skip] = (skips[mapped.skip] ?? 0) + 1;
        // Remember the decision so a permanently-unshippable record is not
        // re-examined, and cannot be shipped later by a widened --max-age-hours.
        if (mapped.skip !== 'too-old') delivered.push(fp);
        continue;
      }
      const route = resolveRoute(mapped.payload!, accounts);
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
      const destination = route.kind === 'keyed' ? route.ref : WEBHOOK_DESTINATION;
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
      return 1;
    }
  }
  } finally {
    if (!opts.dryRun) saveShipped(TELEMETRY_DIR, shipped);
  }

  const summarize = (counts: Record<string, number>): string =>
    Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  console.log(
    `[upload-evaluations]${opts.dryRun ? ' dry-run:' : ''} ` +
    `sent=${sent} files=${files.length} alreadyShipped=${alreadyShipped} skipped[${summarize(skips)}]` +
    ` byDestination[${summarize(sentByDestination)}] withheld=${withheld}` +
    (Object.keys(heldForKey).length ? ` heldForKey[${summarize(heldForKey)}]` : '') +
    (parseErrors ? ` parseErrors=${parseErrors}` : ''),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error('[upload-evaluations] fatal:', err);
    process.exit(1);
  });
}
