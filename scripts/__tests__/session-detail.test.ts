/**
 * The shared session detail (`src/api/session-detail.ts`) that the KV sync and
 * the `/api/sessions/:id` route both serve. It runs under the scripts config
 * because the multi-agent cases need the parent's real evaluator, which the
 * `src/` suite stubs when the parent build is absent.
 */
import { describe, it, expect } from 'vitest';
import { computeSessionDetail, type SessionSpan } from '../../src/api/session-detail.js';
import { computeMultiAgentEvaluation } from '../../../src/lib/quality/quality-multi-agent.js';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { NANOSECONDS_PER_MILLISECOND_BIGINT } from '../../../src/lib/core/units.js';

function detailOf(spans: SessionSpan[], evaluations: EvaluationResult[], evaluationsTruncated?: boolean) {
  return computeSessionDetail({ sessionId: 's1', spans, evaluations, evaluationsTruncated }, computeMultiAgentEvaluation);
}

function evaluation(label: string, iso: string): EvaluationResult {
  return { evaluationName: 'relevance', scoreValue: 0.5, timestamp: BigInt(Date.parse(iso)) * NANOSECONDS_PER_MILLISECOND_BIGINT, explanation: label };
}

describe('computeSessionDetail multi-agent attribution', () => {
  function span(name: string, attributes: Record<string, unknown>) {
    return { name, traceId: 't1', attributes };
  }

  it('attributes turns by gen_ai.agent.name, the key hooks emit', () => {
    const detail = detailOf([
      span('a', { 'gen_ai.agent.name': 'planner' }),
      span('b', { 'gen_ai.agent.name': 'executor' }),
    ], []);

    expect(detail.multiAgentEvaluation.turns.map(t => t.agentName)).toEqual(['planner', 'executor']);
  });

  it('still reads the legacy agent.name key', () => {
    // Two distinct agents: computeMultiAgentEvaluation drops the map below that.
    const detail = detailOf([
      span('a', { 'agent.name': 'planner' }),
      span('b', { 'agent.name': 'executor' }),
    ], []);

    expect(detail.multiAgentEvaluation.turns.map(t => t.agentName)).toEqual(['planner', 'executor']);
  });

  // The API route once read `agent.name` first, so the same span named a different agent there than in KV.
  it('prefers gen_ai.agent.name when a span carries both keys', () => {
    const detail = detailOf([
      span('a', { 'gen_ai.agent.name': 'planner', 'agent.name': 'stale-a' }),
      span('b', { 'gen_ai.agent.name': 'executor', 'agent.name': 'stale-b' }),
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
    const detail = detailOf([
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Bash' } },
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Bash' } },
      { name: 'hook:builtin-post-tool', attributes: { ...postTool, 'gen_ai.tool.name': 'Read' } },
    ], []);

    expect(detail.toolUsage).toEqual({ Bash: 2, Read: 1 });
  });

  it('reports a failed call with its tool, error type and file', () => {
    const detail = detailOf([{
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
    const detail = detailOf([
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

  function expectSessionRead(detail: ReturnType<typeof detailOf>) {
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
    expectSessionRead(detailOf(sessionSpans(write), []));
  });

  it('prefers the integritystudio.* key when a span carries both', () => {
    const both = (attrs: Attributes): Attributes => ({ ...staleUnprefixed(attrs), ...withPrefix(attrs) });

    expectSessionRead(detailOf(sessionSpans(both), []));
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
    const detail = detailOf([], [fakeEval()], true);

    expect(detail.dataSources.evaluations).toMatchObject({ count: 1, truncated: true });
  });

  it('omits dataSources.evaluations.truncated when the read was not cut', () => {
    const detail = detailOf([], [fakeEval()]);

    expect(detail.dataSources.evaluations).toEqual({ count: 1 });
    expect((detail.dataSources.evaluations as Record<string, unknown>).truncated).toBeUndefined();
  });
});

describe('computeSessionDetail timespan', () => {
  it('is null when the session has no evaluations', () => {
    expect(detailOf([], []).timespan).toBeNull();
  });

  it('spans the earliest to the latest evaluation, whatever their order', () => {
    const detail = detailOf([], [
      evaluation('late', '2026-10-01T01:30:00.000Z'),
      evaluation('early', '2026-10-01T00:00:00.000Z'),
      evaluation('middle', '2026-10-01T00:45:00.000Z'),
    ]);

    expect(detail.timespan).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-01T01:30:00.000Z',
      durationHours: 1.5,
    });
  });

  it('rounds the duration to one decimal hour', () => {
    const detail = detailOf([], [
      evaluation('start', '2026-10-01T00:00:00.000Z'),
      evaluation('end', '2026-10-01T01:04:00.000Z'),
    ]);

    expect(detail.timespan?.durationHours).toBe(1.1);
  });

  it('has zero duration for a single evaluation', () => {
    const detail = detailOf([], [evaluation('only', '2026-10-01T00:00:00.000Z')]);

    expect(detail.timespan).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-01T00:00:00.000Z',
      durationHours: 0,
    });
  });
});
