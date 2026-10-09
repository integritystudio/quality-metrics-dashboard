#!/usr/bin/env tsx
/**
 * Judge parity: the Phase 4 exit check of
 * docs/roadmap/dashboard-cloud-read-migration.md. Read-only; judges nothing.
 *
 * Discovers turns for the same UTC dates from the local telemetry and from
 * obtool-api (`discoverTurns`), then compares:
 * - **discovery**: the same turns, keyed by session and turn time. A turn found
 *   only locally whose session has no local span either is `unshipped`: the
 *   session emitted no telemetry, so the cloud cannot know it. It is reported,
 *   not gated; a local-only turn whose session did have spans is a real gap.
 * - **anchoring**: each shared turn's span and account (reported, not gated).
 *   A local stamp is missing for spans older than the local trace index.
 * - **selection**: what `selectTurns` takes from each source under one dedup
 *   set, the union of both. That isolates discovery from the two judged sets,
 *   which differ by design: the local ledger holds turns judged but never
 *   delivered, and the cloud source judges those again. Unshipped turns are
 *   left out of the local side, for the reason above.
 *
 * Usage (needs every account's key, all present under prd):
 *   doppler run --project integrity-studio --config prd -- npm run judge:parity -- --days=7
 *   … -- npm run judge:parity -- --date=2026-09-26 --limit 100
 *
 * Exit: 0 when discovery and selection match, 1 on any difference, 2 on a usage or fetch error.
 */

import { discoverTurns } from './judge-evaluations.js';
import { turnKey, type Turn } from './judge-turns.js';

export { turnKey };
import { resolveDateScope } from './derive-evaluations.js';
import { parseCli, positiveIntArg, runIfMain } from './cli-args.js';
import { selectTurns } from './judge-selection.js';

const CLI_PREFIX = '[judge:parity]';
const LIMIT_ARG = '--limit';
const DEFAULT_LIMIT = 100;
const SAMPLE_LIMIT = 5;

export const EXIT_MATCH = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_ERROR = 2;

export interface JudgeParityReport {
  local: number;
  cloud: number;
  onlyLocal: string[];
  /** Local-only turns whose session has no local span: never shipped, so invisible to the cloud. */
  unshipped: number;
  onlyCloud: string[];
  /** Shared turns anchored to a different span, or to none on one side. */
  spanDiffers: number;
  /** Shared turns stamped with a different account, or unstamped on one side. */
  accountDiffers: number;
  localJudgedOnly: number;
  cloudJudgedOnly: number;
  selectedLocal: number;
  selectedCloud: number;
  sameSelection: boolean;
  clean: boolean;
}

function byKey(turns: readonly Turn[]): Map<string, Turn> {
  return new Map(turns.map((t) => [turnKey(t), t]));
}

function countMissing(keys: ReadonlySet<string>, other: ReadonlySet<string>): number {
  let n = 0;
  for (const k of keys) if (!other.has(k)) n++;
  return n;
}

export function compareDiscoveries(
  local: { turns: readonly Turn[]; judged: Set<string>; sessionsWithSpans: ReadonlySet<string> },
  cloud: { turns: readonly Turn[]; judged: Set<string> },
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): JudgeParityReport {
  const localTurns = byKey(local.turns);
  const cloudTurns = byKey(cloud.turns);
  const onlyLocal = [...localTurns.keys()].filter((k) => !cloudTurns.has(k));
  const onlyCloud = [...cloudTurns.keys()].filter((k) => !localTurns.has(k));
  const shipped = (t: Turn): boolean => local.sessionsWithSpans.has(t.sessionId) || cloudTurns.has(turnKey(t));
  const unshipped = local.turns.filter((t) => !shipped(t)).length;

  let spanDiffers = 0;
  let accountDiffers = 0;
  for (const [key, l] of localTurns) {
    const c = cloudTurns.get(key);
    if (!c) continue;
    if (l.spanId !== c.spanId) spanDiffers++;
    if (l.identityKeyRef !== c.identityKeyRef) accountDiffers++;
  }

  const judged = new Set([...local.judged, ...cloud.judged]);
  const opts = { limit, deliverableOnly: true, env };
  // Unshipped turns are left out: the cloud source cannot select what it cannot see.
  const selectedLocal = selectTurns(local.turns.filter(shipped), judged, opts).selected.map(turnKey);
  const selectedCloud = selectTurns(cloud.turns, judged, opts).selected.map(turnKey);
  const sameSelection = selectedLocal.length === selectedCloud.length
    && selectedLocal.every((k, i) => k === selectedCloud[i]);

  return {
    local: localTurns.size,
    cloud: cloudTurns.size,
    onlyLocal,
    unshipped,
    onlyCloud,
    spanDiffers,
    accountDiffers,
    localJudgedOnly: countMissing(local.judged, cloud.judged),
    cloudJudgedOnly: countMissing(cloud.judged, local.judged),
    selectedLocal: selectedLocal.length,
    selectedCloud: selectedCloud.length,
    sameSelection,
    clean: onlyLocal.length === unshipped && onlyCloud.length === 0 && sameSelection,
  };
}

function parseLimit(argv: readonly string[]): number {
  return positiveIntArg(LIMIT_ARG, parseCli(argv, { values: [LIMIT_ARG] }).value(LIMIT_ARG)) ?? DEFAULT_LIMIT;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dates = resolveDateScope(argv);
  if (!dates) {
    console.error(`${CLI_PREFIX} pass --date=YYYY-MM-DD or --days=N`);
    return EXIT_ERROR;
  }
  const limit = parseLimit(argv);
  console.log(`${CLI_PREFIX} dates: ${[...dates].sort().join(', ')} limit=${limit}`);

  const local = await discoverTurns('local', dates);
  const cloud = await discoverTurns('cloud', dates);
  const report = compareDiscoveries(
    { turns: local.turns, judged: local.loadExistingKeys(), sessionsWithSpans: new Set(local.accounts.sessionSpans.keys()) },
    { turns: cloud.turns, judged: cloud.loadExistingKeys() },
    limit,
  );

  const { onlyLocal, onlyCloud, ...counts } = report;
  console.table({ ...counts, onlyLocal: onlyLocal.length, onlyCloud: onlyCloud.length });
  for (const k of onlyLocal.slice(0, SAMPLE_LIMIT)) console.log(`  onlyLocal: ${k}`);
  for (const k of onlyCloud.slice(0, SAMPLE_LIMIT)) console.log(`  onlyCloud: ${k}`);
  console.log(`${CLI_PREFIX} ${report.clean ? 'parity: same turns discovered and selected' : 'parity: sources differ'}`);
  return report.clean ? EXIT_MATCH : EXIT_MISMATCH;
}

runIfMain(import.meta.url, main, CLI_PREFIX, { fatalExitCode: EXIT_ERROR });
