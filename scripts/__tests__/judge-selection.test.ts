import { describe, it, expect } from 'vitest';

import { selectTurns, turnSkip, WEBHOOK_SECRET_ENV } from '../judge-selection.js';
import { COHERENCE_EVAL_NAME, RELEVANCE_EVAL_NAME, type Turn } from '../judge-evaluations.js';

const KEY_REF = 'OBTOOL_API_KEY_TEST';
const ENV = { [KEY_REF]: 'k', [WEBHOOK_SECRET_ENV]: 's' };

function turn(id: string, extra: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'sess-1',
    traceId: '',
    timestamp: `2026-09-20T10:00:0${id}.000Z`,
    userText: 'q',
    assistantText: 'a',
    toolResults: [],
    identityKeyRef: KEY_REF,
    ...extra,
  };
}

/** The dedup keys a turn with no tool results needs: relevance and coherence. */
function judgedKeys(...turns: Turn[]): Set<string> {
  return new Set(turns.flatMap((t) => [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME]
    .map((name) => `${t.sessionId}:${name}:${t.timestamp.slice(0, 19)}`)));
}

const opts = { limit: Number.POSITIVE_INFINITY, deliverableOnly: true, env: ENV };

describe('selectTurns', () => {
  it('applies the limit after skipping judged turns, so a run never re-takes them', () => {
    const [a, b, c, d] = ['1', '2', '3', '4'].map((id) => turn(id)) as [Turn, Turn, Turn, Turn];

    const s = selectTurns([a, b, c, d], judgedKeys(a, b), { ...opts, limit: 1 });

    expect(s.selected).toEqual([c]);
    expect(s).toMatchObject({ discovered: 4, judged: 2, pending: 2 });
  });

  it('selects a turn with any criterion still missing', () => {
    const t = turn('1');
    const onlyRelevance = new Set([`${t.sessionId}:${RELEVANCE_EVAL_NAME}:${t.timestamp.slice(0, 19)}`]);

    expect(selectTurns([t], onlyRelevance, opts).selected).toEqual([t]);
  });

  it('takes the oldest pending turns, whatever order they were discovered in', () => {
    const [t3, t1, t2] = ['3', '1', '2'].map((id) => turn(id)) as [Turn, Turn, Turn];

    expect(selectTurns([t3, t1, t2], new Set(), { ...opts, limit: 2 }).selected).toEqual([t1, t2]);
  });

  it('breaks a timestamp tie by session id', () => {
    const b = turn('1', { sessionId: 'sess-b' });
    const a = turn('1', { sessionId: 'sess-a' });

    expect(selectTurns([b, a], new Set(), opts).selected).toEqual([a, b]);
  });
});

describe('turnSkip', () => {
  it('withholds a turn stamped for an unmapped account', () => {
    expect(turnSkip(turn('1', { identityKeyRef: null }), new Set(), opts)).toBe('withheld');
  });

  it('holds a turn whose account key is not in the environment', () => {
    const t = turn('1', { identityKeyRef: 'OBTOOL_API_KEY_ABSENT' });

    expect(turnSkip(t, new Set(), opts)).toBe('held-for-key');
    expect(selectTurns([t], new Set(), opts).heldForKey).toEqual({ OBTOOL_API_KEY_ABSENT: 1 });
  });

  it('holds an unstamped turn when the webhook secret is missing, since the webhook is its route', () => {
    const t = turn('1', { identityKeyRef: undefined });

    expect(selectTurns([t], new Set(), { ...opts, env: {} }).heldForKey).toEqual({ [WEBHOOK_SECRET_ENV]: 1 });
    expect(turnSkip(t, new Set(), opts)).toBeUndefined();
  });

  it('judges undeliverable turns when the run posts nothing', () => {
    const local = { deliverableOnly: false, env: {} };

    expect(turnSkip(turn('1', { identityKeyRef: null }), new Set(), local)).toBeUndefined();
    expect(turnSkip(turn('2', { identityKeyRef: undefined }), new Set(), local)).toBeUndefined();
  });

  it('reports a judged turn as judged even when it is also undeliverable', () => {
    const t = turn('1', { identityKeyRef: null });

    expect(turnSkip(t, judgedKeys(t), opts)).toBe('judged');
  });
});
