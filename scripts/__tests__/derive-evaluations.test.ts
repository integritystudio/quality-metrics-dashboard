import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  resolveSource,
  scoreTask,
  sessionTasks,
  splitAtRepostFloor,
  postFloorMs,
  carryForwardDistributions,
  DERIVE_NO_REPOST_BEFORE_MS,
  STATUS_SCORES,
  type TraceSpan,
} from '../derive-evaluations.js';
import { type EvalRecord } from '../eval-record.js';
import { OTEL_STATUS_ERROR_CODE } from '../../src/api/api-constants.js';

// Test Data Factories

function makeSpan(overrides: Partial<TraceSpan> & { attributes?: Record<string, unknown> }): TraceSpan {
  const { attributes: attrOverrides, ...rest } = overrides;
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name: 'hook:builtin-post-tool',
    startTime: [1707400000, 0],
    endTime: [1707400001, 0],
    duration: [1, 0],
    status: { code: 0 },
    ...rest,
    attributes: {
      'session.id': 'sess-abc',
      'builtin.tool': 'TaskCreate',
      ...attrOverrides,
    },
  };
}

// Setup

beforeEach(() => {
  sessionTasks.clear();
});

describe('scoreTask', () => {
  it('returns 1.0 for completed tasks', () => {
    expect(scoreTask(new Set(['pending', 'in_progress', 'completed']))).toBe(1.0);
  });

  it('returns 0.5 for in_progress tasks', () => {
    expect(scoreTask(new Set(['pending', 'in_progress']))).toBe(0.5);
  });

  it('returns 0.0 for pending-only tasks', () => {
    expect(scoreTask(new Set(['pending']))).toBe(0.0);
  });

  it('returns 0.0 for empty status set', () => {
    expect(scoreTask(new Set())).toBe(0.0);
  });

  it('returns 1.0 when completed without in_progress', () => {
    expect(scoreTask(new Set(['pending', 'completed']))).toBe(1.0);
  });
});

describe('STATUS_SCORES', () => {
  it('has expected keys and values', () => {
    expect(STATUS_SCORES).toEqual({
      pending: 0.0,
      in_progress: 0.5,
      completed: 1.0,
    });
  });
});

describe('trackTaskActivity', () => {
  it('ignores non-builtin-post-tool spans', () => {
    trackTaskActivity(makeSpan({ name: 'hook:mcp-post-tool' }));
    expect(sessionTasks.size).toBe(0);
  });

  it('ignores non-task tools', () => {
    trackTaskActivity(makeSpan({ attributes: { 'builtin.tool': 'Read', 'session.id': 'sess-abc' } }));
    expect(sessionTasks.size).toBe(0);
  });

  it('tracks TaskCreate with explicit status', () => {
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.creates).toBe(1);
    expect(data.tasks.size).toBe(1);
    const task = [...data.tasks.values()][0]!;
    expect(task.statuses.has('pending')).toBe(true);
  });

  it('tracks TaskUpdate with status transition', () => {
    // Create task
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'builtin.task_id': 'task-1',
        'session.id': 'sess-abc',
      },
    }));

    // Update to in_progress
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'in_progress',
        'builtin.task_id': 'task-1',
        'session.id': 'sess-abc',
      },
    }));

    // Update to completed
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'completed',
        'builtin.task_id': 'task-1',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.creates).toBe(1);
    expect(data.updates).toBe(2);
    const task = data.tasks.get('task-1')!;
    expect(task.statuses).toEqual(new Set(['pending', 'in_progress', 'completed']));
  });

  it('handles rapid status transitions for same task', () => {
    // in_progress then immediately completed (no pending create first)
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'in_progress',
        'builtin.task_id': 'task-rapid',
        'session.id': 'sess-abc',
      },
    }));
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'completed',
        'builtin.task_id': 'task-rapid',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    const task = data.tasks.get('task-rapid')!;
    expect(task.statuses).toEqual(new Set(['in_progress', 'completed']));
    expect(scoreTask(task.statuses)).toBe(1.0);
  });

  it('rejects invalid status values', () => {
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'deleted',
        'builtin.task_id': 'task-1',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.updates).toBe(1);
    expect(data.tasks.size).toBe(0); // deleted is not in STATUS_SCORES
  });

  it('assigns anonymous ID using spanId when taskId missing', () => {
    trackTaskActivity(makeSpan({
      spanId: 'span-xyz',
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.tasks.has('anon-span-xyz')).toBe(true);
  });

  it('creates distinct anonymous IDs for multiple creates without taskId', () => {
    trackTaskActivity(makeSpan({
      spanId: 'span-1',
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'session.id': 'sess-abc',
      },
    }));
    trackTaskActivity(makeSpan({
      spanId: 'span-2',
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.tasks.size).toBe(2);
    expect(data.tasks.has('anon-span-1')).toBe(true);
    expect(data.tasks.has('anon-span-2')).toBe(true);
  });

  it('falls back to counting when no status attributes', () => {
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'session.id': 'sess-abc' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'session.id': 'sess-abc' },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.creates).toBe(1);
    expect(data.updates).toBe(1);
    expect(data.tasks.size).toBe(0); // no status attributes -> no task entries
  });
});

describe('deriveTaskCompletionPerSession', () => {
  it('returns empty array for no sessions', () => {
    expect(deriveTaskCompletionPerSession()).toEqual([]);
  });

  it('scores all-completed session as 1.0', () => {
    // Task 1: full lifecycle
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'in_progress', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'completed', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.scoreValue).toBe(1.0);
    expect(evals[0]!.evaluationName).toBe('task_completion');
    expect(evals[0]!.explanation).toContain('1 completed');
  });

  it('scores mixed session as average', () => {
    // Task 1: completed
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'completed', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));

    // Task 2: only in_progress
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't2', 'session.id': 'sess-abc' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'in_progress', 'builtin.task_id': 't2', 'session.id': 'sess-abc' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.scoreValue).toBe(0.75); // (1.0 + 0.5) / 2
  });

  it('uses ratio fallback for old data without status attributes', () => {
    // Old-style spans without builtin.task_status
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'session.id': 'sess-old' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'session.id': 'sess-old' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'session.id': 'sess-old' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.scoreValue).toBe(1.0); // 2 updates / (1 create * 2) = 1.0
    expect(evals[0]!.explanation).toContain('ratio fallback');
  });

  it('skips sessions with no creates and no tasks', () => {
    // Edge case: only updates (shouldn't happen but guard)
    sessionTasks.set('orphan', {
      tasks: new Map(),
      creates: 0,
      updates: 2,
      lastSpan: null,
    });

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(0);
  });

  it('handles session with only pending tasks', () => {
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't1', 'session.id': 'sess-abc' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.scoreValue).toBe(0.0);
    expect(evals[0]!.explanation).toContain('1 pending');
  });

  it('handles multiple sessions independently', () => {
    // Session 1: completed
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't1', 'session.id': 'sess-1' },
    }));
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'completed', 'builtin.task_id': 't1', 'session.id': 'sess-1' },
    }));

    // Session 2: only pending
    trackTaskActivity(makeSpan({
      attributes: { 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 't2', 'session.id': 'sess-2' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(2);
    const sess1 = evals.find(e => e.sessionId === 'sess-1')!;
    const sess2 = evals.find(e => e.sessionId === 'sess-2')!;
    expect(sess1.scoreValue).toBe(1.0);
    expect(sess2.scoreValue).toBe(0.0);
  });
});

describe('deriveEvaluationLatency', () => {
  it('derives a latency record from a well-formed measurable span', () => {
    const record = deriveEvaluationLatency(makeSpan({
      name: 'hook:session-start',
      startTime: [1707400000, 0],
      duration: [2, 500_000_000],
    }));

    expect(record).not.toBeNull();
    expect(record!.evaluationName).toBe('evaluation_latency');
    expect(record!.scoreValue).toBe(2.5);
    expect(record!.scoreUnit).toBe('seconds');
    expect(record!.explanation).toContain('2.5');
    expect(record!.timestamp).toBe('2024-02-08T13:46:40.000Z');
  });

  it('returns null for a span whose name is not measurable', () => {
    expect(deriveEvaluationLatency(makeSpan({ name: 'hook:user-prompt' }))).toBeNull();
  });

  // OBP15: a malformed span must be skipped, not turned into a record. The three
  // records this guards against were all hook:session-start with NaN duration, and
  // were invalid three ways at once — null score, the literal "NaN" in user-facing
  // explanation text, and a 1970 timestamp.
  it('returns null when the duration is not finite', () => {
    expect(deriveEvaluationLatency(makeSpan({
      name: 'hook:session-start',
      duration: [NaN, 0],
    }))).toBeNull();
  });

  it('returns null when the span carries no duration at all', () => {
    // A span empty beyond its name. localTraceSpanSchema rejects this shape, so main()
    // never passes one through — but the function is exported, and returning null is a
    // better contract for a direct caller than throwing inside hrtToSeconds.
    const span = makeSpan({ name: 'hook:session-start' });
    delete (span as Partial<TraceSpan>).duration;

    expect(deriveEvaluationLatency(span)).toBeNull();
  });

  it('returns null for an epoch-ish startTime rather than dating the record to 1970', () => {
    expect(deriveEvaluationLatency(makeSpan({
      name: 'hook:session-start',
      startTime: [2, 0],
      duration: [1, 0],
    }))).toBeNull();
  });
});

describe('resolveSource', () => {
  it('defaults to cloud (cloud-read Phase 6)', () => {
    expect(resolveSource([])).toBe('cloud');
  });

  it('keeps local as the rollback', () => {
    expect(resolveSource(['--source=local'])).toBe('local');
  });

  it("uses the caller's default when no flag is given", () => {
    expect(resolveSource([], 'local')).toBe('local');
    expect(resolveSource(['--source=cloud'], 'local')).toBe('cloud');
  });

  it('rejects an unknown source', () => {
    expect(() => resolveSource(['--source=s3'])).toThrow('local|cloud');
  });
});

describe('readScope', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  const named = new Set(['2026-09-30']);

  it('bounds an unscoped cloud read to the last N UTC days, today included', () => {
    expect(readScope('cloud', null, 3, now)).toEqual(new Set(['2026-10-02', '2026-10-03', '2026-10-04']));
  });

  it("keeps the caller's dates for either source", () => {
    expect(readScope('cloud', named, 3, now)).toBe(named);
    expect(readScope('local', named, 3, now)).toBe(named);
  });

  it('leaves an unscoped local read unbounded, so it reads every trace file', () => {
    expect(readScope('local', null, 3, now)).toBeNull();
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

  it('keeps the previous entry, with its own window, for a metric this run could not recompute', () => {
    const previous = { task_completion: entry(0.5, MARCH), tool_correctness: entry(0.6, MARCH) };
    const fresh = { tool_correctness: entry(0.7, SEPTEMBER) };

    const merged = carryForwardDistributions(previous, fresh);

    expect(merged.task_completion).toEqual(entry(0.5, MARCH));
  });

  it('always prefers a freshly computed entry', () => {
    const merged = carryForwardDistributions(
      { tool_correctness: entry(0.6, MARCH) },
      { tool_correctness: entry(0.7, SEPTEMBER) },
    );

    expect(merged).toEqual({ tool_correctness: entry(0.7, SEPTEMBER) });
  });

  it('returns the fresh entries when there is no previous state', () => {
    const fresh = { tool_correctness: entry(0.7, SEPTEMBER) };

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
  const taskSpan = makeSpan({ attributes: { 'builtin.task_status': 'completed', 'builtin.task_id': 't1' } });

  it('stamps records with the account of the span they score', () => {
    const records = deriveAll({ spans: [taskSpan], accounts: new Map([['span-001', 'OBTOOL_API_KEY']]) });

    expect(records.length).toBeGreaterThan(0);
    expect(records.every(r => r.identityKeyRef === 'OBTOOL_API_KEY')).toBe(true);
  });

  it('gives the same records when run twice in one process', () => {
    const loaded = { spans: [taskSpan], accounts: new Map() };

    const first = deriveAll(loaded);
    const second = deriveAll(loaded);

    expect(second).toEqual(first);
  });
});

// builtin.* key rename (hooks 2026-09-18)
//
// Regression: derive read `builtin.*` keys, the hooks started writing
// `gen_ai.tool.name` / `integritystudio.tool.*` / `integritystudio.task.*`, and
// every builtin tool call scored 0 (3,363 of 3,365 records on 2026-09-26) while
// task tracking never fired. Both spellings live in the local files, so each
// behavior is pinned for both.

/** A post-rename builtin post-tool span, shaped like the hooks write it today. */
function renamedToolSpan(attributes: Record<string, unknown>): TraceSpan {
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name: 'hook:builtin-post-tool',
    startTime: [1790553614, 235000000],
    endTime: [1790553614, 236463666],
    duration: [0, 1463666],
    status: { code: 1 },
    attributes: { 'session.id': 'sess-abc', 'integritystudio.hook.name': 'builtin-post-tool', ...attributes },
  };
}

describe('deriveToolCorrectness across the builtin.* rename', () => {
  it.each([
    ['canonical', { 'gen_ai.tool.name': 'Bash', 'integritystudio.tool.success': true }],
    ['legacy', { 'builtin.tool': 'Bash', 'builtin.success': true }],
  ])('scores a successful call 1 from %s keys', (_era, attributes) => {
    const record = deriveToolCorrectness(renamedToolSpan(attributes));

    expect(record?.scoreValue).toBe(1);
    expect(record?.explanation).toBe('Tool Bash completed successfully');
  });

  it.each([
    ['canonical', { 'gen_ai.tool.name': 'Edit', 'integritystudio.tool.success': false, 'integritystudio.tool.error_type': 'file_not_read' }],
    ['legacy', { 'builtin.tool': 'Edit', 'builtin.success': false, 'builtin.error_type': 'file_not_read' }],
  ])('scores a failed call 0 with its error type from %s keys', (_era, attributes) => {
    const record = deriveToolCorrectness(renamedToolSpan(attributes));

    expect(record?.scoreValue).toBe(0);
    expect(record?.explanation).toBe('Tool Edit failed: file_not_read');
  });

  it('still reads MCP spans from their legacy mcp.* keys', () => {
    const span = { ...renamedToolSpan({ 'mcp.server': 'github', 'mcp.tool': 'get_me', 'mcp.success': true }), name: 'hook:mcp-post-tool' };

    const record = deriveToolCorrectness(span);

    expect(record?.scoreValue).toBe(1);
    expect(record?.explanation).toBe('Tool github/get_me completed successfully');
  });
});

describe('task tracking across the builtin.* rename', () => {
  it.each([
    ['canonical', { 'gen_ai.tool.name': 'TaskUpdate', 'integritystudio.task.id': 't1', 'integritystudio.task.status': 'completed' }],
    ['legacy', { 'builtin.tool': 'TaskUpdate', 'builtin.task_id': 't1', 'builtin.task_status': 'completed' }],
  ])('scores a completed task 1 from %s keys', (_era, attributes) => {
    trackTaskActivity(renamedToolSpan(attributes));

    const [record] = deriveTaskCompletionPerSession();

    expect(record?.scoreValue).toBe(1);
    expect(record?.explanation).toBe('Session sess-abc: 1 tasks (1 completed)');
  });
});

describe('deriveEvaluationLatency across the builtin.* rename', () => {
  it('names the tool from the canonical key', () => {
    const record = deriveEvaluationLatency(renamedToolSpan({ 'gen_ai.tool.name': 'Bash', 'integritystudio.tool.success': true }));

    expect(record?.explanation).toMatch(/^Hook builtin\/Bash executed in /);
  });
});

describe('deriveAll across the builtin.* rename', () => {
  it('scores a day of mostly successful post-rename calls as mostly successful', () => {
    const spans = [
      renamedToolSpan({ 'gen_ai.tool.name': 'Read', 'integritystudio.tool.success': true }),
      { ...renamedToolSpan({ 'gen_ai.tool.name': 'Bash', 'integritystudio.tool.success': true }), spanId: 'span-002' },
      { ...renamedToolSpan({ 'gen_ai.tool.name': 'Edit', 'integritystudio.tool.success': false }), spanId: 'span-003' },
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
    attributes: { 'session.id': 'sess-abc', 'integritystudio.hook.name': 'mcp-post-tool', ...attributes },
  };
}

describe('deriveToolCorrectness across the mcp.* rename', () => {
  it.each([
    ['canonical', { 'integritystudio.mcp.server': 'github', 'integritystudio.mcp.tool': 'get_me', 'integritystudio.mcp.success': true }],
    ['legacy', { 'mcp.server': 'github', 'mcp.tool': 'get_me', 'mcp.success': true }],
  ])('scores a successful call 1 from %s keys', (_era, attributes) => {
    const record = deriveToolCorrectness(mcpToolSpan(attributes));

    expect(record?.scoreValue).toBe(1);
    expect(record?.explanation).toBe('Tool github/get_me completed successfully');
  });

  it.each([
    ['canonical', { 'integritystudio.mcp.server': 'github', 'integritystudio.mcp.tool': 'create_issue', 'integritystudio.mcp.success': false, 'integritystudio.mcp.error_type': 'rate_limited' }],
    ['legacy', { 'mcp.server': 'github', 'mcp.tool': 'create_issue', 'mcp.success': false, 'mcp.error_type': 'rate_limited' }],
  ])('scores a failed call 0 with its error type from %s keys', (_era, attributes) => {
    const record = deriveToolCorrectness(mcpToolSpan(attributes));

    expect(record?.scoreValue).toBe(0);
    expect(record?.explanation).toBe('Tool github/create_issue failed: rate_limited');
  });

  it('reads the canonical key when a span carries both, even a canonical false', () => {
    const record = deriveToolCorrectness(mcpToolSpan({
      'integritystudio.mcp.server': 'github',
      'integritystudio.mcp.tool': 'create_issue',
      'integritystudio.mcp.success': false,
      'integritystudio.mcp.error_type': 'rate_limited',
      'mcp.server': 'gitlab',
      'mcp.tool': 'get_me',
      'mcp.success': true,
      'mcp.error_type': 'stale',
    }));

    expect(record?.scoreValue).toBe(0);
    expect(record?.explanation).toBe('Tool github/create_issue failed: rate_limited');
  });
});

describe('deriveEvaluationLatency across the mcp.* rename', () => {
  it.each([
    ['only the canonical key', { 'integritystudio.mcp.tool': 'get_me' }],
    ['only the legacy key', { 'mcp.tool': 'get_me' }],
    ['both keys, canonical first', { 'integritystudio.mcp.tool': 'get_me', 'mcp.tool': 'stale' }],
  ])('names the tool from a span with %s', (_era, attributes) => {
    const record = deriveEvaluationLatency(mcpToolSpan(attributes));

    expect(record?.explanation).toMatch(/^Hook mcp\/get_me executed in /);
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

/** An Agent-tool hook span in one session, shaped like the hooks write it today. */
function agentHookSpan(phase: 'prepare' | 'finalize', agentName: string, spanId: string, startSec: number): TraceSpan {
  return {
    traceId: 'trace-001',
    spanId,
    name: `hook:agent.operation.${phase}`,
    startTime: [startSec, 0],
    endTime: [startSec, 1_000_000],
    duration: [0, 1_000_000],
    status: { code: OTEL_STATUS_OK },
    attributes: {
      'session.id': 'sess-agents',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agentName,
      'integritystudio.agent.type': agentName,
      'integritystudio.hook.name': `agent.operation.${phase}`,
    },
  };
}

describe('deriveAll over the renamed agent hook spans', () => {
  const START_SEC = 1_790_000_000;
  const spans = [
    agentHookSpan('prepare', 'Explore', 'span-p1', START_SEC),
    agentHookSpan('finalize', 'Explore', 'span-f1', START_SEC + 10),
    agentHookSpan('prepare', 'code-reviewer', 'span-p2', START_SEC + 20),
    agentHookSpan('finalize', 'code-reviewer', 'span-f2', START_SEC + 30),
  ];
  const records = (): EvalRecord[] => deriveAll({ spans, accounts: new Map() });

  it('scores agent completion from prepare and finalize counts', () => {
    const completion = records().filter(r => r.evaluationName === 'task_completion');

    expect(completion.map(r => r.scoreValue)).toEqual([1]);
    expect(completion[0]?.explanation).toMatch(/^Agent completion: 2\/2 agents finished/);
  });

  it('scores a handoff between two different agents', () => {
    const handoffs = records().filter(r => r.evaluationName === 'handoff_correctness');

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.scoreValue).toBe(1);
    expect(handoffs[0]?.spanId).toBe('span-f2');
  });

  // Regression: two agents finishing in parallel land in the trace file in the
  // opposite order to their start times, so local derive attached the session
  // record to one span and cloud derive, which reads in start order, to the other.
  it('attaches session records to the latest-starting span whatever order the spans arrive in', () => {
    const [p1, f1, p2, f2] = spans;
    const writeOrder = [p1!, p2!, f2!, f1!];

    const fromWriteOrder = deriveAll({ spans: writeOrder, accounts: new Map() })
      .filter(r => r.evaluationName !== 'evaluation_latency');

    expect(fromWriteOrder).toEqual(records().filter(r => r.evaluationName !== 'evaluation_latency'));
    expect(fromWriteOrder.every(r => r.spanId === 'span-f2')).toBe(true);
  });

  it('measures the finalize hook latency under the agent type', () => {
    const latency = records().filter(r => r.evaluationName === 'evaluation_latency');

    expect(latency.map(r => r.explanation)).toEqual([
      expect.stringMatching(/^Hook agent\/Explore executed in /),
      expect.stringMatching(/^Hook agent\/code-reviewer executed in /),
    ]);
  });
});

// handoff_correctness failure signals (DERIVE-AGENT-SCORE-HOOK-STATUS)
//
// Score 0 when the agent's own error flag is set (`integritystudio.agent.has_error`),
// or when the hook itself throws (span.status.code === ERROR). Before this fix
// only the hook-crash path was handled, so a failed agent scored as a correct
// handoff.

describe('handoff_correctness scores agent failures correctly', () => {
  const START_SEC = 1_791_000_000;

  function agentHookSpanWith(
    phase: 'prepare' | 'finalize',
    agentName: string,
    spanId: string,
    startSec: number,
    extra: { statusCode?: number; hasError?: boolean } = {},
  ): TraceSpan {
    return {
      ...agentHookSpan(phase, agentName, spanId, startSec),
      attributes: {
        'session.id': 'sess-failure',
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': agentName,
        'integritystudio.agent.type': agentName,
        'integritystudio.hook.name': `agent.operation.${phase}`,
        ...(extra.hasError !== undefined && { 'integritystudio.agent.has_error': extra.hasError }),
      },
      status: { code: extra.statusCode ?? OTEL_STATUS_OK },
    };
  }

  // The handoff loop scores on the RECEIVING agent (curr.score), not the sender.
  // A failed sending agent therefore does not degrade handoff_correctness; the
  // test below pins this semantics explicitly so any future change to include
  // the sender score is visible in the test output.
  it('keeps handoff_correctness at 1 when only the sending agent fails (receiver score drives the transition)', () => {
    const spansWithSenderError = [
      agentHookSpanWith('prepare', 'Explore', 'p1', START_SEC),
      agentHookSpanWith('finalize', 'Explore', 'f1', START_SEC + 10, { hasError: true }),
      agentHookSpanWith('prepare', 'code-reviewer', 'p2', START_SEC + 20),
      agentHookSpanWith('finalize', 'code-reviewer', 'f2', START_SEC + 30),
    ];
    const handoffs = deriveAll({ spans: spansWithSenderError, accounts: new Map() })
      .filter(r => r.evaluationName === 'handoff_correctness');

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.scoreValue).toBe(1);
  });

  it('scores 0 for a handoff when the receiving agent has error flag set', () => {
    const spansReceiverFailed = [
      agentHookSpanWith('prepare', 'Explore', 'p1', START_SEC),
      agentHookSpanWith('finalize', 'Explore', 'f1', START_SEC + 10),
      agentHookSpanWith('prepare', 'code-reviewer', 'p2', START_SEC + 20),
      agentHookSpanWith('finalize', 'code-reviewer', 'f2', START_SEC + 30, { hasError: true }),
    ];
    const handoffs = deriveAll({ spans: spansReceiverFailed, accounts: new Map() })
      .filter(r => r.evaluationName === 'handoff_correctness');

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.scoreValue).toBe(0);
  });

  it('scores 0 when the hook itself throws (span status ERROR, no has_error attribute)', () => {
    const spansHookCrash = [
      agentHookSpanWith('prepare', 'Explore', 'p1', START_SEC),
      agentHookSpanWith('finalize', 'Explore', 'f1', START_SEC + 10),
      agentHookSpanWith('prepare', 'code-reviewer', 'p2', START_SEC + 20),
      agentHookSpanWith('finalize', 'code-reviewer', 'f2', START_SEC + 30, { statusCode: OTEL_STATUS_ERROR_CODE }),
    ];
    const handoffs = deriveAll({ spans: spansHookCrash, accounts: new Map() })
      .filter(r => r.evaluationName === 'handoff_correctness');

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.scoreValue).toBe(0);
  });

  it('scores 1 when the agent succeeds (no error flag, status OK)', () => {
    const spansSuccess = [
      agentHookSpanWith('prepare', 'Explore', 'p1', START_SEC),
      agentHookSpanWith('finalize', 'Explore', 'f1', START_SEC + 10),
      agentHookSpanWith('prepare', 'code-reviewer', 'p2', START_SEC + 20),
      agentHookSpanWith('finalize', 'code-reviewer', 'f2', START_SEC + 30),
    ];
    const handoffs = deriveAll({ spans: spansSuccess, accounts: new Map() })
      .filter(r => r.evaluationName === 'handoff_correctness');

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.scoreValue).toBe(1);
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

  function toolSpans(count: number, attributes: Record<string, unknown>, fromIndex = 0): TraceSpan[] {
    return Array.from({ length: count }, (_, i) => ({
      ...renamedToolSpan({ 'gen_ai.tool.name': 'Read', ...attributes }),
      spanId: `tool-${fromIndex + i}`,
      startTime: [DAY_START_SEC + fromIndex + i, 0] as [number, number],
    }));
  }

  function agentSpans(name: string): TraceSpan[] {
    return [
      { ...agentHookSpan('prepare', 'Explore', 'span-p1', DAY_START_SEC), name: name.replace('finalize', 'prepare') },
      { ...agentHookSpan('finalize', 'Explore', 'span-f1', DAY_START_SEC + 10), name },
    ];
  }

  it('is quiet on a day whose spans derive reads', () => {
    const spans = [...agentSpans('hook:agent.operation.finalize'), ...toolSpans(TOOL_SPANS_PER_DAY, { 'integritystudio.tool.success': true })];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('flags a day whose agent spans derive no longer matches by name', () => {
    const renamed = agentSpans('hook:agent.lifecycle.finalize');

    expect(detectInputDrift(renamed, null)).toEqual([
      expect.stringMatching(new RegExp(`^${DAY}: 2 spans record agent invocations, but none is named`)),
    ]);
  });

  // Since 2026-09-29 the hook spans carry no gen_ai.operation.name; the synthetic
  // `invoke_agent <agent>` span is the only evidence of an invocation.
  const withoutOperation = (span: TraceSpan): TraceSpan => ({
    ...span,
    attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) => key !== 'gen_ai.operation.name')),
  });
  const syntheticInvokeSpan: TraceSpan = {
    ...agentHookSpan('finalize', 'Explore', 'span-i1', DAY_START_SEC + 5),
    name: 'invoke_agent Explore',
    attributes: { 'session.id': 'sess-agents', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'Explore' },
  };

  it('is quiet when only the synthetic span carries the operation and the hook spans keep their names', () => {
    const spans = [...agentSpans('hook:agent.operation.finalize').map(withoutOperation), syntheticInvokeSpan];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('still flags renamed hook spans when only the synthetic span records the invocation', () => {
    const spans = [...agentSpans('hook:agent.lifecycle.finalize').map(withoutOperation), syntheticInvokeSpan];

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
    const legacy = toolSpans(TOOL_SPANS_PER_DAY, { 'builtin.success': true });

    expect(detectInputDrift(legacy, null)).toEqual([]);
  });

  it.each([
    ['canonical', { 'integritystudio.mcp.success': true }],
    ['legacy', { 'mcp.success': true }],
  ])('reads the MCP success flag from %s keys', (_era, attributes) => {
    const mcp = toolSpans(TOOL_SPANS_PER_DAY, attributes).map(span => ({ ...span, name: 'hook:mcp-post-tool' }));

    expect(detectInputDrift(mcp, null)).toEqual([]);
  });

  it('tolerates hooks that failed before recording, up to half the day', () => {
    const half = TOOL_SPANS_PER_DAY - 1;
    const spans = [
      ...toolSpans(half, { 'integritystudio.tool.success': true }),
      ...toolSpans(half, {}, half),
    ];

    expect(detectInputDrift(spans, null)).toEqual([]);
  });

  it('ignores a day with too few tool spans to judge', () => {
    const fewMissing = toolSpans(5, {});

    expect(detectInputDrift(fewMissing, null)).toEqual([]);
  });

  it('checks only the days in scope', () => {
    const renamed = agentSpans('hook:agent.lifecycle.finalize');

    expect(detectInputDrift(renamed, new Set(['2026-09-27']))).toEqual([]);
  });
});

describe('deriveAgentHeuristics', () => {
  const SINCE_MS = 1707400000_000;
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'derive-agent-heuristics-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function transcript(name: string, entries: object[]): string {
    const path = join(dir, name);
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return path;
  }

  const prompt = (text: string): object => ({ type: 'user', message: { role: 'user', content: text } });
  const reply = (content: unknown[]): object => ({ type: 'assistant', message: { role: 'assistant', content } });

  function subagentStop(transcriptPath: string, overrides: Partial<TraceSpan> = {}): TraceSpan {
    return makeSpan({
      name: 'hook:subagent-stop',
      spanId: 'span-stop',
      ...overrides,
      attributes: {
        'integritystudio.agent.transcript_path': transcriptPath,
        'integritystudio.agent.type': 'code-reviewer',
      },
    });
  }

  it('scores a subagent run from its transcript on its subagent-stop span, with labels', async () => {
    const path = transcript('agent.jsonl', [
      prompt('Review the diff'),
      reply([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '' } }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      reply([{ type: 'text', text: 'No findings.' }]),
    ]);

    const records = await deriveAgentHeuristics([subagentStop(path)], SINCE_MS, new Map());

    expect(records.map(r => r.evaluationName)).toEqual(['argument_correctness', 'agent_overall']);
    const args = records[0]!;
    // The one argument is empty, so the call scores 0 and fails.
    expect(args).toMatchObject({ scoreValue: 0, scoreLabel: 'fail', spanId: 'span-stop', sessionId: 'sess-abc' });
    expect(args.explanation).toBe('code-reviewer agent: 1 tool calls');
    expect(records[1]!.scoreLabel).toMatch(/^(pass|partial|fail)$/);
  });

  it('scores a session from its transcript on the session\'s last span', async () => {
    const path = transcript('session.jsonl', [
      prompt('Fix the build'),
      reply([{ type: 'text', text: 'Fixed the build.' }]),
    ]);
    const first = makeSpan({ spanId: 'span-early', startTime: [1707400000, 0] });
    const last = makeSpan({ spanId: 'span-late', startTime: [1707400050, 0] });

    const records = await deriveAgentHeuristics([last, first], SINCE_MS, new Map([['sess-abc', path]]));

    expect(records.map(r => r.evaluationName)).toEqual(['conversation_completeness', 'turn_relevancy', 'conversation_overall']);
    expect(records.every(r => r.spanId === 'span-late')).toBe(true);
    expect(records[1]).toMatchObject({ scoreLabel: 'relevant', explanation: 'Session sess-abc: 2 turns' });
  });

  it('skips a run or session whose transcript is not on this machine', async () => {
    const records = await deriveAgentHeuristics(
      [subagentStop(join(dir, 'gone.jsonl'))], SINCE_MS, new Map([['sess-abc', join(dir, 'also-gone.jsonl')]]));
    expect(records).toEqual([]);
  });

  it('reads no span that starts before the floor', async () => {
    const path = transcript('agent.jsonl', [prompt('Review'), reply([{ type: 'text', text: 'Done.' }])]);
    const early = subagentStop(path, { startTime: [1707399999, 0] });

    const records = await deriveAgentHeuristics([early], SINCE_MS, new Map([['sess-abc', path]]));

    expect(records).toEqual([]);
  });
});
