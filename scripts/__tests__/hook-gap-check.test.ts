import { describe, it, expect } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from './support/temp-dir.js';
import { findHookGaps, KNOWN_HOOK_GAPS_FILE, MIN_GAP_TURN_MS, partitionKnown, readKnownHookGaps, recentTranscripts, scanHookGaps, type SessionHookGaps } from '../hook-gap-check.js';
import { TIME_MS } from '../../../src/lib/core/units.js';

const SESSION_ID = '07b8582d-309f-4668-ae6f-3061abf8aa80';
const OTHER_SESSION_ID = '101032d4-75a9-453b-876b-5b2f0d01f8b1';
const FROM_MS = Date.parse('2026-11-20T00:00:00.000Z');
const TO_MS = Date.parse('2026-11-20T23:59:59.999Z');
const WORK_TURN_FACTOR = 4;
const NOTICE_TURN_DIVISOR = 10;
const WORK_TURN_MS = MIN_GAP_TURN_MS * WORK_TURN_FACTOR;
const NOTICE_TURN_MS = MIN_GAP_TURN_MS / NOTICE_TURN_DIVISOR;
const HOME = '/Users/someone';

const base = { sessionKind: 'bg', cwd: HOME };
const user = (timestamp: string) => ({ ...base, type: 'user', timestamp });
const stopHook = (timestamp: string) => ({ ...base, type: 'system', subtype: 'stop_hook_summary', timestamp });
const turnEnd = (timestamp: string, durationMs = WORK_TURN_MS) => ({ ...base, type: 'system', subtype: 'turn_duration', timestamp, durationMs });

describe('findHookGaps', () => {
  it('flags a turn closed without a Stop-hook summary, and not one that ran it', () => {
    const gaps = findHookGaps(SESSION_ID, [
      user('2026-11-20T22:00:00.000Z'), stopHook('2026-11-20T22:00:30.000Z'), turnEnd('2026-11-20T22:00:30.000Z'),
      user('2026-11-20T23:12:49.000Z'), turnEnd('2026-11-20T23:13:24.000Z'),
    ], FROM_MS, TO_MS);

    expect(gaps).toEqual({ sessionId: SESSION_ID, cwd: HOME, turns: 2, gapTurns: ['2026-11-20T23:13:24.000Z'] });
  });

  it('ignores a sub-threshold system-notice turn', () => {
    const gaps = findHookGaps(SESSION_ID, [user('2026-11-20T02:13:34.000Z'), turnEnd('2026-11-20T02:13:34.000Z', NOTICE_TURN_MS)], FROM_MS, TO_MS);

    expect(gaps?.gapTurns).toEqual([]);
  });

  it('counts only turns inside the window', () => {
    const gaps = findHookGaps(SESSION_ID, [turnEnd('2026-11-19T23:00:00.000Z'), turnEnd('2026-11-20T01:00:00.000Z')], FROM_MS, TO_MS);

    expect(gaps).toMatchObject({ turns: 1, gapTurns: ['2026-11-20T01:00:00.000Z'] });
  });

  it('ignores a session that is not a background one', () => {
    const interactive = { type: 'system', subtype: 'turn_duration', timestamp: '2026-11-20T01:00:00.000Z', durationMs: WORK_TURN_MS };

    expect(findHookGaps(SESSION_ID, [interactive], FROM_MS, TO_MS)).toBeUndefined();
  });
});

describe('scanHookGaps', () => {
  const dir = useTempDir('hook-gap-');

  function writeTranscript(sessionId: string, entries: unknown[], noise = ''): string {
    const slug = join(dir(), '-Users-someone');
    mkdirSync(slug, { recursive: true });
    const path = join(slug, `${sessionId}.jsonl`);
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n${noise}`);
    return path;
  }

  it('reports only the background session that lost its hooks, reading real transcript files', async () => {
    writeTranscript(SESSION_ID, [user('2026-11-20T23:12:49.000Z'), turnEnd('2026-11-20T23:13:24.000Z')], '{"partial');
    writeTranscript(OTHER_SESSION_ID, [user('2026-11-20T23:12:00.000Z'), stopHook('2026-11-20T23:12:20.000Z'), turnEnd('2026-11-20T23:12:20.000Z')]);

    const found = await scanHookGaps([dir()], FROM_MS, TO_MS);

    expect(found.map((s) => [s.sessionId, s.gapTurns.length])).toEqual([[SESSION_ID, 1]]);
  });

  it('skips transcripts last written before the window', () => {
    const path = writeTranscript(SESSION_ID, [turnEnd('2026-11-20T01:00:00.000Z')]);
    const staleSeconds = (FROM_MS - TIME_MS.DAY) / TIME_MS.SECOND;
    utimesSync(path, staleSeconds, staleSeconds);

    expect(recentTranscripts([dir()], FROM_MS)).toEqual([]);
  });
});

describe('known hook gaps', () => {
  const dir = useTempDir('hook-gap-known-');
  const gaps = (sessionId: string): SessionHookGaps => ({ sessionId, cwd: HOME, turns: 1, gapTurns: ['2026-11-20T23:13:24.000Z'] });
  const knownFile = (body: string): string => {
    const path = join(dir(), 'known.json');
    writeFileSync(path, body);
    return path;
  };

  it('fails the run only for sessions not acknowledged', () => {
    const known = readKnownHookGaps(knownFile(JSON.stringify({ sessions: [{ sessionId: SESSION_ID, reason: 'reported upstream' }] })));

    const split = partitionKnown([gaps(SESSION_ID), gaps(OTHER_SESSION_ID)], known);

    expect(split.known.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    expect(split.unknown.map((s) => s.sessionId)).toEqual([OTHER_SESSION_ID]);
  });

  it('acknowledges nothing when the file is absent, malformed, or missing a reason', () => {
    expect(readKnownHookGaps(join(dir(), 'absent.json'))).toEqual(new Set());
    expect(readKnownHookGaps(knownFile('{not json'))).toEqual(new Set());
    expect(readKnownHookGaps(knownFile(JSON.stringify({ sessions: [{ sessionId: SESSION_ID }] })))).toEqual(new Set());
  });

  it('parses the committed list', () => {
    expect(readKnownHookGaps(KNOWN_HOOK_GAPS_FILE).size).toBeGreaterThan(0);
  });
});
