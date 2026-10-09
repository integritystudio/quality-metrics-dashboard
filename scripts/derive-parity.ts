#!/usr/bin/env tsx
/**
 * Derive parity: the Phase 1 exit check of
 * docs/roadmap/dashboard-cloud-read-migration.md. Read-only.
 *
 * Runs the rule derivations over the local trace files and over `/v1/traces`
 * for the same UTC dates, then compares the records. Two records are the same
 * record when they share evaluation name, trace, span and session; they agree
 * when their scores match to `EVAL_SCORE_PRECISION` places. Only records dated
 * inside the scope are compared, the same filter `derive-evaluations` applies
 * before writing.
 *
 * Account stamps are reported, not gated on: a span written before stamping
 * began has no local stamp, and the cloud always knows its account.
 *
 * Usage (needs every account's key, all present under prd):
 *   doppler run --project integrity-studio --config prd -- npm run derive:parity -- --days=3
 *   … -- npm run derive:parity -- --date=2026-09-26
 *
 * Exit: 0 when every record matches, 1 on any difference, 2 on a usage or fetch error.
 */

import { CHECK_EXIT, runIfMain } from './cli-args.js';
import { pushTo } from './collections.js';
import { EVAL_SCORE_PRECISION, type EvalRecord } from './eval-record.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';
import { deriveAll, loadLocalSpans, resolveDateScope } from './derive-evaluations.js';
import { loadCloudSpans } from './cloud-trace-source.js';
import { toDateOnly } from '../src/api/api-constants.js';

const CLI_PREFIX = '[derive:parity]';
const DECIMAL_BASE = 10;
const SCORE_TOLERANCE = DECIMAL_BASE ** -EVAL_SCORE_PRECISION;
const SAMPLE_LIMIT = 5;

export interface NameParity {
  evaluationName: string;
  local: number;
  cloud: number;
  matched: number;
  scoreDiffers: number;
  onlyLocal: number;
  onlyCloud: number;
  stampDiffers: number;
}

export interface ParityReport {
  byName: NameParity[];
  samples: { kind: 'onlyLocal' | 'onlyCloud' | 'scoreDiffers'; key: string; local?: number; cloud?: number }[];
  clean: boolean;
}

function recordKey(r: EvalRecord): string {
  return [r.evaluationName, r.traceId, r.spanId, r.sessionId].join('|');
}

function groupByKey(records: readonly EvalRecord[]): Map<string, EvalRecord[]> {
  const groups = new Map<string, EvalRecord[]>();
  for (const r of records) pushTo(groups, recordKey(r), r);
  return groups;
}

/**
 * Compare two record sets. Records sharing a key are paired in score order,
 * so a key produced twice on one side and once on the other counts one
 * unmatched record, not two.
 */
export function compareRecords(local: readonly EvalRecord[], cloud: readonly EvalRecord[]): ParityReport {
  const byName = new Map<string, NameParity>();
  const entry = (evaluationName: string): NameParity => {
    let e = byName.get(evaluationName);
    if (!e) {
      e = { evaluationName, local: 0, cloud: 0, matched: 0, scoreDiffers: 0, onlyLocal: 0, onlyCloud: 0, stampDiffers: 0 };
      byName.set(evaluationName, e);
    }
    return e;
  };
  for (const r of local) entry(r.evaluationName).local++;
  for (const r of cloud) entry(r.evaluationName).cloud++;

  const samples: ParityReport['samples'] = [];
  const sample = (s: ParityReport['samples'][number]): void => {
    if (samples.filter(x => x.kind === s.kind).length < SAMPLE_LIMIT) samples.push(s);
  };
  const byScore = (a: EvalRecord, b: EvalRecord): number => a.scoreValue - b.scoreValue;
  const localGroups = groupByKey(local);
  const cloudGroups = groupByKey(cloud);

  for (const [key, localList] of localGroups) {
    const cloudList = [...(cloudGroups.get(key) ?? [])].sort(byScore);
    const sortedLocal = [...localList].sort(byScore);
    const name = sortedLocal[0]!.evaluationName;
    const e = entry(name);
    const paired = Math.min(sortedLocal.length, cloudList.length);
    for (let i = 0; i < paired; i++) {
      const l = sortedLocal[i]!;
      const c = cloudList[i]!;
      if (Math.abs(l.scoreValue - c.scoreValue) <= SCORE_TOLERANCE) e.matched++;
      else {
        e.scoreDiffers++;
        sample({ kind: 'scoreDiffers', key, local: l.scoreValue, cloud: c.scoreValue });
      }
      if (l.identityKeyRef !== c.identityKeyRef) e.stampDiffers++;
    }
    for (let i = paired; i < sortedLocal.length; i++) {
      e.onlyLocal++;
      sample({ kind: 'onlyLocal', key, local: sortedLocal[i]!.scoreValue });
    }
    for (let i = paired; i < cloudList.length; i++) {
      e.onlyCloud++;
      sample({ kind: 'onlyCloud', key, cloud: cloudList[i]!.scoreValue });
    }
  }
  for (const [key, cloudList] of cloudGroups) {
    if (localGroups.has(key)) continue;
    const e = entry(cloudList[0]!.evaluationName);
    e.onlyCloud += cloudList.length;
    sample({ kind: 'onlyCloud', key, cloud: cloudList[0]!.scoreValue });
  }

  const rows = [...byName.values()].sort((a, b) => a.evaluationName.localeCompare(b.evaluationName));
  return {
    byName: rows,
    samples,
    clean: rows.every(r => r.scoreDiffers === 0 && r.onlyLocal === 0 && r.onlyCloud === 0),
  };
}

function inScope(records: readonly EvalRecord[], dates: ReadonlySet<string>): EvalRecord[] {
  return records.filter(r => dates.has(toDateOnly(r.timestamp)));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dates = resolveDateScope(argv);
  if (!dates) {
    console.error(`${CLI_PREFIX} pass --date=YYYY-MM-DD or --days=N`);
    return CHECK_EXIT.ERROR;
  }
  console.log(`${CLI_PREFIX} dates: ${[...dates].sort().join(', ')}`);

  const local = inScope(deriveAll(loadLocalSpans(TELEMETRY_DIR, dates)), dates);
  const cloud = inScope(deriveAll(await loadCloudSpans(dates)), dates);
  const report = compareRecords(local, cloud);

  console.table(report.byName);
  for (const s of report.samples) console.log(`  ${s.kind}: ${s.key} local=${s.local ?? '-'} cloud=${s.cloud ?? '-'}`);
  console.log(`${CLI_PREFIX} ${report.clean ? 'parity: every record matches' : 'parity: records differ'}`);
  return report.clean ? CHECK_EXIT.PASS : CHECK_EXIT.FAIL;
}

runIfMain(import.meta.url, main, CLI_PREFIX, { fatalExitCode: CHECK_EXIT.ERROR });
