#!/usr/bin/env tsx
/**
 * Trace coverage: local `traces-*.jsonl` vs the cloud `/v1/traces` (Phase 0 of
 * docs/roadmap/dashboard-cloud-read-migration.md). Read-only.
 *
 * Every later phase moves a producer from the local files to the cloud, so it
 * inherits whatever the shipper failed to deliver. This measures that gap
 * before anything depends on it.
 *
 * Spans are matched on `traceId:spanId` and bucketed by their own UTC start
 * day, never by file name. Each local span is compared against the account it
 * was stamped with (`identityKeyRef`), using that account's API key, because
 * the shipper delivers each span to its own account's org. Spans written in the
 * last `--settle-minutes` are left out so shipper lag does not read as loss.
 *
 * Usage (needs every stamped account's key, all present under prd):
 *   doppler run --project integrity-studio --config prd -- npm run trace-coverage
 *   … -- npm run trace-coverage -- --days 3 --settle-minutes 120 --json out.json
 *
 * Exit: 0 at or above `--min-coverage` for every account, 1 below it, 2 on a
 * configuration problem (missing URL or no key for any stamped account).
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CloudBackend } from '../../src/backends/cloud.js';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import { NANOSECONDS_PER_MILLISECOND_BIGINT, PERCENT_MULTIPLIER } from '../../src/lib/core/units.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';
import { TRACE_FILE_PATTERN, IDENTITY_KEY_REF_FIELD, fileInWindow, asString, type AccountRef } from './account-stamps.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_SETTLE_MINUTES = 60;
const DEFAULT_MIN_COVERAGE = 0.99;
/** `--min-coverage` is a ratio; a percentage like 99 is clamped rather than failing every run. */
const MAX_COVERAGE = 1;
/** Upper bound on cloud rows held in memory per account; ~10k spans/day locally. */
const CLOUD_SPAN_LIMIT = 500_000;
const TOP_MISSING_SESSIONS = 10;
const COVERAGE_DECIMALS = 2;
const JSON_INDENT = 2;
const MS_PER_S = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const NS_PER_MS = 1_000_000;
const ISO_DATE_LENGTH = 10;
const SESSION_ID_ATTR = 'session.id';
const NO_SESSION = '(none)';
const CLI_PREFIX = '[trace-coverage]';

export const EXIT_OK = 0;
export const EXIT_BELOW_THRESHOLD = 1;
export const EXIT_CONFIG = 2;

/** One local span, reduced to what the comparison needs. */
export interface LocalSpan {
  key: string;
  ref: AccountRef;
  startMs: number;
  sessionId: string;
}

export interface DayCoverage {
  day: string;
  local: number;
  matched: number;
  missing: number;
  cloudOnly: number;
}

export interface AccountCoverage {
  ref: string;
  days: DayCoverage[];
  local: number;
  matched: number;
  coverage: number;
  missingBySession: { sessionId: string; missing: number }[];
}

export interface CoverageWindow {
  fromMs: number;
  toMs: number;
}

export function spanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Window start is the UTC midnight `days - 1` days before `nowMs`, so today counts as one. */
export function coverageWindow(nowMs: number, days: number, settleMinutes: number): CoverageWindow {
  const todayStart = Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`);
  return { fromMs: todayStart - (days - 1) * MS_PER_DAY, toMs: nowMs - settleMinutes * MS_PER_MINUTE };
}

function hrTimeToMs(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [s, ns] = value as [unknown, unknown];
  return typeof s === 'number' && typeof ns === 'number' ? s * MS_PER_S + ns / NS_PER_MS : undefined;
}

/** Parse one local JSONL line; `undefined` for blank, malformed or out-of-window lines. */
export function parseLocalSpan(line: string, window: CoverageWindow): LocalSpan | undefined {
  if (!line.trim()) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== 'object') return undefined;
  const r = record as Record<string, unknown>;
  const traceId = asString(r.traceId);
  const spanId = asString(r.spanId);
  const startMs = hrTimeToMs(r.startTime);
  if (!traceId || !spanId || startMs === undefined) return undefined;
  if (startMs < window.fromMs || startMs > window.toMs) return undefined;
  const attrs = (r.attributes ?? {}) as Record<string, unknown>;
  const rawRef = r[IDENTITY_KEY_REF_FIELD];
  return {
    key: spanKey(traceId, spanId),
    ref: typeof rawRef === 'string' ? rawRef : null,
    startMs,
    sessionId: asString(attrs[SESSION_ID_ATTR]) ?? NO_SESSION,
  };
}

/** Compare one account's local spans with the cloud spans its key returned. */
export function compareAccount(
  ref: string,
  local: readonly LocalSpan[],
  cloud: ReadonlyMap<string, number>,
): AccountCoverage {
  const byDay = new Map<string, DayCoverage>();
  const dayOf = (day: string): DayCoverage => {
    let entry = byDay.get(day);
    if (!entry) {
      entry = { day, local: 0, matched: 0, missing: 0, cloudOnly: 0 };
      byDay.set(day, entry);
    }
    return entry;
  };
  const localKeys = new Set<string>();
  const missingBySession = new Map<string, number>();
  for (const span of local) {
    if (localKeys.has(span.key)) continue;
    localKeys.add(span.key);
    const entry = dayOf(utcDay(span.startMs));
    entry.local++;
    if (cloud.has(span.key)) {
      entry.matched++;
    } else {
      entry.missing++;
      missingBySession.set(span.sessionId, (missingBySession.get(span.sessionId) ?? 0) + 1);
    }
  }
  for (const [key, startMs] of cloud) {
    if (!localKeys.has(key)) dayOf(utcDay(startMs)).cloudOnly++;
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totalLocal = localKeys.size;
  const matched = days.reduce((sum, d) => sum + d.matched, 0);
  return {
    ref,
    days,
    local: totalLocal,
    matched,
    coverage: totalLocal === 0 ? 1 : matched / totalLocal,
    missingBySession: [...missingBySession]
      .map(([sessionId, missing]) => ({ sessionId, missing }))
      .sort((a, b) => b.missing - a.missing)
      .slice(0, TOP_MISSING_SESSIONS),
  };
}

function readLocalSpans(dir: string, window: CoverageWindow, windowDays: number, nowMs: number): LocalSpan[] {
  // One extra day of files: a span near midnight can sit in the neighbouring day's file.
  const files = readdirSync(dir).filter((f) => fileInWindow(f, TRACE_FILE_PATTERN, windowDays + 1, nowMs)).sort();
  const spans: LocalSpan[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (err) {
      console.warn(`${CLI_PREFIX} skipping ${file}: ${String(err)}`);
      continue;
    }
    for (const line of text.split('\n')) {
      const span = parseLocalSpan(line, window);
      if (span) spans.push(span);
    }
  }
  return spans;
}

async function fetchCloudSpans(apiKey: string, window: CoverageWindow): Promise<Map<string, number>> {
  const backend = new CloudBackend({ apiKey, fetch: http1Fetch });
  const spans = await backend.queryTraces({
    startDate: BigInt(window.fromMs) * NANOSECONDS_PER_MILLISECOND_BIGINT,
    endDate: BigInt(Math.floor(window.toMs)) * NANOSECONDS_PER_MILLISECOND_BIGINT,
    limit: CLOUD_SPAN_LIMIT,
  });
  if (spans.length >= CLOUD_SPAN_LIMIT) {
    console.warn(`${CLI_PREFIX} cloud returned ${CLOUD_SPAN_LIMIT} spans — raise CLOUD_SPAN_LIMIT or narrow --days`);
  }
  const byKey = new Map<string, number>();
  for (const span of spans) {
    const startMs = Number(span.startTimeUnixNano / NANOSECONDS_PER_MILLISECOND_BIGINT);
    // The route filters by whole UTC day; re-apply the exact window so the settle margin holds.
    if (startMs < window.fromMs || startMs > window.toMs) continue;
    byKey.set(spanKey(span.traceId, span.spanId), startMs);
  }
  return byKey;
}

function formatPercent(ratio: number): string {
  return `${(ratio * PERCENT_MULTIPLIER).toFixed(COVERAGE_DECIMALS)}%`;
}

function printAccount(result: AccountCoverage): void {
  console.log(`\n${result.ref}: ${result.matched}/${result.local} local spans in cloud (${formatPercent(result.coverage)})`);
  console.table(result.days.map((d) => ({
    day: d.day,
    local: d.local,
    matched: d.matched,
    missing: d.missing,
    cloudOnly: d.cloudOnly,
    coverage: formatPercent(d.local === 0 ? 1 : d.matched / d.local),
  })));
  if (result.missingBySession.length > 0) {
    console.log(`  top sessions with missing spans:`);
    for (const { sessionId, missing } of result.missingBySession) console.log(`    ${sessionId}  ${missing}`);
  }
}

interface CliOptions {
  days: number;
  settleMinutes: number;
  minCoverage: number;
  jsonPath?: string;
}

function numberFlag(args: readonly string[], flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} needs a non-negative number`);
  return value;
}

export function parseArgs(args: readonly string[]): CliOptions {
  const jsonIndex = args.indexOf('--json');
  return {
    days: Math.max(1, Math.floor(numberFlag(args, '--days', DEFAULT_WINDOW_DAYS))),
    settleMinutes: numberFlag(args, '--settle-minutes', DEFAULT_SETTLE_MINUTES),
    minCoverage: Math.min(MAX_COVERAGE, numberFlag(args, '--min-coverage', DEFAULT_MIN_COVERAGE)),
    jsonPath: jsonIndex === -1 ? undefined : args[jsonIndex + 1],
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.OBTOOL_API_URL) {
    console.error(`${CLI_PREFIX} OBTOOL_API_URL is not set; run under doppler --config prd`);
    return EXIT_CONFIG;
  }
  const nowMs = Date.now();
  const window = coverageWindow(nowMs, options.days, options.settleMinutes);
  console.log(`${CLI_PREFIX} window ${new Date(window.fromMs).toISOString()} → ${new Date(window.toMs).toISOString()}`);

  const local = readLocalSpans(TELEMETRY_DIR, window, options.days, nowMs);
  const byRef = new Map<string, LocalSpan[]>();
  let unstamped = 0;
  for (const span of local) {
    if (span.ref === null) {
      unstamped++;
      continue;
    }
    const list = byRef.get(span.ref) ?? [];
    list.push(span);
    byRef.set(span.ref, list);
  }
  console.log(`${CLI_PREFIX} ${local.length} local spans; ${unstamped} unstamped (not compared)`);

  const missingKeys = [...byRef.keys()].filter((ref) => !asString(process.env[ref]));
  if (missingKeys.length > 0) {
    console.error(`${CLI_PREFIX} no API key in env for: ${missingKeys.join(', ')}`);
    return EXIT_CONFIG;
  }

  const results: AccountCoverage[] = [];
  for (const [ref, spans] of [...byRef].sort(([a], [b]) => a.localeCompare(b))) {
    const cloud = await fetchCloudSpans(process.env[ref]!, window);
    const result = compareAccount(ref, spans, cloud);
    printAccount(result);
    results.push(result);
  }

  if (options.jsonPath) {
    writeFileSync(options.jsonPath, JSON.stringify({ window, unstamped, results }, null, JSON_INDENT) + '\n');
    console.log(`\n${CLI_PREFIX} results written: ${options.jsonPath}`);
  }

  const below = results.filter((r) => r.coverage < options.minCoverage);
  if (below.length > 0) {
    console.log(`\n${CLI_PREFIX} below ${formatPercent(options.minCoverage)}: ${below.map((r) => r.ref).join(', ')}`);
    return EXIT_BELOW_THRESHOLD;
  }
  console.log(`\n${CLI_PREFIX} every account at or above ${formatPercent(options.minCoverage)}`);
  return EXIT_OK;
}

// Only run when executed directly (not imported as a module for testing)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
    console.error(`${CLI_PREFIX} fatal:`, err);
    process.exitCode = EXIT_CONFIG;
  });
}
