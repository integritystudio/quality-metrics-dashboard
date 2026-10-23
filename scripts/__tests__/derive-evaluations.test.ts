import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import {
  deriveAgentHeuristics,
  trackTaskActivity,
  deriveTaskCompletionPerSession,
  deriveEvaluationLatency,
  deriveAll,
  deriveToolCorrectness,
  detectInputDrift,
  resolvePostDays,
  readScope,
  scoreTask,
  sessionTasks,
  splitAtRepostFloor,
  postFloorMs,
  carryForwardDistributions,
  DERIVE_NO_REPOST_BEFORE_MS,
  type TraceSpan,
} from '../derive-evaluations.js';
import { type EvalRecord } from '../eval-record.js';
import { OTEL_STATUS_ERROR_CODE } from '../../src/api/api-constants.js';
import { GENAI_AGENT_ATTRIBUTES, GENAI_CORE_ATTRIBUTES, GENAI_TOOL_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';
import { AGENT_ATTRIBUTES, HOOK_ATTRIBUTES, MCP_ATTRIBUTES, TASK_ATTRIBUTES, TOOL_ATTRIBUTES } from '../../src/lib/hook-attributes.js';
import { NANOSECONDS_PER_MILLISECOND, NANOSECONDS_PER_SECOND, TIME_MS } from '../../../src/lib/core/units.js';
import { makeSpan, SPAN_SESSION, SPAN_START_SEC, taskSpan } from './support/spans.js';
import { useTempDir } from './support/temp-dir.js';
import { transcriptMessage, writeJsonl } from './support/transcripts.js';

const secondsToHrTime = (seconds: number): [number, number] => [Math.floor(seconds), Math.round((seconds % 1) * NANOSECONDS_PER_SECOND)];

beforeEach(() => {
  sessionTasks.clear();
});

const TASK_SCORES = [
  [['pending', 'in_progress', 'completed'], 1],
  [['pending', 'completed'], 1],
  [['pending', 'in_progress'], 0.5],
  [['pending'], 0],
  [[], 0],
] as const;

describe('scoreTask', () => {
  it.each(TASK_SCORES)('scores the statuses %j as %d', (statuses, score) => {
    expect(scoreTask(new Set(statuses))).toBe(score);
  });
});

/** [case, task spans in arrival order, session score, explanation after `Session sess-abc: `] */
const TASK_SESSIONS = [
  ['a full lifecycle', [
    taskSpan('TaskCreate', { status: 'pending', id: 't1' }),
    taskSpan('TaskUpdate', { status: 'in_progress', id: 't1' }),
    taskSpan('TaskUpdate', { status: 'completed', id: 't1' }),
  ], 1, '1 tasks (1 completed)'],
  ['a completed task beside one in progress, as their average', [
    taskSpan('TaskCreate', { status: 'pending', id: 't1' }),
    taskSpan('TaskUpdate', { status: 'completed', id: 't1' }),
    taskSpan('TaskCreate', { status: 'pending', id: 't2' }),
    taskSpan('TaskUpdate', { status: 'in_progress', id: 't2' }),
  ], 0.75, '2 tasks (1 completed, 1 in_progress)'],
  ['only a pending task', [taskSpan('TaskCreate', { status: 'pending', id: 't1' })], 0, '1 tasks (1 pending)'],
  ['a task updated to completed with no create', [
    taskSpan('TaskUpdate', { status: 'in_progress', id: 't1' }),
    taskSpan('TaskUpdate', { status: 'completed', id: 't1' }),
  ], 1, '1 tasks (1 completed)'],
  ['two creates without a task id as two tasks, one per span', [
    taskSpan('TaskCreate', { status: 'pending' }, { spanId: 'span-1' }),
    taskSpan('TaskCreate', { status: 'pending' }, { spanId: 'span-2' }),
  ], 0, '2 tasks (2 pending)'],
  ['spans written before task statuses, by updates per create', [
    taskSpan('TaskCreate'),
    taskSpan('TaskUpdate'),
    taskSpan('TaskUpdate'),
  ], 1, '1 tasks, 2 updates (ratio fallback)'],
] as const;

/** [case, spans] that leave no session to score. */
const UNSCORED_SPANS = [
  ['no spans', []],
  ['a span from another hook', [makeSpan({ name: 'hook:mcp-post-tool' })]],
  ['a tool other than the task tools', [makeSpan({ attributes: { 'builtin.tool': 'Read' } })]],
  ['an update to a status outside the three', [taskSpan('TaskUpdate', { status: 'deleted', id: 't1' })]],
  ['updates with neither a create nor a status', [taskSpan('TaskUpdate'), taskSpan('TaskUpdate')]],
] as const;

describe('task completion (trackTaskActivity → deriveTaskCompletionPerSession)', () => {
  it.each(TASK_SESSIONS)('scores %s', (_case, spans, score, summary) => {
    for (const span of spans) trackTaskActivity(span);

    expect(deriveTaskCompletionPerSession()).toEqual([expect.objectContaining({
      evaluationName: 'task_completion',
      scoreValue: score,
      explanation: `Session ${SPAN_SESSION}: ${summary}`,
    })]);
  });

  it.each(UNSCORED_SPANS)('derives nothing from %s', (_case, spans) => {
    for (const span of spans) trackTaskActivity(span);

    expect(deriveTaskCompletionPerSession()).toEqual([]);
  });

  it('scores each session on its own tasks', () => {
    trackTaskActivity(taskSpan('TaskCreate', { status: 'pending', id: 't1', session: 'sess-1' }));
    trackTaskActivity(taskSpan('TaskUpdate', { status: 'completed', id: 't1', session: 'sess-1' }));
    trackTaskActivity(taskSpan('TaskCreate', { status: 'pending', id: 't2', session: 'sess-2' }));

    const scores = deriveTaskCompletionPerSession().map(r => [r.sessionId, r.scoreValue]);

    expect(scores.toSorted()).toEqual([['sess-1', 1], ['sess-2', 0]]);
  });
});

describe('deriveEvaluationLatency', () => {
  it('derives a latency record from a well-formed measurable span', () => {
    const LATENCY_SECONDS = 2.5;
    const record = deriveEvaluationLatency(makeSpan({ name: 'hook:session-start', duration: secondsToHrTime(LATENCY_SECONDS) }));

    expect(record).toMatchObject({
      evaluationName: 'evaluation_latency',
      scoreValue: LATENCY_SECONDS,
      scoreUnit: 'seconds',
      timestamp: '2024-02-08T13:46:40.000Z',
    });
    expect(record?.explanation).toContain(String(LATENCY_SECONDS));
  });

  it('returns null for a span whose name is not measurable', () => {
    expect(deriveEvaluationLatency(makeSpan({ name: 'hook:user-prompt' }))).toBeNull();
  });

  // OBP15: a malformed span must be skipped, not turned into a record. The three
  // records this guards against were all hook:session-start with NaN duration, and
  // were invalid three ways at once — null score, the literal "NaN" in user-facing
  // explanation text, and a 1970 timestamp.
  it('returns null when the duration is not finite', () => {
    expect(deriveEvaluationLatency(makeSpan({ name: 'hook:session-start', duration: [NaN, 0] }))).toBeNull();
  });

  it('returns null when the span carries no duration at all', () => {
    // localTraceSpanSchema rejects this shape, so main() never passes one through —
    // but the function is exported, and null beats throwing inside hrtToSeconds.
    const span = makeSpan({ name: 'hook:session-start' });
    delete (span as Partial<TraceSpan>).duration;

    expect(deriveEvaluationLatency(span)).toBeNull();
  });

  it('returns null for an epoch-ish startTime rather than dating the record to 1970', () => {
    expect(deriveEvaluationLatency(makeSpan({ name: 'hook:session-start', startTime: [2, 0] }))).toBeNull();
  });
});

describe('readScope', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  const named = new Set(['2026-09-30']);
  const DEFAULT_DAYS = 3;

  it('bounds an unscoped read to the last N UTC days, today included', () => {
    expect(readScope(null, DEFAULT_DAYS, now)).toEqual(new Set(['2026-10-02', '2026-10-03', '2026-10-04']));
  });

  it("keeps the caller's dates", () => {
    expect(readScope(named, DEFAULT_DAYS, now)).toBe(named);
  });
});

describe('splitAtRepostFloor', () => {
  const at = (ms: number): EvalRecord =>
    ({ timestamp: new Date(ms).toISOString(), evaluationName: 'tool_correctness', scoreValue: 1 }) as EvalRecord;

  it('holds back records before the floor, whose D1 copies carry no id', () => {
    const before = at(DERIVE_NO_REPOST_BEFORE_MS - 1);
    const exactly = at(DERIVE_NO_REPOST_BEFORE_MS);
    const after = at(DERIVE_NO_REPOST_BEFORE_MS + 1);

    expect(splitAtRepostFloor([after, before, exactly])).toEqual({ toPost: [after, exactly], heldBack: [before] });
  });

  it('sits where the id-less rows end: 2026-09-28T00:00Z', () => {
    expect(new Date(DERIVE_NO_REPOST_BEFORE_MS).toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('carryForwardDistributions', () => {
  const entry = (p50: number, windowEnd: string) => ({
    distribution: { p10: 0.1, p25: 0.2, p50, p75: 0.8, p90: 0.9 },
    sampleSize: 1125,
    windowStart: '2026-02-21T19:54:35.514Z',
    windowEnd,
  });
  const MARCH = '2026-03-23T19:54:35.514Z';
  const SEPTEMBER = '2026-09-29T00:01:18.387Z';
  const P50 = { carried: 0.5, stale: 0.6, fresh: 0.7 };

  it('keeps the previous entry, with its own window, for a metric this run could not recompute', () => {
    const previous = { task_completion: entry(P50.carried, MARCH), tool_correctness: entry(P50.stale, MARCH) };

    const merged = carryForwardDistributions(previous, { tool_correctness: entry(P50.fresh, SEPTEMBER) });

    expect(merged.task_completion).toEqual(entry(P50.carried, MARCH));
  });

  it('always prefers a freshly computed entry', () => {
    const merged = carryForwardDistributions(
      { tool_correctness: entry(P50.stale, MARCH) },
      { tool_correctness: entry(P50.fresh, SEPTEMBER) },
    );

    expect(merged).toEqual({ tool_correctness: entry(P50.fresh, SEPTEMBER) });
  });

  it('returns the fresh entries when there is no previous state', () => {
    const fresh = { tool_correctness: entry(P50.fresh, SEPTEMBER) };

    expect(carryForwardDistributions(undefined, fresh)).toEqual(fresh);
  });
});

describe('postFloorMs', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');

  it('limits an unscoped run to the last two days', () => {
    expect(postFloorMs(null, now)).toBe(Date.parse('2026-09-29T12:00:00.000Z'));
  });

  it('posts the whole scope when the caller named dates, so a backfill reaches old records', () => {
    expect(postFloorMs(new Set(['2026-09-28']), now)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('posts only the last --post-days when given, however wide the read scope', () => {
    const week = new Set(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);

    expect(postFloorMs(week, now, 2)).toBe(Date.parse('2026-09-29T12:00:00.000Z'));
  });
});

describe('resolvePostDays', () => {
  it('is null when the flag is absent, leaving the floor to the scope', () => {
    expect(resolvePostDays(['--days=7'])).toBeNull();
  });

  it('reads the day count', () => {
    expect(resolvePostDays(['--days=7', '--post-days=2'])).toBe(2);
    expect(resolvePostDays(['--post-days', '2'])).toBe(2);
  });

  it.each(['0', '1.5', '2d', ''])('rejects "%s"', (raw) => {
    expect(() => resolvePostDays([`--post-days=${raw}`])).toThrow('--post-days must be a positive integer');
  });
});

describe('deriveAll', () => {
  const completedTask = taskSpan('TaskCreate', { status: 'completed', id: 't1' });

  it('stamps records with the account of the span they score', () => {
    const records = deriveAll({ spans: [completedTask], accounts: new Map([['span-001', 'OBTOOL_API_KEY']]) });

    expect(records.length).toBeGreaterThan(0);
    expect(records.filter(r => r.identityKeyRef !== 'OBTOOL_API_KEY')).toEqual([]);
  });

  it('gives the same records when run twice in one process', () => {
    const loaded = { spans: [completedTask], accounts: new Map() };

    expect(deriveAll(loaded)).toEqual(deriveAll(loaded));
  });
});

// builtin.* key rename (hooks 2026-09-18)
//
// Regression: derive read `builtin.*` keys, the hooks started writing
// `gen_ai.tool.name` / `integritystudio.tool.*` / `integritystudio.task.*`, and
// every builtin tool call scored 0 (3,363 of 3,365 records on 2026-09-26) while
// task tracking never fired. Both spellings live in the local files, so each
// behavior is pinned for both.

/** The hooks' own timing of one post-tool call on 2026-09-28. */
const RENAMED_SPAN_TIMING: Pick<TraceSpan, 'startTime' | 'endTime' | 'duration'> = {
  startTime: [1790553614, 235000000],
  endTime: [1790553614, 236463666],
  duration: [0, 1463666],
};

/** A post-rename builtin post-tool span, shaped like the hooks write it today. */
function renamedToolSpan(attributes: Record<string, unknown>): TraceSpan {
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name: 'hook:builtin-post-tool',
    ...RENAMED_SPAN_TIMING,
    status: { code: 1 },
    attributes: { [SESSION_ATTRIBUTES.ID]: SPAN_SESSION, [HOOK_ATTRIBUTES.NAME]: 'builtin-post-tool', ...attributes },
  };
}

describe('deriveToolCorrectness across the builtin.* rename', () => {
  it.each([
    ['canonical', { [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Bash', [TOOL_ATTRIBUTES.SUCCESS]: true }],
    ['legacy', { 'builtin.tool': 'Bash', 'builtin.success': true }],
  ])('scores a successful call 1 from %s keys', (_era, attributes) => {
    expect(deriveToolCorrectness(renamedToolSpan(attributes)))
      .toMatchObject({ scoreValue: 1, explanation: 'Tool Bash completed successfully' });
  });

  it.each([
    ['canonical', { [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Edit', [TOOL_ATTRIBUTES.SUCCESS]: false, [TOOL_ATTRIBUTES.ERROR_TYPE]: 'file_not_read' }],
    ['legacy', { 'builtin.tool': 'Edit', 'builtin.success': false, 'builtin.error_type': 'file_not_read' }],
  ])('scores a failed call 0 with its error type from %s keys', (_era, attributes) => {
    expect(deriveToolCorrectness(renamedToolSpan(attributes)))
      .toMatchObject({ scoreValue: 0, explanation: 'Tool Edit failed: file_not_read' });
  });
});

describe('task tracking across the builtin.* rename', () => {
  it.each([
    ['canonical', { [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'TaskUpdate', [TASK_ATTRIBUTES.ID]: 't1', [TASK_ATTRIBUTES.STATUS]: 'completed' }],
    ['legacy', { 'builtin.tool': 'TaskUpdate', 'builtin.task_id': 't1', 'builtin.task_status': 'completed' }],
  ])('scores a completed task 1 from %s keys', (_era, attributes) => {
    trackTaskActivity(renamedToolSpan(attributes));

    expect(deriveTaskCompletionPerSession())
      .toEqual([expect.objectContaining({ scoreValue: 1, explanation: `Session ${SPAN_SESSION}: 1 tasks (1 completed)` })]);
  });
});

describe('deriveEvaluationLatency across the builtin.* rename', () => {
  it('names the tool from the canonical key', () => {
    const record = deriveEvaluationLatency(renamedToolSpan({ [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Bash', [TOOL_ATTRIBUTES.SUCCESS]: true }));

    expect(record?.explanation).toMatch(/^Hook builtin\/Bash executed in /);
  });
});

describe('deriveAll across the builtin.* rename', () => {
  it('scores a day of mostly successful post-rename calls as mostly successful', () => {
    const spans = [
      renamedToolSpan({ [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Read', [TOOL_ATTRIBUTES.SUCCESS]: true }),
      { ...renamedToolSpan({ [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Bash', [TOOL_ATTRIBUTES.SUCCESS]: true }), spanId: 'span-002' },
      { ...renamedToolSpan({ [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Edit', [TOOL_ATTRIBUTES.SUCCESS]: false }), spanId: 'span-003' },
    ];

    const scores = deriveAll({ spans, accounts: new Map() })
      .filter(r => r.evaluationName === 'tool_correctness')
      .map(r => r.scoreValue);

    expect(scores).toEqual([1, 1, 0]);
  });
});

// mcp.* key rename (hooks 2026-09-29)
//
// The hooks moved `mcp.*` under `integritystudio.`. The alias table has no rows
// for these keys, so `attrsOf` leaves each era on its own spelling and derive
// must read the new key, then the old one. Reading only the old key would score
// every post-rename MCP call 0, as the builtin.* rename did.

/** An MCP post-tool span carrying `attributes`, shaped like the hooks write it. */
function mcpToolSpan(attributes: Record<string, unknown>): TraceSpan {
  return {
    ...renamedToolSpan({}),
    name: 'hook:mcp-post-tool',
    attributes: { [SESSION_ATTRIBUTES.ID]: SPAN_SESSION, [HOOK_ATTRIBUTES.NAME]: 'mcp-post-tool', ...attributes },
  };
}

describe('deriveToolCorrectness across the mcp.* rename', () => {
  it.each([
    ['canonical', { [MCP_ATTRIBUTES.SERVER]: 'github', [MCP_ATTRIBUTES.TOOL]: 'get_me', [MCP_ATTRIBUTES.SUCCESS]: true }],
    ['legacy', { 'mcp.server': 'github', 'mcp.tool': 'get_me', 'mcp.success': true }],
  ])('scores a successful call 1 from %s keys', (_era, attributes) => {
    expect(deriveToolCorrectness(mcpToolSpan(attributes)))
      .toMatchObject({ scoreValue: 1, explanation: 'Tool github/get_me completed successfully' });
  });

  it.each([
    ['canonical', { [MCP_ATTRIBUTES.SERVER]: 'github', [MCP_ATTRIBUTES.TOOL]: 'create_issue', [MCP_ATTRIBUTES.SUCCESS]: false, [MCP_ATTRIBUTES.ERROR_TYPE]: 'rate_limited' }],
    ['legacy', { 'mcp.server': 'github', 'mcp.tool': 'create_issue', 'mcp.success': false, 'mcp.error_type': 'rate_limited' }],
  ])('scores a failed call 0 with its error type from %s keys', (_era, attributes) => {
    expect(deriveToolCorrectness(mcpToolSpan(attributes)))
      .toMatchObject({ scoreValue: 0, explanation: 'Tool github/create_issue failed: rate_limited' });
  });

  it('reads the canonical key when a span carries both, even a canonical false', () => {
    const record = deriveToolCorrectness(mcpToolSpan({
      [MCP_ATTRIBUTES.SERVER]: 'github',
      [MCP_ATTRIBUTES.TOOL]: 'create_issue',
      [MCP_ATTRIBUTES.SUCCESS]: false,
      [MCP_ATTRIBUTES.ERROR_TYPE]: 'rate_limited',
      'mcp.server': 'gitlab',
      'mcp.tool': 'get_me',
      'mcp.success': true,
      'mcp.error_type': 'stale',
    }));

    expect(record).toMatchObject({ scoreValue: 0, explanation: 'Tool github/create_issue failed: rate_limited' });
  });
});

describe('deriveEvaluationLatency across the mcp.* rename', () => {
  it.each([
    ['only the canonical key', { [MCP_ATTRIBUTES.TOOL]: 'get_me' }],
    ['only the legacy key', { 'mcp.tool': 'get_me' }],
    ['both keys, canonical first', { [MCP_ATTRIBUTES.TOOL]: 'get_me', 'mcp.tool': 'stale' }],
  ])('names the tool from a span with %s', (_era, attributes) => {
    expect(deriveEvaluationLatency(mcpToolSpan(attributes))?.explanation).toMatch(/^Hook mcp\/get_me executed in /);
  });
});

// Agent hook rename (hooks 2026-08-13)
//
// Regression: derive matched `hook:agent-pre-tool` / `hook:agent-post-tool`,
// the hooks renamed them to `hook:agent.operation.prepare` / `.finalize`, and
// agent completion, handoff_correctness and agent hook latency produced
// nothing for six weeks. The names below are copied from real spans, not from
// the constants, so a wrong constant fails here instead of matching itself.

const OTEL_STATUS_OK = 1;
const AGENTS_START_SEC = 1_790_000_000;
/** Start offsets of Explore's prepare and finalize, then code-reviewer's. */
const HANDOFF_OFFSETS_SEC = [0, 10, 20, 30] as const;

type AgentOutcome = { statusCode?: number; hasError?: boolean };

/** An Agent-tool hook span in one session, shaped like the hooks write it today. */
function agentHookSpan(phase: 'prepare' | 'finalize', agentName: string, spanId: string, startSec: number): TraceSpan {
  return {
    traceId: 'trace-001',
    spanId,
    name: `hook:agent.operation.${phase}`,
    startTime: [startSec, 0],
    endTime: [startSec, NANOSECONDS_PER_MILLISECOND],
    duration: [0, NANOSECONDS_PER_MILLISECOND],
    status: { code: OTEL_STATUS_OK },
    attributes: {
      [SESSION_ATTRIBUTES.ID]: 'sess-agents',
      [GENAI_CORE_ATTRIBUTES.OPERATION_NAME]: 'invoke_agent',
      [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: agentName,
      [AGENT_ATTRIBUTES.TYPE]: agentName,
      [HOOK_ATTRIBUTES.NAME]: `agent.operation.${phase}`,
    },
  };
}

/** `span` with the agent's error flag and the hook's status set as `outcome` says. */
function withOutcome(span: TraceSpan, { statusCode, hasError }: AgentOutcome): TraceSpan {
  return {
    ...span,
    status: { code: statusCode ?? OTEL_STATUS_OK },
    attributes: { ...span.attributes, ...(hasError !== undefined && { [AGENT_ATTRIBUTES.HAS_ERROR]: hasError }) },
  };
}

/** Explore runs, then code-reviewer: one handoff, whose outcome each agent's finalize span carries. */
function handoffSpans(sender: AgentOutcome = {}, receiver: AgentOutcome = {}): TraceSpan[] {
  const [prepareFirst, finalizeFirst, prepareSecond, finalizeSecond] = HANDOFF_OFFSETS_SEC.map(offset => AGENTS_START_SEC + offset) as [number, number, number, number];
  return [
    agentHookSpan('prepare', 'Explore', 'span-p1', prepareFirst),
    withOutcome(agentHookSpan('finalize', 'Explore', 'span-f1', finalizeFirst), sender),
    agentHookSpan('prepare', 'code-reviewer', 'span-p2', prepareSecond),
    withOutcome(agentHookSpan('finalize', 'code-reviewer', 'span-f2', finalizeSecond), receiver),
  ];
}

const derived = (spans: TraceSpan[], name: string): EvalRecord[] =>
  deriveAll({ spans, accounts: new Map() }).filter(r => r.evaluationName === name);

describe('deriveAll over the renamed agent hook spans', () => {
  it('scores agent completion from prepare and finalize counts', () => {
    const completion = derived(handoffSpans(), 'task_completion');

    expect(completion).toMatchObject([{ scoreValue: 1 }]);
    expect(completion[0]?.explanation).toMatch(/^Agent completion: 2\/2 agents finished/);
  });

  it('scores a handoff between two different agents on the receiving agent\'s span', () => {
    expect(derived(handoffSpans(), 'handoff_correctness')).toEqual([expect.objectContaining({ scoreValue: 1, spanId: 'span-f2' })]);
  });

  // Regression: two agents finishing in parallel land in the trace file in the
  // opposite order to their start times, so local derive attached the session
  // record to one span and cloud derive, which reads in start order, to the other.
  it('attaches session records to the latest-starting span whatever order the spans arrive in', () => {
    const [p1, f1, p2, f2] = handoffSpans() as [TraceSpan, TraceSpan, TraceSpan, TraceSpan];
    const sessionRecords = (spans: TraceSpan[]): EvalRecord[] =>
      deriveAll({ spans, accounts: new Map() }).filter(r => r.evaluationName !== 'evaluation_latency');

    const fromWriteOrder = sessionRecords([p1, p2, f2, f1]);

    expect(fromWriteOrder).toEqual(sessionRecords([p1, f1, p2, f2]));
    expect(fromWriteOrder.filter(r => r.spanId !== 'span-f2')).toEqual([]);
  });

  it('measures the finalize hook latency under the agent type', () => {
    expect(derived(handoffSpans(), 'evaluation_latency').map(r => r.explanation)).toEqual([
      expect.stringMatching(/^Hook agent\/Explore executed in /),
      expect.stringMatching(/^Hook agent\/code-reviewer executed in /),
    ]);
  });
});

// handoff_correctness failure signals (DERIVE-AGENT-SCORE-HOOK-STATUS)
//
// Score 0 when the agent's own error flag is set (`integritystudio.agent.has_error`),
// or when the hook itself throws (span.status.code === ERROR). The handoff scores
// on the RECEIVING agent, so a failed sender leaves it at 1; that row pins the
// semantics so a change to include the sender shows up here.

/** [case, sender outcome, receiver outcome, handoff score] */
const HANDOFF_OUTCOMES = [
  ['both agents succeed', {}, {}, 1],
  ['only the sending agent fails', { hasError: true }, {}, 1],
  ['the receiving agent sets its error flag', {}, { hasError: true }, 0],
  ['the receiving agent\'s hook throws (status ERROR, no flag)', {}, { statusCode: OTEL_STATUS_ERROR_CODE }, 0],
] as const;

describe('handoff_correctness', () => {
  it.each(HANDOFF_OUTCOMES)('scores %s as %d', (_case, sender, receiver, score) => {
    expect(derived(handoffSpans(sender, receiver), 'handoff_correctness')).toEqual([expect.objectContaining({ scoreValue: score })]);
  });
});

// detectInputDrift (HOOK-RENAME-SILENT)
//
// Both hooks-side renames so far emptied or zeroed a metric while every stage
// exited 0. Each check below compares a day's spans with themselves, so each
// test builds one day of real-shaped input and changes only the name or key a
// rename would change.

describe('detectInputDrift', () => {
  const DAY_START_SEC = 1_790_553_600; // 2026-09-28T00:00:00Z
  const DAY = '2026-09-28';
  const TOOL_SPANS_PER_DAY = 25;
  const TOO_FEW_TOOL_SPANS = 5;
  const AGENT_FINALIZE_OFFSET_SEC = 10;
  const SYNTHETIC_INVOKE_OFFSET_SEC = 5;

  function toolSpans(count: number, attributes: Record<string, unknown>, fromIndex = 0): TraceSpan[] {
    return Array.from({ length: count }, (_, i) => ({
      ...renamedToolSpan({ [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Read', ...attributes }),
      spanId: `tool-${fromIndex + i}`,
      startTime: [DAY_START_SEC + fromIndex + i, 0] as [number, number],
    }));
  }

  function agentSpans(name: string): TraceSpan[] {
    return [
      { ...agentHookSpan('prepare', 'Explore', 'span-p1', DAY_START_SEC), name: name.replace('finalize', 'prepare') },
      { ...agentHookSpan('finalize', 'Explore', 'span-f1', DAY_START_SEC + AGENT_FINALIZE_OFFSET_SEC), name },
    ];
  }

  it('is quiet on a day whose spans derive reads', () => {
    const spans = [...agentSpans('hook:agent.operation.finalize'), ...toolSpans(TOOL_SPANS_PER_DAY, { [TOOL_ATTRIBUTES.SUCCESS]: true })];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('flags a day whose agent spans derive no longer matches by name', () => {
    expect(detectInputDrift(agentSpans('hook:agent.lifecycle.finalize'), null)).toEqual([
      expect.stringMatching(new RegExp(`^${DAY}: 2 spans record agent invocations, but none is named`)),
    ]);
  });

  // Since 2026-09-29 the hook spans carry no gen_ai.operation.name; the synthetic
  // `invoke_agent <agent>` span is the only evidence of an invocation.
  const withoutOperation = (span: TraceSpan): TraceSpan => ({
    ...span,
    attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) => key !== GENAI_CORE_ATTRIBUTES.OPERATION_NAME)),
  });
  const syntheticInvokeSpan: TraceSpan = {
    ...agentHookSpan('finalize', 'Explore', 'span-i1', DAY_START_SEC + SYNTHETIC_INVOKE_OFFSET_SEC),
    name: 'invoke_agent Explore',
    attributes: { [SESSION_ATTRIBUTES.ID]: 'sess-agents', [GENAI_CORE_ATTRIBUTES.OPERATION_NAME]: 'invoke_agent', [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: 'Explore' },
  };

  it('is quiet when only the synthetic span carries the operation and the hook spans keep their names', () => {
    const spans = [...agentSpans('hook:agent.operation.finalize').map(span => withoutOperation(span)), syntheticInvokeSpan];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('still flags renamed hook spans when only the synthetic span records the invocation', () => {
    const spans = [...agentSpans('hook:agent.lifecycle.finalize').map(span => withoutOperation(span)), syntheticInvokeSpan];

    expect(detectInputDrift(spans, null)).toEqual([
      expect.stringMatching(new RegExp(`^${DAY}: 1 spans record agent invocations, but none is named`)),
    ]);
  });

  it('flags a day where most tool spans carry no success flag under the key derive reads', () => {
    const renamed = toolSpans(TOOL_SPANS_PER_DAY, { 'integritystudio.tool.succeeded': true });

    expect(detectInputDrift(renamed, null)).toEqual([
      expect.stringMatching(new RegExp(`^${DAY}: ${TOOL_SPANS_PER_DAY} of ${TOOL_SPANS_PER_DAY} tool spans carry no success flag`)),
    ]);
  });

  it('reads the success flag through the alias table, as derive does', () => {
    expect(detectInputDrift(toolSpans(TOOL_SPANS_PER_DAY, { 'builtin.success': true }), null)).toEqual([]);
  });

  it.each([
    ['canonical', { [MCP_ATTRIBUTES.SUCCESS]: true }],
    ['legacy', { 'mcp.success': true }],
  ])('reads the MCP success flag from %s keys', (_era, attributes) => {
    const mcp = toolSpans(TOOL_SPANS_PER_DAY, attributes).map(span => ({ ...span, name: 'hook:mcp-post-tool' }));

    expect(detectInputDrift(mcp, null)).toEqual([]);
  });

  it('tolerates hooks that failed before recording, up to half the day', () => {
    const half = TOOL_SPANS_PER_DAY - 1;
    const spans = [...toolSpans(half, { [TOOL_ATTRIBUTES.SUCCESS]: true }), ...toolSpans(half, {}, half)];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('ignores a day with too few tool spans to judge', () => {
    expect(detectInputDrift(toolSpans(TOO_FEW_TOOL_SPANS, {}), null)).toEqual([]);
  });

  it('checks only the days in scope', () => {
    expect(detectInputDrift(agentSpans('hook:agent.lifecycle.finalize'), new Set(['2026-09-27']))).toEqual([]);
  });
});

describe('deriveAgentHeuristics', () => {
  const SINCE_MS = SPAN_START_SEC * TIME_MS.SECOND;
  const LATE_SPAN_OFFSET_SEC = 50;
  const dir = useTempDir('derive-agent-heuristics-');

  const prompt = (text: string): object => transcriptMessage('user', text);
  const reply = (content: unknown[]): object => transcriptMessage('assistant', content);
  const transcript = (name: string, entries: object[]): string => writeJsonl(join(dir(), name), entries);
  const sessionTranscript = (): string => transcript('session.jsonl', [prompt('Fix the build'), reply([{ type: 'text', text: 'Fixed the build.' }])]);

  function subagentStop(transcriptPath: string, overrides: Partial<TraceSpan> = {}): TraceSpan {
    return makeSpan({
      name: 'hook:subagent-stop',
      spanId: 'span-stop',
      ...overrides,
      attributes: { [AGENT_ATTRIBUTES.TRANSCRIPT_PATH]: transcriptPath, [AGENT_ATTRIBUTES.TYPE]: 'code-reviewer' },
    });
  }

  const earlySpan = (): TraceSpan => makeSpan({ spanId: 'span-early' });
  const lateSpan = (): TraceSpan => makeSpan({ spanId: 'span-late', startTime: [SPAN_START_SEC + LATE_SPAN_OFFSET_SEC, 0] });

  it('scores a subagent run from its transcript on its subagent-stop span, with labels', async () => {
    const path = transcript('agent.jsonl', [
      prompt('Review the diff'),
      reply([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '' } }]),
      transcriptMessage('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      reply([{ type: 'text', text: 'No findings.' }]),
    ]);

    const records = await deriveAgentHeuristics([subagentStop(path)], SINCE_MS, new Map());

    // The one argument is empty, so the call scores 0 and fails.
    expect(records).toMatchObject([
      {
        evaluationName: 'argument_correctness',
        scoreValue: 0,
        scoreLabel: 'fail',
        spanId: 'span-stop',
        sessionId: SPAN_SESSION,
        explanation: 'code-reviewer agent: 1 tool calls',
      },
      { evaluationName: 'agent_overall' },
    ]);
    expect(records[1]?.scoreLabel).toMatch(/^(pass|partial|fail)$/);
  });

  it('scores a session from its transcript on the session\'s last span', async () => {
    const records = await deriveAgentHeuristics([lateSpan(), earlySpan()], SINCE_MS, new Map([[SPAN_SESSION, sessionTranscript()]]));

    expect(records.map(r => [r.evaluationName, r.spanId])).toEqual([
      ['conversation_completeness', 'span-late'],
      ['turn_relevancy', 'span-late'],
      ['conversation_overall', 'span-late'],
    ]);
    expect(records[1]).toMatchObject({ scoreLabel: 'relevant', explanation: `Session ${SPAN_SESSION}: 2 turns` });
  });

  it('skips a run or session whose transcript is not on this machine', async () => {
    const records = await deriveAgentHeuristics(
      [subagentStop(join(dir(), 'gone.jsonl'))], SINCE_MS, new Map([[SPAN_SESSION, join(dir(), 'also-gone.jsonl')]]));

    expect(records).toEqual([]);
  });

  it('reads no span that starts before the floor', async () => {
    const path = transcript('agent.jsonl', [prompt('Review'), reply([{ type: 'text', text: 'Done.' }])]);
    const early = subagentStop(path, { startTime: [SPAN_START_SEC - 1, 0] });

    expect(await deriveAgentHeuristics([early], SINCE_MS, new Map([[SPAN_SESSION, path]]))).toEqual([]);
  });

  it('keys session records the same whichever span anchors them, so a resumed session does not duplicate D1 rows', async () => {
    const sessions = new Map([[SPAN_SESSION, sessionTranscript()]]);
    const keys = (records: EvalRecord[]): Array<string | undefined> => records.map(r => r.stableEvaluationKey);

    const [anchoredEarly, anchoredLate] = await Promise.all([
      deriveAgentHeuristics([earlySpan()], SINCE_MS, sessions),
      deriveAgentHeuristics([lateSpan()], SINCE_MS, sessions),
    ]);

    expect(anchoredEarly.length).toBeGreaterThan(0);
    expect(keys(anchoredEarly)).toEqual(keys(anchoredLate));
    expect(keys(anchoredEarly).filter(key => !key?.startsWith(`session:${SPAN_SESSION}:`))).toEqual([]);
  });

  it('skips a session whose last span is within the completion-age window', async () => {
    // A span 1 h before nowMs is inside the 12 h MIN_SESSION_COMPLETION_AGE_MS window.
    const nowMs = SINCE_MS + 2 * TIME_MS.HOUR;
    const recentSpan = makeSpan({ spanId: 'span-recent', startTime: [Math.floor((SINCE_MS + TIME_MS.HOUR) / TIME_MS.SECOND), 0] });

    const records = await deriveAgentHeuristics([recentSpan], SINCE_MS, new Map([[SPAN_SESSION, sessionTranscript()]]), nowMs);

    expect(records).toEqual([]);
  });
});
