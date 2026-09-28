import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EvaluationResult } from '../../../src/backends/index.js';
import type { LocalTraceSpan } from '../../../src/lib/validation/dashboard-schemas.js';
import {
  indexCloudSpans,
  judgedKeys,
  spanScopeDates,
  transcriptsForSessions,
} from '../judge-cloud-source.js';
import { anchorTurns, RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, type Turn } from '../judge-evaluations.js';
import { turnSkip } from '../judge-selection.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SESSION = '1a2b3c4d-0000-4000-8000-000000000001';
const TURN_AT = '2026-09-27T10:00:00.500Z';
const TURN_MS = Date.parse(TURN_AT);
const NS_PER_MS = 1_000_000n;
const MS_PER_S = 1000;
const NS_PER_MS_NUM = 1_000_000;

function span(spanId: string, atMs: number, sessionId = SESSION): LocalTraceSpan {
  const hrt: [number, number] = [Math.floor(atMs / MS_PER_S), (atMs % MS_PER_S) * NS_PER_MS_NUM];
  return {
    traceId: TRACE_ID,
    spanId,
    name: 'hook:builtin-post-tool',
    startTime: hrt,
    endTime: hrt,
    duration: [0, 0],
    attributes: { 'session.id': sessionId },
  };
}

function turn(extra: Partial<Turn> = {}): Turn {
  return { sessionId: SESSION, traceId: '', timestamp: TURN_AT, userText: 'q', assistantText: 'a', toolResults: [], ...extra };
}

function row(name: string, extra: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    timestamp: BigInt(TURN_MS) * NS_PER_MS,
    evaluationName: name,
    sessionId: SESSION,
    ...extra,
  };
}

describe('spanScopeDates', () => {
  it('adds the day after the last date once it has started, for spans past midnight', () => {
    const now = Date.parse('2026-09-28T06:00:00.000Z');

    expect([...spanScopeDates(new Set(['2026-09-26', '2026-09-27']), now)].sort())
      .toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
  });

  it('adds nothing when the next day is still in the future', () => {
    const now = Date.parse('2026-09-28T06:00:00.000Z');

    expect([...spanScopeDates(new Set(['2026-09-28']), now)]).toEqual(['2026-09-28']);
  });
});

describe('indexCloudSpans', () => {
  it('stamps each span with the account that read it, so a turn anchors to that account and span', () => {
    const accounts = indexCloudSpans({
      spans: [span('00000000000000b1', TURN_MS + 10)],
      accounts: new Map([['00000000000000b1', 'OBTOOL_API_KEY_B']]),
    });
    const t = turn();

    anchorTurns([t], accounts);

    expect(t).toMatchObject({ identityKeyRef: 'OBTOOL_API_KEY_B', spanId: '00000000000000b1', traceId: TRACE_ID });
  });

  it('leaves a span no account claimed unstamped, never withheld', () => {
    const accounts = indexCloudSpans({ spans: [span('00000000000000b1', TURN_MS + 10)], accounts: new Map() });
    const t = turn();

    anchorTurns([t], accounts);

    expect(t.identityKeyRef).toBeUndefined();
    expect(t.spanId).toBe('00000000000000b1');
  });
});

describe('judgedKeys', () => {
  it('marks a turn judged when the cloud holds a row per criterion at its event time', () => {
    const keys = judgedKeys([row(RELEVANCE_EVAL_NAME), row(COHERENCE_EVAL_NAME)]);

    expect(turnSkip(turn(), keys, { deliverableOnly: false })).toBe('judged');
  });

  it('dates a pre-event-time row by its evaluatedAtMs attribute, not its receipt time', () => {
    const receivedNs = BigInt(TURN_MS + 36 * 3_600_000) * NS_PER_MS;
    const legacy = (name: string) => row(name, { timestamp: receivedNs, attributes: { evaluatedAtMs: TURN_MS } });

    expect(turnSkip(turn(), judgedKeys([legacy(RELEVANCE_EVAL_NAME), legacy(COHERENCE_EVAL_NAME)]), { deliverableOnly: false }))
      .toBe('judged');
  });

  it('skips a row with no session, which scores no transcript turn', () => {
    expect(judgedKeys([row(RELEVANCE_EVAL_NAME, { sessionId: undefined })]).size).toBe(0);
  });
});

describe('transcriptsForSessions', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'judge-cloud-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function transcript(dir: string, slug: string, sessionId: string): string {
    mkdirSync(join(root, dir, slug), { recursive: true });
    const path = join(root, dir, slug, `${sessionId}.jsonl`);
    writeFileSync(path, '');
    return path;
  }

  it('finds a named session under any slug and counts the sessions it cannot find', () => {
    const path = transcript('projects', '-Users-x-repo', SESSION);

    const found = transcriptsForSessions([SESSION, '9f9f9f9f-0000-4000-8000-000000000009'], [join(root, 'projects')]);

    expect(found.transcripts).toEqual([{ path, sessionId: SESSION, traceId: '' }]);
    expect(found.missing).toBe(1);
  });

  it('takes the first directory that holds the transcript', () => {
    const first = transcript('a', 'slug', SESSION);
    transcript('b', 'slug', SESSION);

    expect(transcriptsForSessions([SESSION], [join(root, 'a'), join(root, 'b')]).transcripts[0]?.path).toBe(first);
  });
});
