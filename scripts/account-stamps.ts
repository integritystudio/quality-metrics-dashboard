/**
 * Account stamps on local spans, indexed for the evaluation pipeline (TKR8).
 *
 * The hooks' file exporters stamp every span record with `identityKeyRef` —
 * the identity map's secret name for the account signed in when the span was
 * *written*, or `null` for an unmapped account (TKR6). It is a record field,
 * never an attribute, so it is never shipped.
 *
 * Evaluations are produced later, by batch jobs that may run under a different
 * account, so they must not read "the current account". The producers look up
 * the stamp of the span or turn they score here and copy it onto the record
 * (Phase 1); `upload-evaluations` then routes on the record's own stamp.
 *
 * Three consumers, three lookups:
 * - `derive-evaluations` scores a span it holds: `bySpan`.
 * - `judge-evaluations` scores a transcript turn, whose own spans are the
 *   session's spans between that turn and the next: `turnAccount` for its
 *   stamp and `turnSpan` for the span it is parented to (Phase 2).
 * - `upload-evaluations`: `bySpan` for a record that names its span, then, for
 *   records written before Phase 1, `byTrace` and `bySession` — the time-based
 *   join this replaces.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Trace files read for the account index, in days. Wider than the upload
 * window because the judge scores backlog turns whose spans are older than
 * the evaluation record itself.
 */
export const ACCOUNT_INDEX_WINDOW_DAYS = 7;

/** Record field the hooks' file exporters stamp (`appendJsonl`, TKR6). */
export const IDENTITY_KEY_REF_FIELD = 'identityKeyRef';

/** `traces-YYYY-MM-DD.jsonl` — the stamped spans. */
export const TRACE_FILE_PATTERN = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const SPAN_SESSION_ID_ATTR = 'session.id';
const MS_PER_DAY = 86_400_000;
const MS_PER_S = 1_000;
const NS_PER_MS = 1_000_000;
/**
 * Start time given to a stamp whose span has none: it sorts last and is never at
 * or before an evaluation's time, so it can decide only a single-account trace.
 * Finite on purpose — `Infinity - Infinity` is `NaN`, which breaks the sort.
 */
export const UNTIMED_MS = Number.MAX_SAFE_INTEGER;

/** Account ref as stamped: a secret name, or `null` for an unmapped account. */
export type AccountRef = string | null;

/** One stamped span's start time and account. */
export interface TraceStamp {
  atMs: number;
  ref: AccountRef;
}

/**
 * One span on a session's timeline. Unstamped spans are included (`ref`
 * undefined) so a turn can be anchored to its span even where no account was
 * stamped; `turnAccount` skips them.
 */
export interface SessionSpan {
  atMs: number;
  spanId?: string;
  traceId?: string;
  ref: AccountRef | undefined;
}

/** The span a turn is parented to, per the semconv evaluation-event rule. */
export interface SpanRef {
  spanId: string;
  traceId: string;
}

export interface AccountIndex {
  /**
   * Every stamp a trace's spans carried, sorted by start time. A trace is one
   * prompt, and a prompt can span a `/login`, so one trace can hold two accounts.
   */
  byTrace: Map<string, TraceStamp[]>;
  /** Every ref a session's spans carried; more than one means it switched. */
  bySession: Map<string, Set<AccountRef>>;
  /** Every span of a session, stamped or not, sorted by start time. */
  sessionSpans: Map<string, SessionSpan[]>;
  /** The stamp of one span, by span id. */
  bySpan: Map<string, AccountRef>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Whether a dated file (`<prefix>-YYYY-MM-DD.jsonl`) is inside the window. */
export function fileInWindow(file: string, pattern: RegExp, windowDays: number, nowMs: number): boolean {
  const m = pattern.exec(file);
  if (!m) return false;
  // Compare on the date in the name, never mtime: derive rewrites evaluation
  // files wholesale, so mtime says nothing about which day's records are inside.
  return Date.parse(`${m[1]}T23:59:59.999Z`) >= nowMs - windowDays * MS_PER_DAY;
}

/** OTel `[seconds, nanoseconds]` start time to epoch ms; `UNTIMED_MS` when absent or malformed. */
function hrTimeToMs(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 2) return UNTIMED_MS;
  // Array.isArray narrows `unknown` to `any[]`, so name the element type rather
  // than destructure `any`; the typeof guards below still do the real checking.
  const [s, ns] = value as [unknown, unknown];
  return typeof s === 'number' && typeof ns === 'number' ? s * MS_PER_S + ns / NS_PER_MS : UNTIMED_MS;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

/**
 * Index the spans in `files` (names under `dir`). Unstamped spans (written
 * before TKR6) go only on the session timeline, so they cannot outvote a
 * stamped one in any account lookup.
 */
export function indexTraceFiles(dir: string, files: readonly string[]): AccountIndex {
  const index: AccountIndex = { byTrace: new Map(), bySession: new Map(), sessionSpans: new Map(), bySpan: new Map() };
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // `unknown`, not a cast to Record: JSON.parse returns whatever the line
      // held, and a bare JSON string would make `'x' in span` throw below.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const span = parsed as Record<string, unknown>;
      const atMs = hrTimeToMs(span.startTime);
      const traceId = asString(span.traceId);
      const spanId = asString(span.spanId);
      const attrs = (typeof span.attributes === 'object' && span.attributes !== null)
        ? span.attributes as Record<string, unknown>
        : {};
      const sessionId = asString(attrs[SPAN_SESSION_ID_ATTR]);

      let ref: AccountRef | undefined;
      if (IDENTITY_KEY_REF_FIELD in span) {
        const raw = span[IDENTITY_KEY_REF_FIELD];
        ref = typeof raw === 'string' ? raw : null;
        if (traceId) pushTo(index.byTrace, traceId, { atMs, ref });
        if (spanId) index.bySpan.set(spanId, ref);
        if (sessionId) {
          const refs = index.bySession.get(sessionId) ?? new Set<AccountRef>();
          refs.add(ref);
          index.bySession.set(sessionId, refs);
        }
      }
      if (sessionId) pushTo(index.sessionSpans, sessionId, { atMs, spanId, traceId, ref });
    }
  }
  for (const stamps of index.byTrace.values()) stamps.sort((a, b) => a.atMs - b.atMs);
  for (const spans of index.sessionSpans.values()) spans.sort((a, b) => a.atMs - b.atMs);
  return index;
}

/** Index the stamped spans in the trace files dated within `windowDays`. */
export function buildAccountIndex(dir: string, windowDays: number, nowMs: number): AccountIndex {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => fileInWindow(f, TRACE_FILE_PATTERN, windowDays, nowMs));
  } catch {
    files = [];
  }
  return indexTraceFiles(dir, files);
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
 * stays unstamped and upload falls back rather than guessing.
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
  const span = spansInTurn(index, sessionId, fromMs, toMs).find((s) => s.spanId && s.traceId);
  return span ? { spanId: span.spanId!, traceId: span.traceId! } : undefined;
}

/** A session's spans in `[fromMs, toMs)`, in start order. */
function spansInTurn(index: AccountIndex, sessionId: string, fromMs: number, toMs: number): SessionSpan[] {
  if (!Number.isFinite(fromMs)) return [];
  const spans = index.sessionSpans.get(sessionId) ?? [];
  return spans.filter((s) => s.atMs >= fromMs && s.atMs < toMs);
}
