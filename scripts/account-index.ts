/**
 * Account stamps on spans, indexed for the evaluation pipeline (TKR8).
 *
 * The hooks' file exporters stamp every span record with `identityKeyRef` —
 * the identity map's secret name for the account signed in when the span was
 * *written*, or `null` for an unmapped account (TKR6). It is a record field,
 * never an attribute, so it is never shipped. In the cloud the org scope of
 * the key that reads a span back stands in for it: `cloud-trace-source` and
 * `judge-cloud-source` stamp each `/v1/traces` span with that key's name and
 * feed it through `indexSpanRecords` unchanged.
 *
 * Evaluations are produced later, by batch jobs that may run under a different
 * account, so they must not read "the current account". The producers look up
 * the stamp of the span or turn they score here and copy it onto the record
 * (Phase 1); `evaluation-delivery` then routes on the record's own stamp.
 *
 * Lookups:
 * - `derive-evaluations` and `evaluation-delivery` score or route a span they
 *   hold: `bySpan`.
 * - `judge-evaluations` scores a transcript turn, whose own spans are the
 *   session's spans between that turn and the next: `turnAccount` for its
 *   stamp and `turnSpan` for the span it is parented to (Phase 2).
 *
 * This module never touches the filesystem; the local trace-file readers live
 * in `telemetry-files.ts` and are used only by `trace-coverage`.
 */

import { asHrTime, hrtToMs, type HrTime } from './hrt.js';
import { pushTo } from './collections.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

/** Only identity-map secret names are read from the environment. */
export const IDENTITY_KEY_REF_PATTERN = /^OBTOOL_API_KEY(?:_[A-Z0-9]+)*$/;

/** Record field the hooks' file exporters stamp (`appendJsonl`, TKR6). */
export const IDENTITY_KEY_REF_FIELD = 'identityKeyRef';

/**
 * Start time given to a stamp whose span has none: it sorts last and is never at
 * or before an evaluation's time, so it can decide only a single-account trace.
 * Finite on purpose — `Infinity - Infinity` is `NaN`, which breaks the sort.
 */
const UNTIMED_MS = Number.MAX_SAFE_INTEGER;

/** Account ref as stamped: a secret name, or `null` for an unmapped account. */
export type AccountRef = string | null;

/**
 * One span on a session's timeline. Unstamped spans are included (`ref`
 * undefined) so a turn can be anchored to its span even where no account was
 * stamped; `turnAccount` skips them.
 */
export type SessionSpan = {
  atMs: number;
  spanId: string | undefined;
  traceId: string | undefined;
  ref: AccountRef | undefined;
}

/** The span a turn is parented to, per the semconv evaluation-event rule. */
export type SpanRef = {
  spanId: string;
  traceId: string;
}

export type AccountIndex = {
  /** Every span of a session, stamped or not, sorted by start time. */
  sessionSpans: Map<string, SessionSpan[]>;
  /** The stamp of one span, by span id. */
  bySpan: Map<string, AccountRef>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export type SpanRecordFields = {
  spanId: string | undefined;
  traceId: string | undefined;
  startTime: HrTime | undefined;
  sessionId: string | undefined;
  /** As written: a secret name, `null` for an unmapped account, `undefined` when absent (pre-TKR6). */
  stamp: AccountRef | undefined;
}

export function readSpanRecord(parsed: unknown): SpanRecordFields | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const span = parsed as Record<string, unknown>;
  const attrs = (typeof span.attributes === 'object' && span.attributes !== null)
    ? span.attributes as Record<string, unknown>
    : {};
  let stamp: AccountRef | undefined;
  if (IDENTITY_KEY_REF_FIELD in span) {
    const raw = span[IDENTITY_KEY_REF_FIELD];
    stamp = typeof raw === 'string' ? raw : null;
  }
  return {
    spanId: asString(span.spanId),
    traceId: asString(span.traceId),
    startTime: asHrTime(span.startTime),
    sessionId: asString(attrs[SESSION_ATTRIBUTES.ID]),
    stamp,
  };
}

/**
 * Index span records in the file exporters' shape: HRT `startTime`, and the
 * `identityKeyRef` stamp as a record field. Unstamped spans (written before
 * TKR6) go only on the session timeline, so they cannot outvote a stamped one
 * in any account lookup. The judge's cloud source feeds `/v1/traces` spans
 * through here, stamped with the account whose key read them.
 *
 * A record with neither its own stamp nor a named span routes to the webhook,
 * as an unstamped span does.
 */
export function indexSpanRecords(records: Iterable<unknown>): AccountIndex {
  const index: AccountIndex = { sessionSpans: new Map(), bySpan: new Map() };
  for (const parsed of records) {
    const span = readSpanRecord(parsed);
    if (!span) continue;
    const { spanId, traceId, sessionId, stamp: ref } = span;
    const atMs = span.startTime ? hrtToMs(span.startTime) : UNTIMED_MS;
    if (ref !== undefined && spanId) index.bySpan.set(spanId, ref);
    if (sessionId) pushTo(index.sessionSpans, sessionId, { atMs, spanId, traceId, ref });
  }
  for (const spans of index.sessionSpans.values()) spans.sort((a, b) => a.atMs - b.atMs);
  return index;
}

/**
 * The account a transcript turn ran under: the stamp of the session's first
 * span at or after the turn started (`fromMs`) and before the next turn
 * started (`toMs`, open-ended for the session's last turn).
 *
 * The first span, not a majority: a turn in one session can outlast a `/login`
 * run in a concurrent one, since they share the account file, and the turn
 * belongs to the account it *started* under. `undefined` when no stamped span
 * falls in the turn (spans aged out, or written before TKR6), so the record
 * stays unstamped and delivery falls back rather than guessing.
 */
export function turnAccount(
  index: AccountIndex,
  sessionId: string,
  fromMs: number,
  toMs: number = UNTIMED_MS,
): AccountRef | undefined {
  return spansInTurn(index, sessionId, fromMs, toMs).find((s) => s.ref !== undefined)?.ref;
}

/**
 * The span a transcript turn's evaluations are parented to: the session's
 * first span in the turn's window, stamped or not (TKR8 Phase 2).
 *
 * The semconv rule parents an evaluation to "the GenAI operation span being
 * evaluated". No such span is exported locally — the hooks' per-prompt parent
 * context is never written as a span — so the turn's first exported span is
 * the nearest real one, and it sits in the turn's own trace. `undefined` when
 * no span falls in the window; the caller then falls back to the response id.
 */
export function turnSpan(
  index: AccountIndex,
  sessionId: string,
  fromMs: number,
  toMs: number = UNTIMED_MS,
): SpanRef | undefined {
  for (const { spanId, traceId } of spansInTurn(index, sessionId, fromMs, toMs)) {
    if (spanId && traceId) return { spanId, traceId };
  }
  return undefined;
}

/** A session's spans in `[fromMs, toMs)`, in start order. */
function spansInTurn(index: AccountIndex, sessionId: string, fromMs: number, toMs: number): SessionSpan[] {
  if (!Number.isFinite(fromMs)) return [];
  const spans = index.sessionSpans.get(sessionId) ?? [];
  return spans.filter((s) => s.atMs >= fromMs && s.atMs < toMs);
}
