import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCalibrationEntry, computeSessionDetail, loadCalibrationEntry, TRACE_KEY_TTL_SECONDS, SESSION_KEY_TTL_SECONDS } from '../sync-to-kv.js';
import { CALIBRATION_STATE_DIR } from '../evaluation-constants.js';
import { loadCalibrationState, saveCalibrationState } from '../../../src/lib/quality/qfe-percentiles.js';
import type { CalibrationState } from '@parent/lib/quality/qfe-percentiles.js';
import type { EvaluationResult, TraceSpan } from '../../../src/backends/index.js';
import type { CalibrationResponse } from '../../src/lib/validation/dashboard-schemas.js';
import { SECONDS } from '../../../src/lib/core/units.js';

vi.mock('../../../src/lib/quality/qfe-percentiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/quality/qfe-percentiles.js')>();
  return { ...actual, loadCalibrationState: vi.fn(actual.loadCalibrationState) };
});

/**
 * Parse the entry's value as the type `useCalibration` actually receives.
 *
 * The dashboard is the only consumer of `meta:calibration`, so asserting
 * against its `CalibrationResponse` — rather than the `any` that `JSON.parse`
 * hands back — makes these producer↔consumer contract tests: adding a required
 * field on the consumer side without emitting it here fails the typecheck.
 *
 * The intersection keeps `rawScores`/`psiValues` addressable so the "these are
 * dropped" cases can still assert on keys absent from the contract.
 */
function parseCalibrationPayload(
  state: CalibrationState | null,
): CalibrationResponse & Record<string, unknown> {
  const entry = buildCalibrationEntry(state);
  if (!entry) throw new Error('expected buildCalibrationEntry to produce an entry');
  return JSON.parse(entry.value) as CalibrationResponse & Record<string, unknown>;
}


function makeCalibrationState(overrides: Partial<CalibrationState> = {}): CalibrationState {
  return {
    lastCalibrated: '2026-03-15T10:00:00.000Z',
    distributions: {
      relevance: {
        distribution: { p10: 0.3, p25: 0.5, p50: 0.7, p75: 0.85, p90: 0.95 },
        sampleSize: 120,
        windowStart: '2026-02-13T10:00:00.000Z',
        windowEnd: '2026-03-15T10:00:00.000Z',
      },
      faithfulness: {
        distribution: { p10: 0.4, p25: 0.6, p50: 0.75, p75: 0.88, p90: 0.96 },
        sampleSize: 85,
        windowStart: '2026-02-13T10:00:00.000Z',
        windowEnd: '2026-03-15T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}


describe('buildCalibrationEntry', () => {
  it('produces a meta:calibration KV entry from valid CalibrationState', () => {
    const state = makeCalibrationState();

    const entry = buildCalibrationEntry(state);

    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('meta:calibration');
  });

  it('entry value is valid JSON', () => {
    const state = makeCalibrationState();

    const parsed = parseCalibrationPayload(state);

    expect(parsed).toBeDefined();
  });

  it('transforms distributions to flat PercentileDistribution records (drops window metadata)', () => {
    const state = makeCalibrationState();

    const response = parseCalibrationPayload(state);

    // distributions should map metricName → PercentileDistribution (no sampleSize/windowStart/windowEnd)
    expect(response.distributions).toBeDefined();
    expect(response.distributions.relevance).toEqual({
      p10: 0.3, p25: 0.5, p50: 0.7, p75: 0.85, p90: 0.95,
    });
    expect(response.distributions.faithfulness).toEqual({
      p10: 0.4, p25: 0.6, p50: 0.75, p75: 0.88, p90: 0.96,
    });
    // sampleSize and window metadata must NOT be on the distribution objects.
    // Asserting the exact key set rather than probing two names: it also catches
    // any other CalibrationState field that starts leaking through.
    expect(Object.keys(response.distributions.relevance!).sort())
      .toEqual(['p10', 'p25', 'p50', 'p75', 'p90']);
  });

  it('extracts sampleCounts as a flat Record<string, number>', () => {
    const state = makeCalibrationState();

    const response = parseCalibrationPayload(state);

    expect(response.sampleCounts).toBeDefined();
    expect(response.sampleCounts.relevance).toBe(120);
    expect(response.sampleCounts.faithfulness).toBe(85);
  });

  it('preserves lastCalibrated timestamp verbatim', () => {
    const state = makeCalibrationState({
      lastCalibrated: '2026-03-10T08:30:00.000Z',
    });

    const response = parseCalibrationPayload(state);

    expect(response.lastCalibrated).toBe('2026-03-10T08:30:00.000Z');
  });

  it('drops rawScores from the response payload', () => {
    const state = makeCalibrationState({
      rawScores: { relevance: [0.5, 0.7, 0.8] },
    });

    const response = parseCalibrationPayload(state);

    expect(response.rawScores).toBeUndefined();
  });

  it('drops psiValues from the response payload', () => {
    const state = makeCalibrationState({
      psiValues: { relevance: 0.04 },
    });

    const response = parseCalibrationPayload(state);

    expect(response.psiValues).toBeUndefined();
  });

  it('handles CalibrationState with a single metric', () => {
    const state: CalibrationState = {
      lastCalibrated: '2026-03-01T00:00:00.000Z',
      distributions: {
        coherence: {
          distribution: { p10: 0.2, p25: 0.45, p50: 0.65, p75: 0.8, p90: 0.92 },
          sampleSize: 50,
          windowStart: '2026-02-01T00:00:00.000Z',
          windowEnd: '2026-03-01T00:00:00.000Z',
        },
      },
    };

    const response = parseCalibrationPayload(state);

    expect(Object.keys(response.distributions)).toHaveLength(1);
    expect(response.sampleCounts.coherence).toBe(50);
  });
});

describe('buildCalibrationEntry: graceful skip on missing or invalid state', () => {
  it('returns null when given null (file not found)', () => {
    const result = buildCalibrationEntry(null);

    expect(result).toBeNull();
  });

  it('returns null when given undefined', () => {
    const result = buildCalibrationEntry(undefined as unknown as null);

    expect(result).toBeNull();
  });

  it('returns null when distributions is an empty object', () => {
    const state = makeCalibrationState({ distributions: {} });

    const result = buildCalibrationEntry(state);

    expect(result).toBeNull();
  });
});

describe('KV trace/session TTL constants', () => {
  it('TRACE_KEY_TTL_SECONDS is a positive integer (required by Cloudflare KV)', () => {
    expect(Number.isInteger(TRACE_KEY_TTL_SECONDS)).toBe(true);
    expect(TRACE_KEY_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('SESSION_KEY_TTL_SECONDS is a positive integer (required by Cloudflare KV)', () => {
    expect(Number.isInteger(SESSION_KEY_TTL_SECONDS)).toBe(true);
    expect(SESSION_KEY_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('TRACE_KEY_TTL_SECONDS exceeds the default 30-day query window', () => {
    // Default --days=30 window; TTL must be longer than the query window so entries
    // are not expired before the next sync rewrites them.
    const DEFAULT_QUERY_WINDOW_DAYS = 30;
    expect(TRACE_KEY_TTL_SECONDS).toBeGreaterThan(DEFAULT_QUERY_WINDOW_DAYS * SECONDS.DAY);
  });

  it('SESSION_KEY_TTL_SECONDS exceeds the default 30-day query window', () => {
    const DEFAULT_QUERY_WINDOW_DAYS = 30;
    expect(SESSION_KEY_TTL_SECONDS).toBeGreaterThan(DEFAULT_QUERY_WINDOW_DAYS * SECONDS.DAY);
  });

  it('TRACE_KEY_TTL_SECONDS is exactly 90 days in seconds', () => {
    expect(TRACE_KEY_TTL_SECONDS).toBe(90 * SECONDS.DAY);
  });

  it('SESSION_KEY_TTL_SECONDS is exactly 90 days in seconds', () => {
    expect(SESSION_KEY_TTL_SECONDS).toBe(90 * SECONDS.DAY);
  });
});

describe('org-scoped key helpers (P4)', () => {
  const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';

  it('orgPrefixedKey builds org:<uuid>:<key>', async () => {
    const { orgPrefixedKey } = await import('../sync-to-kv.js');
    expect(orgPrefixedKey(ORG, 'dashboard:7d')).toBe(`org:${ORG}:dashboard:7d`);
  });

  it('stripOrgPrefix removes exactly one org prefix and leaves bare keys alone', async () => {
    const { orgPrefixedKey, stripOrgPrefix } = await import('../sync-to-kv.js');
    expect(stripOrgPrefix(orgPrefixedKey(ORG, 'trend:relevance:7d'))).toBe('trend:relevance:7d');
    expect(stripOrgPrefix('dashboard:7d')).toBe('dashboard:7d');
    // A non-uuid "org:" segment is data, not a scope prefix — must not be stripped.
    expect(stripOrgPrefix('org:not-a-uuid:dashboard:7d')).toBe('org:not-a-uuid:dashboard:7d');
  });

  it('system:lastSync is a bare global key, never org-prefixed', async () => {
    const { SYSTEM_LAST_SYNC_KEY, ORG_KEY_PREFIX_RE } = await import('../sync-to-kv.js');
    expect(ORG_KEY_PREFIX_RE.test(SYSTEM_LAST_SYNC_KEY)).toBe(false);
  });
});

describe('prioritizeTraces with org-prefixed keys (P4)', () => {
  const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';

  it('groups the org-prefixed and bare entries of one trace as a single unit', async () => {
    const { prioritizeTraces } = await import('../sync-to-kv.js');
    const entries = [
      { key: `org:${ORG}:evaluations:trace:t1`, value: '{}' },
      { key: `org:${ORG}:trace:t1`, value: '{}' },
      { key: 'evaluations:trace:t1', value: '{}' },
      { key: 'trace:t1', value: '{}' },
    ];
    const result = prioritizeTraces(entries, new Map(), new Set());
    // All four entries survive, contiguously — one trace, one priority group.
    expect(result).toHaveLength(4);
    expect(new Set(result.map(e => e.key))).toEqual(new Set(entries.map(e => e.key)));
  });
});

describe('buildTraceEntries with bigint timestamps (SYNC-KV-BIGINT)', () => {
  const TRACE_ID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';

  // Typed off the backend contract: CloudBackend builds these fields with
  // BigInt(...) — plain-number fixtures are exactly how this bug stayed hidden.
  const span: TraceSpan = {
    traceId: TRACE_ID,
    spanId: 'a1b2c3d4e5f60718',
    name: 'test-span',
    kind: 'INTERNAL',
    startTimeUnixNano: 1755450000000000000n,
    endTimeUnixNano: 1755450001000000000n,
  };
  const evaluation: EvaluationResult = {
    timestamp: 1755450000500000000n,
    evaluationName: 'relevance',
    scoreValue: 0.9,
    traceId: TRACE_ID,
  };

  it('serializes spans and evaluations without throwing', async () => {
    const { buildTraceEntries } = await import('../sync-to-kv.js');
    const entries = buildTraceEntries(
      [TRACE_ID],
      new Map([[TRACE_ID, [evaluation]]]),
      new Map([[TRACE_ID, [span]]]),
    );

    expect(entries.map(e => e.key)).toEqual([
      `evaluations:trace:${TRACE_ID}`,
      `trace:${TRACE_ID}`,
    ]);
    const trace = JSON.parse(entries[1]!.value) as {
      traceId: string;
      spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }>;
      evaluations: Array<{ timestamp: string }>;
    };
    // bigints land as their decimal-string wire form, which timestampToMs accepts
    expect(trace.spans[0]!.startTimeUnixNano).toBe('1755450000000000000');
    expect(trace.spans[0]!.endTimeUnixNano).toBe('1755450001000000000');
    expect(trace.evaluations[0]!.timestamp).toBe('1755450000500000000');

    const evalsOnly = JSON.parse(entries[0]!.value) as { evaluations: Array<{ timestamp: string }> };
    expect(evalsOnly.evaluations[0]!.timestamp).toBe('1755450000500000000');
  });

  it('toKVValue converts nested bigints anywhere in an entry value', async () => {
    const { toKVValue } = await import('../sync-to-kv.js');
    expect(JSON.parse(toKVValue({ rows: [{ timestamp: 42n }] }))).toEqual({
      rows: [{ timestamp: '42' }],
    });
  });
});

describe('computeSessionDetail multi-agent attribution', () => {
  function span(name: string, attributes: Record<string, unknown>) {
    return { name, traceId: 't1', attributes };
  }

  it('attributes turns by gen_ai.agent.name, the key hooks emit', () => {
    const detail = computeSessionDetail('s1', [
      span('a', { 'gen_ai.agent.name': 'planner' }),
      span('b', { 'gen_ai.agent.name': 'executor' }),
    ], []);

    expect(detail.multiAgentEvaluation.turns.map(t => t.agentName)).toEqual(['planner', 'executor']);
  });

  it('still reads the legacy agent.name key', () => {
    // Two distinct agents: computeMultiAgentEvaluation drops the map below that.
    const detail = computeSessionDetail('s1', [
      span('a', { 'agent.name': 'planner' }),
      span('b', { 'agent.name': 'executor' }),
    ], []);

    expect(detail.multiAgentEvaluation.turns.map(t => t.agentName)).toEqual(['planner', 'executor']);
  });
});

// Regression: the hooks renamed builtin.* on 2026-09-18 and the session detail
// kept reading the legacy keys, so every post-rename tool call surfaced as
// 'unknown' with no error details or file access. Spans reach this function
// through CloudBackend, which canonicalizes both eras, so it reads canonical.
describe('computeSessionDetail after the builtin.* rename', () => {
  const postTool = { 'integritystudio.hook.type': 'builtin', 'integritystudio.hook.trigger': 'PostToolUse' };

  it('counts tool usage by gen_ai.tool.name', () => {
    const detail = computeSessionDetail('s1', [
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Bash' } },
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Bash' } },
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Read' } },
    ], []);

    expect(detail.toolUsage).toEqual({ Bash: 2, Read: 1 });
  });

  it('reports a failed call with its tool, error type and file', () => {
    const detail = computeSessionDetail('s1', [{
      name: 'hook:builtin-post-tool',
      attributes: {
        ...postTool,
        'gen_ai.tool.name': 'Edit',
        'integritystudio.tool.has_error': true,
        'integritystudio.tool.error_type': 'file_not_read',
        'file.path': '/repo/src/a.ts',
      },
    }], []);

    expect(detail.errors.byCategory).toEqual({ 'Edit -> file_not_read': 1 });
    expect(detail.errors.details).toEqual([
      { spanName: 'hook:builtin-post-tool', tool: 'Edit', errorType: 'file_not_read', filePath: '/repo/src/a.ts' },
    ]);
    expect(detail.fileAccess).toEqual([{ path: '/repo/src/a.ts', count: 1 }]);
  });
});

// Regression: the hooks renamed `agent-post-tool` to `agent.operation.finalize`
// on 2026-08-13 and agent activity kept filtering on the old hook name, so every
// session detail reported no agents. The name is copied from a real span.
describe('computeSessionDetail after the agent hook rename', () => {
  const finalize = (agentName: string, hasError: boolean) => ({
    name: 'hook:agent.operation.finalize',
    attributes: {
      'integritystudio.hook.name': 'agent.operation.finalize',
      'gen_ai.agent.name': agentName,
      'integritystudio.agent.has_error': hasError,
      'integritystudio.agent.output_size': 400,
    },
  });

  it('counts invocations and errors per agent from the finalize spans', () => {
    const detail = computeSessionDetail('s1', [
      finalize('Explore', false),
      finalize('Explore', true),
      finalize('code-reviewer', false),
    ], []);

    expect(detail.agentActivity.map(a => [a.agentName, a.invocations, a.errors])).toEqual([
      ['Explore', 2, 1],
      ['code-reviewer', 1, 0],
    ]);
  });
});

// On 2026-09-29 the hooks moved these unprefixed keys under `integritystudio.`.
// Spans reach this function through CloudBackend, which rewrites a legacy key
// only once the alias table has a row for it, so each reader asks for the new
// key and falls back to the old one. Every case writes one session under one
// spelling and expects the same detail. Hook names are copied from real spans.
describe('computeSessionDetail across the integritystudio.* key rename', () => {
  const VENDOR_PREFIX = 'integritystudio.';
  const DECOY_OFFSET = 1000;
  const SESSION_START = { 'project.name': 'env-settings', 'context.message_count': 4, 'context.estimated_tokens': 9000, 'tasks.active': 2 };
  const TOKEN_METRICS = { 'tokens.messages': 12, 'tokens.input': 100, 'tokens.output': 50, 'tokens.cache_read': 7, 'tokens.cache_creation': 3, 'tokens.model': 'claude-opus-5' };
  const MCP_POST_TOOL = { 'mcp.tool': 'get_me' };
  const ALERT_EVALUATION = { 'alerts.triggered_count': 3 };

  type Attributes = Record<string, unknown>;
  const withPrefix = (attrs: Attributes): Attributes =>
    Object.fromEntries(Object.entries(attrs).map(([key, value]) => [`${VENDOR_PREFIX}${key}`, value]));
  const unprefixed = (attrs: Attributes): Attributes => attrs;
  /** The unprefixed keys holding values no reader should surface when the prefixed key is present. */
  const staleUnprefixed = (attrs: Attributes): Attributes =>
    Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, typeof value === 'number' ? value + DECOY_OFFSET : `stale-${String(value)}`]));

  function hookSpan(hookName: string, attributes: Attributes) {
    return { name: `hook:${hookName}`, traceId: 't1', attributes: { 'integritystudio.hook.name': hookName, ...attributes } };
  }

  function sessionSpans(write: (attrs: Attributes) => Attributes) {
    return [
      hookSpan('session-start', write(SESSION_START)),
      hookSpan('token-metrics-extraction', write(TOKEN_METRICS)),
      hookSpan('mcp-post-tool', { 'integritystudio.hook.type': 'mcp', 'integritystudio.hook.trigger': 'PostToolUse', ...write(MCP_POST_TOOL) }),
      hookSpan('telemetry-alert-evaluation', write(ALERT_EVALUATION)),
    ];
  }

  function expectSessionRead(detail: ReturnType<typeof computeSessionDetail>) {
    expect(detail.sessionInfo).toMatchObject({
      projectName: 'env-settings',
      initialMessageCount: 4,
      initialContextTokens: 9000,
      finalMessageCount: 4,
      taskCount: 2,
    });
    expect(detail.tokenProgression).toEqual([
      { messages: 12, inputTokens: 100, outputTokens: 50, cacheRead: 7, cacheCreation: 3, model: 'claude-opus-5' },
    ]);
    expect(detail.mcpUsage).toEqual({ get_me: 1 });
    expect(detail.alertSummary.totalFired).toBe(3);
  }

  it.each([
    ['post-rename integritystudio.*', withPrefix],
    ['pre-rename unprefixed', unprefixed],
  ])('reads %s keys', (_era, write) => {
    expectSessionRead(computeSessionDetail('s1', sessionSpans(write), []));
  });

  it('prefers the integritystudio.* key when a span carries both', () => {
    const both = (attrs: Attributes): Attributes => ({ ...staleUnprefixed(attrs), ...withPrefix(attrs) });

    expectSessionRead(computeSessionDetail('s1', sessionSpans(both), []));
  });
});

// ---------------------------------------------------------------------------
// loadCalibrationEntry: sync reads the calibration state where derive writes it
// (CALIBRATION-READ-WRONG-DIR: from 2026-04-19 to 2026-10-05 it read dashboard/scripts/,
// found nothing, and the dashboard served March's percentiles).
// ---------------------------------------------------------------------------

describe('loadCalibrationEntry', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  it("builds meta:calibration from the file derive's own writer produced", () => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    saveCalibrationState(dir, makeCalibrationState({ lastCalibrated: '2026-09-29T00:01:18.387Z' }));

    const entry = loadCalibrationEntry(dir);

    expect(entry?.key).toBe('meta:calibration');
    expect(JSON.parse(entry?.value ?? '{}')).toMatchObject({ lastCalibrated: '2026-09-29T00:01:18.387Z' });
  });

  it('warns and writes nothing when the file is missing, instead of failing silently', () => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadCalibrationEntry(dir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('.calibration-state.json'));
  });

  it('reads from the directory derive writes to by default', () => {
    vi.mocked(loadCalibrationState).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    loadCalibrationEntry();

    expect(vi.mocked(loadCalibrationState)).toHaveBeenCalledWith(CALIBRATION_STATE_DIR);
  });
});

// KV-SESSION-EVALS-TRUNCATION-UNFLAGGED: evaluationsTruncated threads into dataSources
describe('computeSessionDetail evaluation truncation', () => {
  const fakeEval = (): EvaluationResult => ({
    evaluationName: 'test',
    scoreValue: 1,
    timestamp: 0n,
  });

  it('sets dataSources.evaluations.truncated when the global eval read was cut', () => {
    const detail = computeSessionDetail('s1', [], [fakeEval()], true);

    expect(detail.dataSources.evaluations).toMatchObject({ count: 1, truncated: true });
  });

  it('omits dataSources.evaluations.truncated when the read was not cut', () => {
    const detail = computeSessionDetail('s1', [], [fakeEval()]);

    expect(detail.dataSources.evaluations).toEqual({ count: 1 });
    expect((detail.dataSources.evaluations as Record<string, unknown>).truncated).toBeUndefined();
  });
});
