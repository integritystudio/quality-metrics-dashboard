#!/usr/bin/env tsx
/**
 * Flag background sessions whose turns ran without hooks.
 *
 * A background Claude Code session (`sessionKind: 'bg'` on its transcript
 * entries) records a `stop_hook_summary` system entry before each turn's
 * `turn_duration` when the Stop hook runs. A turn closed without one ran no
 * hooks, so it wrote no span, log or metric: its telemetry is gone for good
 * and nothing else reports it. Seen 2026-11-20 on CLI 2.1.330, where every
 * background session launched from `~` ran no hooks at all.
 *
 * Turns shorter than `MIN_GAP_TURN_MS` are ignored: usage-limit notices and
 * agent messages close sub-second turns without the Stop hook, and they carry
 * no work.
 *
 * Reads only the transcripts on this machine. Exits `HOOK_GAP_EXIT_FOUND` when
 * a session not yet acknowledged has a gap in the window, so the launchd
 * wrapper logs it. Acknowledged gaps are listed in `hook-gap-known.json`
 * beside this script: a session id, the last gap turn acknowledged
 * (`through`), and a reason. Gap turns up to `through` are still printed, as
 * known, but no longer fail the run; a later gap in the same session does. A
 * file that does not parse acknowledges nothing.
 *
 * Usage: tsx hook-gap-check.ts [--days=N | --date=YYYY-MM-DD]
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { TIME_MS } from '../../src/lib/core/units.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';
import { TRANSCRIPT_DIRS, UUID_PREFIX_REGEX } from './transcript-turns.js';
import { dateScopeBounds } from './cloud-trace-source.js';
import { readScope, resolveDateScope } from './derive-evaluations.js';
import { HOOK_GAP_EXIT_FOUND, JUDGE_DEFAULT_DAYS, rejectRemovedFlags } from './pipeline-stages.js';
import { exitOnCliArgError } from './cli-args.js';
import { runIfMain } from './cli-main.js';

const CLI_PREFIX = '[hook-gap]';
/** Gaps already acknowledged; see the module comment. */
export const KNOWN_HOOK_GAPS_FILE = join(import.meta.dirname, 'hook-gap-known.json');

const knownHookGapsSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string().min(1), through: z.iso.datetime(), reason: z.string().min(1) })),
});
/** Turns shorter than this are system notices, not work; see the module comment. */
// eslint-disable-next-line local/no-magic-numbers-ignore-bitwise -- the multiplier is the named constant's value
export const MIN_GAP_TURN_MS = 5 * TIME_MS.SECOND;
const BACKGROUND_SESSION_KIND = 'bg';
const STOP_HOOK_SUMMARY = 'stop_hook_summary';
const TURN_DURATION = 'turn_duration';
const SYSTEM_ENTRY = 'system';
/** Lines worth parsing; every other transcript line is skipped unparsed. */
const RELEVANT_MARKERS = [STOP_HOOK_SUMMARY, TURN_DURATION, 'sessionKind', '"cwd"'] as const;

export type SessionHookGaps = {
  sessionId: string;
  /** Launch directory: the first `cwd` the transcript records. */
  cwd: string | undefined;
  turns: number;
  /** Timestamps of turns in the window that closed without a Stop-hook summary. */
  gapTurns: string[];
};

type TranscriptEntry = {
  type?: unknown;
  subtype?: unknown;
  sessionKind?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  durationMs?: unknown;
};

function isWithin(atMs: number, fromMs: number, toMs: number): boolean {
  return atMs >= fromMs && atMs <= toMs;
}

/** A closed turn's end time and length, or undefined for any other entry. */
function closedTurn(entry: TranscriptEntry): { atMs: number; durationMs: number } | undefined {
  if (entry.type !== SYSTEM_ENTRY || entry.subtype !== TURN_DURATION) return undefined;
  return {
    atMs: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN,
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
  };
}

/**
 * The hook gaps in one transcript's entries, or undefined when it is not a
 * background session. Only turns closed inside `[fromMs, toMs]` count.
 */
export function findHookGaps(
  sessionId: string,
  entries: Iterable<TranscriptEntry>,
  fromMs: number,
  toMs: number,
): SessionHookGaps | undefined {
  let isBackground = false;
  let cwd: string | undefined;
  let stopHookRan = false;
  const result: SessionHookGaps = { sessionId, cwd: undefined, turns: 0, gapTurns: [] };
  for (const entry of entries) {
    if (entry.sessionKind === BACKGROUND_SESSION_KIND) isBackground = true;
    if (cwd === undefined && typeof entry.cwd === 'string') cwd = entry.cwd;
    if (entry.type === SYSTEM_ENTRY && entry.subtype === STOP_HOOK_SUMMARY) { stopHookRan = true; continue; }
    const turn = closedTurn(entry);
    if (!turn) continue;
    const { atMs, durationMs } = turn;
    if (isWithin(atMs, fromMs, toMs)) {
      result.turns++;
      if (!stopHookRan && durationMs >= MIN_GAP_TURN_MS) result.gapTurns.push(String(entry.timestamp));
    }
    stopHookRan = false;
  }
  return isBackground ? { ...result, cwd } : undefined;
}

/** The relevant entries of a transcript file, parsed; unreadable lines are skipped. */
async function readRelevantEntries(path: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!RELEVANT_MARKERS.some((marker) => line.includes(marker))) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // A partly written last line; the next run reads it whole.
    }
  }
  return entries;
}

/** Transcript files under `dirs` (`<dir>/<slug>/<sessionId>.jsonl`) modified at or after `sinceMs`. */
export function recentTranscripts(dirs: readonly string[], sinceMs: number): Array<{ sessionId: string; path: string }> {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const slug of readdirSync(dir)) {
      const slugPath = join(dir, slug);
      if (!statSync(slugPath).isDirectory()) continue;
      for (const file of readdirSync(slugPath)) {
        const sessionId = basename(file, '.jsonl');
        if (!file.endsWith('.jsonl') || !UUID_PREFIX_REGEX.test(sessionId) || found.has(sessionId)) continue;
        const path = join(slugPath, file);
        if (statSync(path).mtimeMs >= sinceMs) found.set(sessionId, path);
      }
    }
  }
  return [...found].map(([sessionId, path]) => ({ sessionId, path }));
}

/** Every background session with a hook gap in `[fromMs, toMs]`. */
export async function scanHookGaps(dirs: readonly string[], fromMs: number, toMs: number): Promise<SessionHookGaps[]> {
  const withGaps: SessionHookGaps[] = [];
  for (const { sessionId, path } of recentTranscripts(dirs, fromMs)) {
    // eslint-disable-next-line no-await-in-loop -- one transcript at a time keeps memory to one file's relevant lines
    const gaps = findHookGaps(sessionId, await readRelevantEntries(path), fromMs, toMs);
    if (gaps && gaps.gapTurns.length > 0) withGaps.push(gaps);
  }
  return withGaps;
}

/** Acknowledged gaps: session id to the epoch ms of the last gap turn acknowledged. */
export type KnownHookGaps = ReadonlyMap<string, number>;

/**
 * The acknowledged gaps in `path`: none when the file is absent, and none
 * (logged) when it does not parse, so a broken file never hides a gap.
 */
export function readKnownHookGaps(path: string = KNOWN_HOOK_GAPS_FILE): KnownHookGaps {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = knownHookGapsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return new Map(parsed.data.sessions.map((s) => [s.sessionId, Date.parse(s.through)]));
    console.error(`${CLI_PREFIX} ${path} does not match its schema; no session counts as known`);
  } catch (err) {
    console.error(`${CLI_PREFIX} ${path} is unreadable (${describeUnknown(err)}); no session counts as known`);
  }
  return new Map();
}

/**
 * Split `found` into gaps already acknowledged and gaps that should fail the
 * run. A session's gap turns after its `through` are new, so the session lands
 * in `unknown` carrying only those turns.
 */
export function partitionKnown(found: readonly SessionHookGaps[], known: KnownHookGaps): { known: SessionHookGaps[]; unknown: SessionHookGaps[] } {
  const split: { known: SessionHookGaps[]; unknown: SessionHookGaps[] } = { known: [], unknown: [] };
  for (const s of found) {
    const throughMs = known.get(s.sessionId);
    const newTurns = throughMs === undefined ? s.gapTurns : s.gapTurns.filter((at) => !(Date.parse(at) <= throughMs));
    if (newTurns.length === 0) split.known.push(s);
    else split.unknown.push({ ...s, gapTurns: newTurns });
  }
  return split;
}

function describeGaps(s: SessionHookGaps): string {
  return `${s.sessionId} cwd=${s.cwd ?? '?'} ${s.gapTurns.length}/${s.turns} turns without hooks, first ${s.gapTurns[0] ?? '?'}, last ${s.gapTurns.at(-1) ?? '?'}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dates = exitOnCliArgError(`${CLI_PREFIX} Error:`, () => {
    rejectRemovedFlags(args);
    return readScope(resolveDateScope(args), JUDGE_DEFAULT_DAYS);
  });
  const { fromMs, toMs } = dateScopeBounds(dates);
  let found: SessionHookGaps[];
  try {
    found = await scanHookGaps(TRANSCRIPT_DIRS, fromMs, toMs);
  } catch (err) {
    // A read failure says nothing about hooks; leave the run's exit to the other stages.
    console.error(`${CLI_PREFIX} scan failed: ${describeUnknown(err)}`);
    return;
  }
  if (found.length === 0) {
    console.log(`${CLI_PREFIX} no background session ran a turn without hooks`);
    return;
  }
  const { known, unknown } = partitionKnown(found, readKnownHookGaps());
  for (const s of known) console.log(`${CLI_PREFIX} known: ${describeGaps(s)}`);
  if (unknown.length === 0) {
    console.log(`${CLI_PREFIX} no new background session ran a turn without hooks (${known.length} known)`);
    return;
  }
  for (const s of unknown) console.error(`${CLI_PREFIX} ${describeGaps(s)}`);
  console.error(`${CLI_PREFIX} ${unknown.length} background sessions lost telemetry: their hooks did not run. Acknowledge one in ${KNOWN_HOOK_GAPS_FILE}`);
  process.exitCode = HOOK_GAP_EXIT_FOUND;
}

runIfMain(import.meta.url, main, CLI_PREFIX);
