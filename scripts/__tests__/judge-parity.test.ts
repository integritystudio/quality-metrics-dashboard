import { describe, it, expect } from 'vitest';

import { compareDiscoveries, turnKey } from '../judge-parity.js';
import { COHERENCE_EVAL_NAME, RELEVANCE_EVAL_NAME, type Turn } from '../judge-evaluations.js';

const ENV = { OBTOOL_API_KEY: 'k' };
const LIMIT = 10;

function turn(session: string, second: number, extra: Partial<Turn> = {}): Turn {
  return {
    sessionId: session,
    traceId: '',
    timestamp: `2026-09-27T10:00:0${second}.000Z`,
    userText: 'q',
    assistantText: 'a',
    toolResults: [],
    identityKeyRef: 'OBTOOL_API_KEY',
    ...extra,
  };
}

function judged(t: Turn): Set<string> {
  return new Set([RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME].map((n) => `${t.sessionId}:${n}:${t.timestamp.slice(0, 19)}`));
}

const side = (turns: Turn[], judgedSet = new Set<string>(), sessions = ['s1']) =>
  ({ turns, judged: judgedSet, sessionsWithSpans: new Set(sessions) });

describe('compareDiscoveries', () => {
  it('is clean when both sources find and select the same turns', () => {
    const turns = [turn('s1', 1), turn('s1', 2)];

    const report = compareDiscoveries(side(turns), side(turns.map((t) => ({ ...t }))), LIMIT, ENV);

    expect(report).toMatchObject({ local: 2, cloud: 2, sameSelection: true, clean: true });
  });

  it('forgives a local-only turn whose session shipped no spans, since the cloud cannot know it', () => {
    const shared = turn('s1', 1);
    const unshipped = turn('s-quiet', 2);

    const report = compareDiscoveries(side([shared, unshipped]), side([{ ...shared }]), LIMIT, ENV);

    expect(report).toMatchObject({ unshipped: 1, onlyLocal: [turnKey(unshipped)], clean: true });
  });

  it('fails on a local-only turn whose session did ship spans', () => {
    const shared = turn('s1', 1);
    const dropped = turn('s1', 2);

    expect(compareDiscoveries(side([shared, dropped]), side([{ ...shared }]), LIMIT, ENV).clean).toBe(false);
  });

  it('fails on a cloud-only turn', () => {
    const shared = turn('s1', 1);

    expect(compareDiscoveries(side([shared]), side([{ ...shared }, turn('s1', 2)]), LIMIT, ENV).clean).toBe(false);
  });

  it('selects from one union dedup set, so a turn judged on only one side does not split the selection', () => {
    const a = turn('s1', 1);
    const b = turn('s1', 2);

    const report = compareDiscoveries(side([a, b], judged(a)), side([{ ...a }, { ...b }]), LIMIT, ENV);

    expect(report).toMatchObject({ localJudgedOnly: 2, selectedLocal: 1, selectedCloud: 1, sameSelection: true });
  });

  it('reports an account the cloud knows and the local files do not, without failing on it', () => {
    const local = turn('s1', 1, { identityKeyRef: undefined });

    const report = compareDiscoveries(side([local]), side([{ ...local, identityKeyRef: 'OBTOOL_API_KEY' }]), LIMIT, {
      ...ENV,
      INJECT_HMAC_SECRET: 's',
    });

    expect(report).toMatchObject({ accountDiffers: 1, clean: true });
  });
});
