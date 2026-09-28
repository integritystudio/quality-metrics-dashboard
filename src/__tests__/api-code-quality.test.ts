/**
 * API route test: /api/code-quality.
 *
 * Fixture HTTP server, real queryTraces and data-loader (see api-agents.test.ts).
 * Pins the cohort (CSV2) and content-kind (CSV3a) split: baseline and doc rows
 * are reported apart from scored code, and spans written before either
 * attribute existed read as scored code. It is also the route's first test:
 * a checkpoint limit above queryTraces' 1000 maximum 500'd every request.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, spanToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { codeQualityRoutes } from '../api/routes/code-quality.js';
import type { CodeQualityResponse } from '../api/routes/code-quality.js';

const NS_PER_MS = 1_000_000n;
const RECENT_NS = BigInt(Date.now()) * NS_PER_MS;
const SPAN_DURATION_NS = 1_000n * NS_PER_MS;
const AGENT = 'agent-auditor';
const BASELINE_AGENT = 'general-purpose';
const VERSION = '2026-09-24';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

let spanSeq = 0;

function checkpoint(attrs: Record<string, unknown>) {
  spanSeq++;
  return spanToWire({
    traceId: `trace-${spanSeq}`,
    spanId: `span-${spanSeq}`,
    name: 'code-survival-checkpoint',
    startTimeUnixNano: RECENT_NS,
    endTimeUnixNano: RECENT_NS + SPAN_DURATION_NS,
    attributes: {
      'integritystudio.code.event': 'survival_checkpoint',
      'gen_ai.agent.name': AGENT,
      'gen_ai.agent.version': VERSION,
      'integritystudio.code.checkpoint_window': '21d',
      'integritystudio.code.quality.survival_rate': 0.9,
      'integritystudio.code.quality.churn_rate': 0.1,
      'integritystudio.code.quality.deletion_rate': 0,
      ...attrs,
    },
  });
}

function invocation(attrs: Record<string, unknown>, agentName = AGENT) {
  spanSeq++;
  return spanToWire({
    traceId: `trace-${spanSeq}`,
    spanId: `span-${spanSeq}`,
    name: `invoke_agent ${agentName}`,
    startTimeUnixNano: RECENT_NS,
    endTimeUnixNano: RECENT_NS + SPAN_DURATION_NS,
    attributes: {
      'integritystudio.code.event': 'generated',
      'gen_ai.agent.name': agentName,
      'gen_ai.agent.version': VERSION,
      ...attrs,
    },
  });
}

async function get(): Promise<CodeQualityResponse> {
  const res = await codeQualityRoutes.request('/code-quality');
  expect(res.status).toBe(200);
  return (await res.json()) as CodeQualityResponse;
}

describe('GET /code-quality', () => {
  it('keeps scored code, baseline code and doc checkpoints in separate rows', async () => {
    fixture.setTraces([
      checkpoint({ 'integritystudio.code.survival.cohort': 'scored', 'integritystudio.code.content_kind': 'code' }),
      checkpoint({
        'gen_ai.agent.name': BASELINE_AGENT,
        'integritystudio.code.survival.cohort': 'baseline',
        'integritystudio.code.content_kind': 'code',
        'integritystudio.code.quality.survival_rate': 0.5,
      }),
      checkpoint({
        'integritystudio.code.survival.cohort': 'scored',
        'integritystudio.code.content_kind': 'doc',
        'integritystudio.code.quality.survival_rate': 0,
      }),
    ]);

    const body = await get();

    const rows = body.survivalByAgentWindow.map(r => [r.agentName, r.cohort, r.contentKind, r.avgSurvivalRate]);
    expect(rows).toEqual(expect.arrayContaining([
      [AGENT, 'scored', 'code', 0.9],
      [BASELINE_AGENT, 'baseline', 'code', 0.5],
      [AGENT, 'scored', 'doc', 0],
    ]));
    expect(rows).toHaveLength(3);
  });

  it('reads a checkpoint with neither attribute as scored code', async () => {
    fixture.setTraces([checkpoint({})]);

    const [row] = (await get()).survivalByAgentWindow;

    expect(row).toMatchObject({ cohort: 'scored', contentKind: 'code' });
  });

  it('reads rates the cloud returns as strings, as the live API does', async () => {
    fixture.setTraces([checkpoint({
      'integritystudio.code.quality.survival_rate': '0.75',
      'integritystudio.code.quality.churn_rate': '0.25',
    })]);

    const [row] = (await get()).survivalByAgentWindow;

    expect(row).toMatchObject({ avgSurvivalRate: 0.75, avgChurnRate: 0.25 });
  });

  it('labels baseline invocations in the version rollout', async () => {
    fixture.setTraces([
      invocation({ 'integritystudio.code.survival.cohort': 'scored' }),
      invocation({ 'integritystudio.code.survival.cohort': 'baseline' }, BASELINE_AGENT),
    ]);

    const byAgent = Object.fromEntries((await get()).versionRollout.map(r => [r.agentName, r.cohort]));

    expect(byAgent).toEqual({ [AGENT]: 'scored', [BASELINE_AGENT]: 'baseline' });
  });
});
