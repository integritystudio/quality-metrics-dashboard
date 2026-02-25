/**
 * M34: Dashboard pipeline integration tests.
 *
 * Validates the populate → derive → judge → sync pipeline contract:
 * - derive-evaluations output format matches what judge-evaluations reads
 * - judge-evaluations (seed mode) output matches what sync-to-kv expects
 * - OTel evaluation record shape is stable across pipeline steps
 * - deduplication keys prevent re-evaluation of already-scored turns
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// derive-evaluations exports
import {
  trackTaskActivity,
  deriveTaskCompletionPerSession,
  sessionTasks,
  type TraceSpan,
  type EvalRecord as DeriveEvalRecord,
} from '../derive-evaluations.js';

// judge-evaluations exports
import {
  seedEvaluations,
  toOTelRecord,
  isCanaryTurn,
  type Turn,
  type EvalRecord as JudgeEvalRecord,
} from '../judge-evaluations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceSpan(overrides: Partial<TraceSpan> & { attributes?: Record<string, unknown> }): TraceSpan {
  const { attributes: attrOverrides, ...rest } = overrides;
  return {
    traceId: 'trace-pipeline-001',
    spanId: 'span-001',
    name: 'hook:builtin-post-tool',
    startTime: [1740441600, 0], // 2026-02-25T00:00:00Z
    endTime: [1740441601, 0],
    duration: [1, 0],
    status: { code: 0 },
    ...rest,
    attributes: {
      'session.id': 'sess-pipeline',
      'builtin.tool': 'TaskCreate',
      'builtin.task_status': 'pending',
      'builtin.task_id': 'task-001',
      ...attrOverrides,
    },
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'pipeline-sess-abc',
    traceId: 'trace-pipeline-001',
    timestamp: '2026-02-25T00:00:00.000Z',
    userText: 'Fix the authentication bug in login.ts',
    assistantText: 'I found the issue in the JWT validation. Here is the fix.',
    toolResults: [],
    ...overrides,
  };
}

/** Parse a JSONL string into an array of objects */
function parseJsonl(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Step 1 → Step 2 Contract: derive output → judge input format
// ---------------------------------------------------------------------------

describe('pipeline contract: derive → judge', () => {
  beforeEach(() => {
    sessionTasks.clear();
  });

  it('derive-evaluations toOTelRecord produces valid gen_ai.evaluation.result events', () => {
    // Simulate a full task lifecycle
    trackTaskActivity(makeTraceSpan({
      attributes: { 'session.id': 'sess-pipeline', 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 'task-1' },
    }));
    trackTaskActivity(makeTraceSpan({
      attributes: { 'session.id': 'sess-pipeline', 'builtin.tool': 'TaskUpdate', 'builtin.task_status': 'completed', 'builtin.task_id': 'task-1' },
    }));

    const evals = deriveTaskCompletionPerSession();
    expect(evals).toHaveLength(1);

    const [ev] = evals;
    // Convert to OTel format (same function used by derive-evaluations main)
    const otelRecord = toOTelRecord(ev) as Record<string, unknown>;

    // Validate the OTel record shape that sync-to-kv expects to read back
    expect(otelRecord.name).toBe('gen_ai.evaluation.result');
    expect(typeof otelRecord.timestamp).toBe('string');
    expect(typeof otelRecord.traceId).toBe('string');

    const attrs = otelRecord.attributes as Record<string, unknown>;
    expect(attrs['gen_ai.evaluation.name']).toBe('task_completion');
    expect(typeof attrs['gen_ai.evaluation.score.value']).toBe('number');
    expect(attrs['gen_ai.evaluation.score.value']).toBe(1.0);
    expect(typeof attrs['gen_ai.evaluation.explanation']).toBe('string');
    expect(attrs['gen_ai.evaluation.evaluator']).toBe('telemetry-rule-engine');
    expect(attrs['gen_ai.evaluation.evaluator.type']).toBe('rule');
    expect(attrs['session.id']).toBe('sess-pipeline');
  });

  it('derive evaluation record has all required fields for judge dedup keys', () => {
    trackTaskActivity(makeTraceSpan({
      attributes: { 'session.id': 'sess-dedup', 'builtin.tool': 'TaskCreate', 'builtin.task_status': 'pending', 'builtin.task_id': 'task-2' },
    }));

    const evals = deriveTaskCompletionPerSession();
    const [ev] = evals;

    // Judge dedup key format: `${sessionId}:${evaluationName}:${turnKey}`
    // Verify all fields needed to construct dedup keys are present
    expect(typeof ev.sessionId).toBe('string');
    expect(ev.sessionId.length).toBeGreaterThan(0);
    expect(typeof ev.evaluationName).toBe('string');
    expect(typeof ev.timestamp).toBe('string');
    // ISO timestamp parseable to construct turnKey (first 19 chars)
    const turnKey = ev.timestamp.slice(0, 19);
    expect(turnKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Step 2 Contract: judge seed output format
// ---------------------------------------------------------------------------

describe('pipeline contract: judge seed output', () => {
  it('seedEvaluations produces OTel-compatible records', () => {
    const turns = [makeTurn(), makeTurn({ sessionId: 'sess-b', timestamp: '2026-02-25T01:00:00.000Z' })];
    const { evals } = seedEvaluations(turns, new Set());

    expect(evals.length).toBeGreaterThan(0);

    for (const ev of evals) {
      // Each eval must be convertible to OTel format
      const otelRecord = toOTelRecord(ev) as Record<string, unknown>;
      const attrs = otelRecord.attributes as Record<string, unknown>;

      // Required fields for sync-to-kv MultiDirectoryBackend to ingest
      expect(otelRecord.name).toBe('gen_ai.evaluation.result');
      expect(typeof otelRecord.timestamp).toBe('string');
      expect(new Date(otelRecord.timestamp as string).getTime()).toBeGreaterThan(0);
      expect(typeof attrs['gen_ai.evaluation.name']).toBe('string');
      expect(typeof attrs['gen_ai.evaluation.score.value']).toBe('number');
      const score = attrs['gen_ai.evaluation.score.value'] as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('seed output covers all 5 expected metric names when tool results present', () => {
    const turnWithTools = makeTurn({ toolResults: ['file contents here'] });
    const { evals } = seedEvaluations([turnWithTools], new Set());

    const names = new Set(evals.map(e => e.evaluationName));
    expect(names.has('relevance')).toBe(true);
    expect(names.has('coherence')).toBe(true);
    expect(names.has('faithfulness')).toBe(true);
    expect(names.has('hallucination')).toBe(true);
    expect(names.has('tool_correctness')).toBe(true);
  });

  it('seed output covers 4 metric names without tool results', () => {
    const turnNoTools = makeTurn({ toolResults: [] });
    const { evals } = seedEvaluations([turnNoTools], new Set());

    const names = new Set(evals.map(e => e.evaluationName));
    expect(names.has('relevance')).toBe(true);
    expect(names.has('coherence')).toBe(true);
    expect(names.has('faithfulness')).toBe(true);
    expect(names.has('hallucination')).toBe(true);
    expect(names.has('tool_correctness')).toBe(false);
  });

  it('faithfulness + hallucination scores sum to 1.0 (complementary invariant)', () => {
    const { evals } = seedEvaluations([makeTurn()], new Set());
    const faith = evals.find(e => e.evaluationName === 'faithfulness')!;
    const hal = evals.find(e => e.evaluationName === 'hallucination')!;
    expect(faith.scoreValue + hal.scoreValue).toBeCloseTo(1.0, 3);
  });

  it('canary evaluations have evaluatorType "canary", others have "seed"', () => {
    // Generate enough turns to hit at least one canary (~2% rate)
    const turns = Array.from({ length: 200 }, (_, i) =>
      makeTurn({
        sessionId: `canary-pipeline-${i}`,
        timestamp: `2026-02-25T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      })
    );
    const { evals, canaryCount } = seedEvaluations(turns, new Set());

    const canaryEvals = evals.filter(e => e.evaluatorType === 'canary');
    const seedEvals = evals.filter(e => e.evaluatorType === 'seed');

    expect(canaryCount).toBeGreaterThan(0);
    expect(canaryEvals.length).toBeGreaterThan(0);
    expect(seedEvals.length).toBeGreaterThan(0);

    // Canary evals should NOT appear if filtered out (as sync-to-kv does)
    const afterFilter = evals.filter(e => e.evaluatorType !== 'canary');
    expect(afterFilter.length).toBeLessThan(evals.length);
  });
});

// ---------------------------------------------------------------------------
// Step 2 → Step 3 Contract: judge output → sync-to-kv format
// ---------------------------------------------------------------------------

describe('pipeline contract: judge → sync-to-kv', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pipeline-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('JSONL written by judge is parseable and has required backend fields', () => {
    const turns = [
      makeTurn({ sessionId: 'test-session-001', traceId: 'trace-001' }),
      makeTurn({ sessionId: 'test-session-001', traceId: 'trace-002', timestamp: '2026-02-25T00:01:00.000Z' }),
    ];
    const { evals } = seedEvaluations(turns, new Set());

    // Simulate what judge-evaluations.ts writes to JSONL
    const outFile = join(tmpDir, 'evaluations-2026-02-25.jsonl');
    const lines = evals.map(ev => JSON.stringify(toOTelRecord(ev)));
    writeFileSync(outFile, lines.join('\n') + '\n');

    // Read back and validate backend-readable format
    const content = readFileSync(outFile, 'utf-8');
    const records = parseJsonl(content);

    expect(records.length).toBe(evals.length);

    for (const record of records) {
      // MultiDirectoryBackend.queryEvaluations() checks these fields
      expect(record.name).toBe('gen_ai.evaluation.result');
      expect(typeof record.timestamp).toBe('string');
      const ts = new Date(record.timestamp as string);
      expect(ts.getFullYear()).toBe(2026);

      const attrs = record.attributes as Record<string, unknown>;
      const evalName = attrs['gen_ai.evaluation.name'] as string;
      expect(['relevance', 'coherence', 'faithfulness', 'hallucination', 'tool_correctness', 'task_completion']).toContain(evalName);
      expect(typeof attrs['gen_ai.evaluation.score.value']).toBe('number');
    }
  });

  it('sync-to-kv canary filter removes canary evals before aggregation', () => {
    // Mix of regular and canary evals
    const turns = Array.from({ length: 100 }, (_, i) =>
      makeTurn({
        sessionId: `filter-test-${i}`,
        timestamp: `2026-02-25T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
      })
    );
    const { evals } = seedEvaluations(turns, new Set());

    // Simulate sync-to-kv canary filter
    const filtered = evals.filter(ev => ev.evaluatorType !== 'canary');

    // All remaining should have evaluatorType 'seed'
    for (const ev of filtered) {
      expect(ev.evaluatorType).toBe('seed');
    }
    // At least some canaries were removed if canary rate ~2% of 100 turns
    const hasCanaries = evals.some(ev => ev.evaluatorType === 'canary');
    if (hasCanaries) {
      expect(filtered.length).toBeLessThan(evals.length);
    }
  });

  it('deduplication prevents re-scoring already-evaluated turns', () => {
    const turn = makeTurn({
      sessionId: 'dedup-test',
      timestamp: '2026-02-25T00:00:00.000Z',
    });
    const turnKey = turn.timestamp.slice(0, 19);

    // First pass: no existing keys
    const { evals: firstPass } = seedEvaluations([turn], new Set());
    expect(firstPass.length).toBeGreaterThan(0);

    // Second pass: all keys already exist
    const existingKeys = new Set(
      firstPass.map(ev => `${ev.sessionId}:${ev.evaluationName}:${turnKey}`)
    );
    const { evals: secondPass } = seedEvaluations([turn], existingKeys);
    expect(secondPass).toHaveLength(0);
  });

  it('pipeline produces stable OTel records for same input (determinism)', () => {
    const turn = makeTurn({ sessionId: 'stable-test', timestamp: '2026-02-25T00:30:00.000Z' });

    const { evals: run1 } = seedEvaluations([turn], new Set());
    const { evals: run2 } = seedEvaluations([turn], new Set());

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].scoreValue).toBe(run2[i].scoreValue);
      expect(run1[i].evaluationName).toBe(run2[i].evaluationName);
    }
  });
});

// ---------------------------------------------------------------------------
// Full pipeline integration: derive → write → read → judge → write
// ---------------------------------------------------------------------------

describe('full pipeline: derive + judge write/read cycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `full-pipeline-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    sessionTasks.clear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('derive output + seed output combine into valid JSONL for backend ingestion', () => {
    // Step 1: Derive rule-based evaluations from trace spans
    trackTaskActivity(makeTraceSpan({
      attributes: {
        'session.id': 'full-pipeline-session',
        'builtin.tool': 'TaskCreate',
        'builtin.task_status': 'pending',
        'builtin.task_id': 'task-full',
      },
    }));
    trackTaskActivity(makeTraceSpan({
      spanId: 'span-002',
      attributes: {
        'session.id': 'full-pipeline-session',
        'builtin.tool': 'TaskUpdate',
        'builtin.task_status': 'completed',
        'builtin.task_id': 'task-full',
      },
    }));
    const deriveEvals = deriveTaskCompletionPerSession();
    expect(deriveEvals).toHaveLength(1);

    // Step 2: Seed judge evaluations for a turn from the same session
    const turns = [
      makeTurn({
        sessionId: 'full-pipeline-session',
        traceId: 'trace-pipeline-001',
        timestamp: '2026-02-25T00:00:00.000Z',
        toolResults: ['tool output here'],
      }),
    ];
    const { evals: judgeEvals } = seedEvaluations(turns, new Set());
    expect(judgeEvals.length).toBeGreaterThan(0);

    // Step 3: Combine and write to JSONL (as populate-dashboard.ts would do)
    const allEvals: (DeriveEvalRecord | JudgeEvalRecord)[] = [...deriveEvals, ...judgeEvals];
    const outFile = join(tmpDir, 'evaluations-2026-02-25.jsonl');
    const content = allEvals.map(ev => JSON.stringify(toOTelRecord(ev))).join('\n') + '\n';
    writeFileSync(outFile, content);

    // Step 4: Validate the combined output is valid JSONL
    const records = parseJsonl(readFileSync(outFile, 'utf-8'));
    expect(records.length).toBe(allEvals.length);

    // All records must have the standard OTel evaluation shape
    for (const record of records) {
      expect(record.name).toBe('gen_ai.evaluation.result');
      const attrs = record.attributes as Record<string, unknown>;
      expect(typeof attrs['gen_ai.evaluation.name']).toBe('string');
      expect(typeof attrs['gen_ai.evaluation.score.value']).toBe('number');
      const score = attrs['gen_ai.evaluation.score.value'] as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }

    // Verify rule-based eval is in the combined output
    const taskCompletionRecords = records.filter(r => {
      const attrs = r.attributes as Record<string, unknown>;
      return attrs['gen_ai.evaluation.name'] === 'task_completion';
    });
    expect(taskCompletionRecords).toHaveLength(1);
    const tcAttrs = taskCompletionRecords[0].attributes as Record<string, unknown>;
    expect(tcAttrs['gen_ai.evaluation.score.value']).toBe(1.0);

    // Verify LLM judge evals are in the combined output
    const llmEvalNames = ['relevance', 'coherence', 'faithfulness', 'hallucination', 'tool_correctness'];
    for (const name of llmEvalNames) {
      const found = records.some(r => {
        const attrs = r.attributes as Record<string, unknown>;
        return attrs['gen_ai.evaluation.name'] === name;
      });
      expect(found).toBe(true);
    }
  });
});
