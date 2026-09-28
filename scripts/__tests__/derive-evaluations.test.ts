import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  trackTaskActivity,
  deriveTaskCompletionPerSession,
  deriveEvaluationLatency,
  derivedEvaluationsPath,
  deriveAll,
  deriveToolCorrectness,
  resolvePostDays,
  resolveSource,
  scoreTask,
  sessionTasks,
  splitAtCutover,
  postFloorMs,
  writeDerivedEvaluations,
  STATUS_SCORES,
  type TraceSpan,
} from '../derive-evaluations.js';
import { DERIVE_DIRECT_POST_SINCE_MS, type EvalRecord } from '../judge-evaluations.js';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  sessionTasks.clear();
});

// ---------------------------------------------------------------------------
// scoreTask
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// STATUS_SCORES
// ---------------------------------------------------------------------------

describe('STATUS_SCORES', () => {
  it('has expected keys and values', () => {
    expect(STATUS_SCORES).toEqual({
      pending: 0.0,
      in_progress: 0.5,
      completed: 1.0,
    });
  });
});

// ---------------------------------------------------------------------------
// trackTaskActivity
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// deriveTaskCompletionPerSession
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// deriveEvaluationLatency
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// writeDerivedEvaluations — a file of its own (HDF5)
// ---------------------------------------------------------------------------

describe('writeDerivedEvaluations', () => {
  let dir: string;
  const DATE = '2026-09-27';
  const line = (n: number): string => JSON.stringify({ name: 'gen_ai.evaluation.result', n });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'derive-write-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes derived-evaluations-<date>.jsonl and never opens the hooks' file", () => {
    const hooksFile = join(dir, `evaluations-${DATE}.jsonl`);
    writeFileSync(hooksFile, 'hooks-line\n');

    const result = writeDerivedEvaluations(dir, DATE, [line(1), line(2)], false);

    expect(result).toEqual({ file: `derived-evaluations-${DATE}.jsonl`, lines: 2, existing: 0 });
    expect(readFileSync(derivedEvaluationsPath(dir, DATE), 'utf8')).toBe(`${line(1)}\n${line(2)}\n`);
    expect(readFileSync(hooksFile, 'utf8')).toBe('hooks-line\n');
  });

  it('replaces the file wholesale, so a second run cannot accumulate the first', () => {
    // The failure this replaced: the old write into evaluations-<date>.jsonl
    // preserved every line whose `gen_ai.evaluation.evaluator` was not `rule`,
    // an attribute the writer had stopped emitting, so each run kept its own
    // previous output and prepended a fresh copy — 57,156 lines for 4,641
    // distinct records on 2026-09-22.
    writeDerivedEvaluations(dir, DATE, [line(1), line(2), line(3)], false);
    writeDerivedEvaluations(dir, DATE, [line(4)], false);

    expect(readFileSync(derivedEvaluationsPath(dir, DATE), 'utf8')).toBe(`${line(4)}\n`);
  });

  it('writes nothing on a dry run and reports what the file holds now', () => {
    writeDerivedEvaluations(dir, DATE, [line(1), line(2)], false);

    const result = writeDerivedEvaluations(dir, DATE, [line(3)], true);

    expect(result).toEqual({ file: `derived-evaluations-${DATE}.jsonl`, lines: 1, existing: 2 });
    expect(readFileSync(derivedEvaluationsPath(dir, DATE), 'utf8')).toBe(`${line(1)}\n${line(2)}\n`);
  });

  it('creates no file on a dry run when none exists', () => {
    writeDerivedEvaluations(dir, DATE, [line(1)], true);

    expect(existsSync(derivedEvaluationsPath(dir, DATE))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveSource
// ---------------------------------------------------------------------------

describe('resolveSource', () => {
  const scope = new Set(['2026-09-26']);

  it('defaults to local, with or without a date scope', () => {
    expect(resolveSource([], null)).toBe('local');
    expect(resolveSource([], scope)).toBe('local');
  });

  it('accepts cloud with a date scope', () => {
    expect(resolveSource(['--source=cloud'], scope)).toBe('cloud');
  });

  it('refuses cloud without a date scope', () => {
    expect(() => resolveSource(['--source=cloud'], null)).toThrow('--date= or --days=');
  });

  it('rejects an unknown source', () => {
    expect(() => resolveSource(['--source=s3'], scope)).toThrow('local|cloud');
  });
});

// ---------------------------------------------------------------------------
// splitAtCutover (cloud-read migration Phase 3)
// ---------------------------------------------------------------------------

describe('splitAtCutover', () => {
  const at = (ms: number): EvalRecord =>
    ({ timestamp: new Date(ms).toISOString(), evaluationName: 'tool_correctness', scoreValue: 1 }) as EvalRecord;

  it('posts records at or after the cutover and files the ones before it', () => {
    const before = at(DERIVE_DIRECT_POST_SINCE_MS - 1);
    const exactly = at(DERIVE_DIRECT_POST_SINCE_MS);
    const after = at(DERIVE_DIRECT_POST_SINCE_MS + 1);

    expect(splitAtCutover([after, before, exactly])).toEqual({ toFile: [before], toPost: [after, exactly] });
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
  });

  it.each(['0', '1.5', '2d', ''])('rejects "%s"', (raw) => {
    expect(() => resolvePostDays([`--post-days=${raw}`])).toThrow('--post-days= must be a positive integer');
  });
});

// ---------------------------------------------------------------------------
// deriveAll
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// builtin.* key rename (hooks 2026-09-18)
//
// Regression: derive read `builtin.*` keys, the hooks started writing
// `gen_ai.tool.name` / `integritystudio.tool.*` / `integritystudio.task.*`, and
// every builtin tool call scored 0 (3,363 of 3,365 records on 2026-09-26) while
// task tracking never fired. Both spellings live in the local files, so each
// behavior is pinned for both.
// ---------------------------------------------------------------------------

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

  it('still reads MCP spans from their mcp.* keys, which were not renamed', () => {
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

// ---------------------------------------------------------------------------
// Agent hook rename (hooks 2026-08-13)
//
// Regression: derive matched `hook:agent-pre-tool` / `hook:agent-post-tool`,
// the hooks renamed them to `hook:agent.operation.prepare` / `.finalize`, and
// agent completion, handoff_correctness and agent hook latency produced
// nothing for six weeks. The names below are copied from real spans, not from
// the constants, so a wrong constant fails here instead of matching itself.
// ---------------------------------------------------------------------------

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
