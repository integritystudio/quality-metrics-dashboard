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
import { createFixtureServer, spanToWire, type FixtureServer } from './support/fixture-server.js';

import { codeQualityRoutes, type CodeQualityResponse } from '../api/routes/code-quality.js';
import { GENAI_AGENT_ATTRIBUTES } from '../lib/otel-attributes.js';
import { CODE_ATTRIBUTES } from '../lib/hook-attributes.js';
import { TIME_MS } from '../lib/constants.js';
import { HttpStatus } from '../lib/http-constants.js';

const NS_PER_MS = 1_000_000n;
const RECENT_NS = BigInt(Date.now()) * NS_PER_MS;
const SPAN_DURATION_NS = BigInt(TIME_MS.SECOND) * NS_PER_MS;
const AGENT = 'agent-auditor';
const BASELINE_AGENT = 'general-purpose';
const VERSION = '2026-09-24';
const SURVIVAL_RATE = 0.9;
const BASELINE_SURVIVAL_RATE = 0.5;
const SEED_CHANGE_ID_LENGTH = 40;

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

function checkpoint(attrs: Record<string, unknown>, startNs = RECENT_NS) {
  spanSeq++;
  return spanToWire({
    traceId: `trace-${spanSeq}`,
    spanId: `span-${spanSeq}`,
    name: 'code-survival-checkpoint',
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs + SPAN_DURATION_NS,
    attributes: {
      [CODE_ATTRIBUTES.EVENT]: 'survival_checkpoint',
      [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: AGENT,
      [GENAI_AGENT_ATTRIBUTES.AGENT_VERSION]: VERSION,
      [CODE_ATTRIBUTES.CHECKPOINT_WINDOW]: '21d',
      [CODE_ATTRIBUTES.SURVIVAL_RATE]: SURVIVAL_RATE,
      [CODE_ATTRIBUTES.CHURN_RATE]: 0.1,
      [CODE_ATTRIBUTES.DELETION_RATE]: 0,
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
      [CODE_ATTRIBUTES.EVENT]: 'generated',
      [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: agentName,
      [GENAI_AGENT_ATTRIBUTES.AGENT_VERSION]: VERSION,
      ...attrs,
    },
  });
}

async function get(): Promise<CodeQualityResponse> {
  const res = await codeQualityRoutes.request('/code-quality');
  expect(res.status).toBe(HttpStatus.Ok);
  return (await res.json()) as CodeQualityResponse;
}

describe('GET /code-quality', () => {
  it('keeps scored code, baseline code and doc checkpoints in separate rows', async () => {
    const checkpoints = [
      checkpoint({ [CODE_ATTRIBUTES.SURVIVAL_COHORT]: 'scored', [CODE_ATTRIBUTES.CONTENT_KIND]: 'code' }),
      checkpoint({
        [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: BASELINE_AGENT,
        [CODE_ATTRIBUTES.SURVIVAL_COHORT]: 'baseline',
        [CODE_ATTRIBUTES.CONTENT_KIND]: 'code',
        [CODE_ATTRIBUTES.SURVIVAL_RATE]: BASELINE_SURVIVAL_RATE,
      }),
      checkpoint({
        [CODE_ATTRIBUTES.SURVIVAL_COHORT]: 'scored',
        [CODE_ATTRIBUTES.CONTENT_KIND]: 'doc',
        [CODE_ATTRIBUTES.SURVIVAL_RATE]: 0,
      }),
    ];
    fixture.setTraces(checkpoints);

    const body = await get();

    const rows = body.survivalByAgentWindow.map(r => [r.agentName, r.cohort, r.contentKind, r.avgSurvivalRate]);
    expect(rows).toEqual(expect.arrayContaining([
      [AGENT, 'scored', 'code', SURVIVAL_RATE],
      [BASELINE_AGENT, 'baseline', 'code', BASELINE_SURVIVAL_RATE],
      [AGENT, 'scored', 'doc', 0],
    ]));
    expect(rows).toHaveLength(checkpoints.length);
  });

  it('reads a checkpoint with neither attribute as scored code', async () => {
    fixture.setTraces([checkpoint({})]);

    const [row] = (await get()).survivalByAgentWindow;

    expect(row).toMatchObject({ cohort: 'scored', contentKind: 'code' });
  });

  it('reads rates the cloud returns as strings, as the live API does', async () => {
    fixture.setTraces([checkpoint({
      [CODE_ATTRIBUTES.SURVIVAL_RATE]: '0.75',
      [CODE_ATTRIBUTES.CHURN_RATE]: '0.25',
    })]);

    const [row] = (await get()).survivalByAgentWindow;

    expect(row).toMatchObject({ avgSurvivalRate: 0.75, avgChurnRate: 0.25 });
  });

  it('counts a re-measured checkpoint once, at its latest span, whatever order the spans arrive in', async () => {
    const SEED = 'a'.repeat(SEED_CHANGE_ID_LENGTH);
    const OTHER_SEED = 'b'.repeat(SEED_CHANGE_ID_LENGTH);
    const EARLIER_NS = RECENT_NS - SPAN_DURATION_NS;
    const LATEST_RATE = 0.8;
    const SUPERSEDED_RATE = 0.2;
    const OTHER_SEED_RATE = 0.4;
    fixture.setTraces([
      checkpoint({ [CODE_ATTRIBUTES.SEED_CHANGE_ID]: SEED, [CODE_ATTRIBUTES.SURVIVAL_RATE]: LATEST_RATE }),
      // The superseded span arrives after the one that replaced it.
      checkpoint({ [CODE_ATTRIBUTES.SEED_CHANGE_ID]: SEED, [CODE_ATTRIBUTES.SURVIVAL_RATE]: SUPERSEDED_RATE }, EARLIER_NS),
      checkpoint({ [CODE_ATTRIBUTES.SEED_CHANGE_ID]: OTHER_SEED, [CODE_ATTRIBUTES.SURVIVAL_RATE]: OTHER_SEED_RATE }),
    ]);

    const [row] = (await get()).survivalByAgentWindow;

    expect(row?.checkpointCount).toBe(2);
    expect(row?.avgSurvivalRate).toBeCloseTo((LATEST_RATE + OTHER_SEED_RATE) / 2);
  });

  it('labels baseline invocations in the version rollout', async () => {
    fixture.setTraces([
      invocation({ [CODE_ATTRIBUTES.SURVIVAL_COHORT]: 'scored' }),
      invocation({ [CODE_ATTRIBUTES.SURVIVAL_COHORT]: 'baseline' }, BASELINE_AGENT),
    ]);

    const byAgent = Object.fromEntries((await get()).versionRollout.map(r => [r.agentName, r.cohort]));

    expect(byAgent).toEqual({ [AGENT]: 'scored', [BASELINE_AGENT]: 'baseline' });
  });
});
