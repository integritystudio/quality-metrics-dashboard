/**
 * Cloud trace source for `derive-evaluations --source=cloud` (Phase 1 of
 * docs/roadmap/dashboard-cloud-read-migration.md).
 *
 * Reads `/v1/traces` once per identity-map account and converts each span to
 * the local HRT shape derive already scores, so the derivation code runs
 * unchanged on either source. The account whose key returned a span stands in
 * for the local `identityKeyRef` stamp: the shipper delivers each span to the
 * org of the account that wrote it, so the key that can read it back is that
 * account's.
 */

import { CloudBackend } from '../../src/backends/cloud.js';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import type { TraceSpan } from '../../src/backends/index.js';
import { statusCodeSchema } from '../../src/lib/otel/constants-otel.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { msToNs, nanosToHrt, nsToMs } from './hrt.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { localTraceSpanSchema, type LocalTraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
import { IDENTITY_KEY_REF_PATTERN, asString, type AccountRef } from './account-stamps.js';

/** Upper bound on cloud rows held in memory per account; ~10k spans/day locally. */
export const CLOUD_SPAN_LIMIT = 500_000;
const CLI_PREFIX = '[derive:cloud]';
const STATUS_CODE_NAMES = statusCodeSchema.removeDefault().options;

export interface LoadedSpans {
  /** Ascending by start time, span id breaking ties. */
  spans: LocalTraceSpan[];
  /** Account stamp by span id. */
  accounts: ReadonlyMap<string, AccountRef>;
}

/**
 * Convert a `/v1/traces` span to the local HRT shape; `null` when it fails
 * `localTraceSpanSchema`, the same rule the local reader applies to a bad line.
 */
export function toLocalTraceSpan(span: TraceSpan): LocalTraceSpan | null {
  const start = span.startTimeUnixNano;
  const end = span.endTimeUnixNano ?? start;
  const statusName = span.status?.code ?? span.statusCode;
  const candidate = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    startTime: nanosToHrt(start),
    endTime: nanosToHrt(end),
    duration: nanosToHrt(end >= start ? end - start : 0n),
    ...(statusName !== undefined && {
      status: {
        code: STATUS_CODE_NAMES.indexOf(statusName),
        ...(span.status?.message !== undefined && { message: span.status.message }),
      },
    }),
    attributes: span.attributes ?? {},
  };
  const parsed = localTraceSpanSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Identity-map secret names set in `env`, sorted so the first account to claim a span is stable. */
export function accountRefsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => IDENTITY_KEY_REF_PATTERN.test(name) && asString(env[name])).sort();
}

/** HTTP/1.1, as every script client is (NODE-FETCH-HTTP2-DEAD-SESSION). */
export function accountBackend(apiKey: string | undefined): CloudBackend {
  return new CloudBackend({ apiKey, fetch: http1Fetch });
}

export function queryAccountTraces(
  backend: CloudBackend,
  fromMs: number,
  toMs: number,
  limit: number = CLOUD_SPAN_LIMIT,
): Promise<TraceSpan[]> {
  return backend.queryTraces({ startDate: msToNs(fromMs), endDate: msToNs(toMs), limit });
}

/** Wording for the log line and truncation error, e.g. `{ rows: 'spans', truncates: 'the scope' }`. */
export interface AccountQueryLabel {
  rows: string;
  truncates: string;
}

/** Throws when an account returned `limit` rows: the read may then be truncated. */
export async function queryEachAccount<T>(
  env: NodeJS.ProcessEnv,
  limit: number,
  label: AccountQueryLabel,
  logPrefix: string,
  query: (backend: CloudBackend) => Promise<T[]>,
): Promise<{ ref: string; rows: T[] }[]> {
  const perAccount: { ref: string; rows: T[] }[] = [];
  for (const ref of accountRefsFromEnv(env)) {
    const rows = await query(accountBackend(env[ref]));
    if (rows.length >= limit) {
      throw new Error(`${ref}: cloud returned ${limit} ${label.rows}, so ${label.truncates} may be truncated; narrow --days`);
    }
    console.log(`${logPrefix} ${ref}: ${rows.length} ${label.rows}`);
    perAccount.push({ ref, rows });
  }
  return perAccount;
}

/** The `[from, to]` epoch-ms bounds covering every UTC date in `dates`. */
export function dateScopeBounds(dates: ReadonlySet<string>): { fromMs: number; toMs: number } {
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty date scope');
  return { fromMs: Date.parse(`${first}T00:00:00.000Z`), toMs: Date.parse(`${last}T00:00:00.000Z`) + TIME_MS.DAY - 1 };
}

function utcDateOfNanos(ns: bigint): string {
  return toDateOnly(new Date(nsToMs(ns)));
}

/**
 * Collect spans from every account into one ascending list. A span two keys
 * can both read keeps the first account's stamp; that happens only if two
 * keys share an org, and the count is reported.
 */
export function mergeAccountSpans(
  perAccount: readonly { ref: string; spans: readonly TraceSpan[] }[],
  dates: ReadonlySet<string>,
): LoadedSpans & { duplicates: number; rejected: number } {
  const seen = new Map<string, { span: TraceSpan; local: LocalTraceSpan }>();
  const accounts = new Map<string, AccountRef>();
  let duplicates = 0;
  let rejected = 0;
  for (const { ref, spans } of perAccount) {
    for (const span of spans) {
      if (!dates.has(utcDateOfNanos(span.startTimeUnixNano))) continue;
      const key = `${span.traceId}:${span.spanId}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      const local = toLocalTraceSpan(span);
      if (!local) {
        rejected++;
        continue;
      }
      seen.set(key, { span, local });
      accounts.set(span.spanId, ref);
    }
  }
  const ordered = [...seen.values()].sort((a, b) => {
    const byTime = a.span.startTimeUnixNano - b.span.startTimeUnixNano;
    if (byTime !== 0n) return byTime < 0n ? -1 : 1;
    return a.span.spanId.localeCompare(b.span.spanId);
  });
  return { spans: ordered.map((entry) => entry.local), accounts, duplicates, rejected };
}

/** Load every in-scope span from the cloud, one query per account key in `env`. */
export async function loadCloudSpans(
  dates: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
  logPrefix: string = CLI_PREFIX,
): Promise<LoadedSpans> {
  if (accountRefsFromEnv(env).length === 0) throw new Error('no OBTOOL_API_KEY* account key in the environment');
  const { fromMs, toMs } = dateScopeBounds(dates);
  const perAccount = await queryEachAccount(
    env,
    CLOUD_SPAN_LIMIT,
    { rows: 'spans', truncates: 'the scope' },
    logPrefix,
    (backend) => queryAccountTraces(backend, fromMs, toMs),
  );
  const merged = mergeAccountSpans(perAccount.map(({ ref, rows }) => ({ ref, spans: rows })), dates);
  if (merged.duplicates > 0) console.warn(`${logPrefix} ${merged.duplicates} spans readable by more than one key; kept the first`);
  if (merged.rejected > 0) console.warn(`${logPrefix} ${merged.rejected} spans failed localTraceSpanSchema and were skipped`);
  return { spans: merged.spans, accounts: merged.accounts };
}
