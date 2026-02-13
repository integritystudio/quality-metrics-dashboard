import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackTaskActivity,
  deriveTaskCompletionPerSession,
  scoreTask,
  sessionTasks,
  STATUS_SCORES,
  type TraceSpan,
} from '../derive-evaluations.js';

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
    const task = [...data.tasks.values()][0];
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

  it('assigns anonymous ID when taskId missing', () => {
    trackTaskActivity(makeSpan({
      attributes: {
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'session.id': 'sess-abc',
      },
    }));

    const data = sessionTasks.get('sess-abc')!;
    expect(data.tasks.has('anon-1')).toBe(true);
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
    expect(evals[0].scoreValue).toBe(1.0);
    expect(evals[0].evaluationName).toBe('task_completion');
    expect(evals[0].explanation).toContain('1 completed');
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
    expect(evals[0].scoreValue).toBe(0.75); // (1.0 + 0.5) / 2
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
    expect(evals[0].scoreValue).toBe(1.0); // 2 updates / (1 create * 2) = 1.0
    expect(evals[0].explanation).toContain('ratio fallback');
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
    expect(evals[0].scoreValue).toBe(0.0);
    expect(evals[0].explanation).toContain('1 pending');
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
