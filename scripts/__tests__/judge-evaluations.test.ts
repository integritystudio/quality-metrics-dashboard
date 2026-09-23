import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSystemPrompt,
  isToolResultOnly,
  extractTextFromContent,
  extractToolResults,
  extractTurns,
  hashToScore,
  normalizeScore,
  isCanaryTurn,
  seedEvaluations,
  evaluateTurn,
  evaluateTurnsBatched,
  evalFailures,
  toOTelRecord,
  processBatch,
  fitContextForJudge,
  CONTEXT_TRUNCATION_MARKER,
  MAX_TOOL_CONTEXT_ITEMS,
  classifyJudgeFailure,
  summarizeJudgeRun,
  resetFailureTracking,
  createUsageTotals,
  recordUsage,
  usageCostUsd,
  judgePricing,
  estimateJudgeRun,
  EST_OUTPUT_TOKENS_PER_EVAL,
  EVAL_SCORE_PRECISION,
  CACHE_READ_INPUT_PRICE_RATIO,
  CACHE_CREATION_INPUT_PRICE_RATIO,
  BATCH_PRICE_RATIO,
  readRunState,
  writeRunState,
  type JudgeSpend,
  type JudgeUsageTotals,
  anthropicProviderFor,
  JUDGE_MAX_TOKENS,
  type JudgeMessagesClient,
  type JudgeFailureClass,
  type TranscriptInfo,
  type Turn,
  type EvalRecord,
} from '../judge-evaluations.js';
import { LLMJudge } from '../../../src/lib/judge/llm-judge-config.js';
import type { LLMProvider } from '../../../src/lib/judge/llm-as-judge.js';
import type { BatchLLMProvider } from '../judge-batch-provider.js';
import { MAX_TEXT_LENGTH } from '../../../src/lib/judge/llm-judge-constants.js';
import { JUDGE_EXIT_BILLING, JUDGE_EXIT_NO_SCORES, JUDGE_EXIT_HIGH_FAILURE_RATE } from '../pipeline-stages.js';
import { JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV } from '../judge-credentials.js';
import { TOKENS_PER_MILLION, type ModelPricingEntry } from '../../../src/lib/core/constants-models.js';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-02-09T01:11:15.525Z',
    userText: 'Fix the login bug',
    assistantText: 'I found the issue in auth.ts and fixed it.',
    toolResults: [],
    ...overrides,
  };
}

function makeEvalRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    timestamp: '2026-02-09T01:11:15.525Z',
    evaluationName: 'relevance',
    scoreValue: 0.85,
    explanation: 'Test explanation',
    evaluator: 'dashboard:judge-evaluations',
    evaluatorType: 'llm',
    evaluatorKind: 'llm',
    cohort: 'normal',
    judgeModel: 'claude-haiku-4-5-20251001',
    traceId: 'trace-001',
    sessionId: 'abc12345-session',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSystemPrompt
// ---------------------------------------------------------------------------

describe('isSystemPrompt', () => {
  it('detects system-reminder tags', () => {
    expect(isSystemPrompt('<system-reminder>some content</system-reminder>')).toBe(true);
  });

  it('detects system-reminder with leading whitespace', () => {
    expect(isSystemPrompt('  <system-reminder>content')).toBe(true);
  });

  it('detects stop hook feedback', () => {
    expect(isSystemPrompt('Stop hook feedback: some message')).toBe(true);
  });

  it('returns false for regular user text', () => {
    expect(isSystemPrompt('Fix the login bug')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSystemPrompt('')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(isSystemPrompt(42 as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isToolResultOnly
// ---------------------------------------------------------------------------

describe('isToolResultOnly', () => {
  it('returns true for array of tool_result blocks', () => {
    expect(isToolResultOnly([
      { type: 'tool_result', content: 'result' },
    ])).toBe(true);
  });

  it('returns true for multiple tool_result blocks', () => {
    expect(isToolResultOnly([
      { type: 'tool_result', content: 'a' },
      { type: 'tool_result', content: 'b' },
    ])).toBe(true);
  });

  it('returns false when mixed with text blocks', () => {
    expect(isToolResultOnly([
      { type: 'text', text: 'hello' },
      { type: 'tool_result', content: 'result' },
    ])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isToolResultOnly([])).toBe(false);
  });

  it('returns false for non-array input', () => {
    expect(isToolResultOnly('string')).toBe(false);
    expect(isToolResultOnly(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTextFromContent
// ---------------------------------------------------------------------------

describe('extractTextFromContent', () => {
  it('extracts text from string content', () => {
    expect(extractTextFromContent('hello world')).toBe('hello world');
  });

  it('extracts text from content block array', () => {
    const content = [
      { type: 'text', text: 'First part.' },
      { type: 'text', text: 'Second part.' },
    ];
    expect(extractTextFromContent(content)).toBe('First part.\nSecond part.');
  });

  it('filters out non-text blocks', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: '123', name: 'Read' },
      { type: 'tool_result', content: 'file contents' },
    ];
    expect(extractTextFromContent(content)).toBe('Hello');
  });

  it('returns empty string for non-string non-array', () => {
    expect(extractTextFromContent(null)).toBe('');
    expect(extractTextFromContent(42)).toBe('');
    expect(extractTextFromContent(undefined)).toBe('');
  });

  it('handles blocks with missing text field', () => {
    const content = [{ type: 'text' }];
    expect(extractTextFromContent(content)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractToolResults
// ---------------------------------------------------------------------------

describe('extractToolResults', () => {
  it('extracts string content from tool_result blocks', () => {
    const content = [
      { type: 'tool_result', content: 'File contents here' },
    ];
    expect(extractToolResults(content)).toEqual(['File contents here']);
  });

  it('extracts nested text blocks from tool_result', () => {
    const content = [
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      },
    ];
    expect(extractToolResults(content)).toEqual(['Line 1\nLine 2']);
  });

  it('filters out non-tool_result blocks', () => {
    const content = [
      { type: 'text', text: 'Not a tool result' },
      { type: 'tool_result', content: 'Actual result' },
    ];
    expect(extractToolResults(content)).toEqual(['Actual result']);
  });

  it('returns empty array for non-array input', () => {
    expect(extractToolResults(null)).toEqual([]);
    expect(extractToolResults('string')).toEqual([]);
  });

  it('filters out empty tool results', () => {
    const content = [
      { type: 'tool_result', content: '' },
      { type: 'tool_result', content: 'valid' },
    ];
    expect(extractToolResults(content)).toEqual(['valid']);
  });
});

// ---------------------------------------------------------------------------
// extractTurns
// ---------------------------------------------------------------------------

describe('extractTurns', () => {
  let tmpDir: string;

  function writeTranscript(lines: object[]): string {
    const dir = join(tmpDir, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, 'test-session.jsonl');
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    writeFileSync(filepath, content);
    return filepath;
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `judge-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts user/assistant turn pairs', async () => {
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I fixed it in auth.ts' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
    ]);

    const info: TranscriptInfo = { path: filepath, sessionId: 'sess-1', traceId: 'trace-1' };
    const turns = await extractTurns(info);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('Fix the bug');
    expect(turns[0]!.assistantText).toBe('I fixed it in auth.ts');
    expect(turns[0]!.sessionId).toBe('sess-1');
  });

  it('skips system prompts', async () => {
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>hook info</system-reminder>' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns).toHaveLength(0);
  });

  it('skips tool-result-only user messages', async () => {
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'result data' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns).toHaveLength(0);
  });

  it('accumulates tool results from preceding messages', async () => {
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output 1' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Now fix the tests' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:10Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Tests fixed' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:15Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolResults).toContain('tool output 1');
  });

  it('clears tool results between turns (M4)', async () => {
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output from turn 1' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'First question' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:10Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Second question' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:15Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:20Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns).toHaveLength(2);
    expect(turns[0]!.toolResults).toContain('tool output from turn 1');
    expect(turns[1]!.toolResults).toHaveLength(0); // Should not leak from turn 1
  });

  it('skips progress and file-history-snapshot entries', async () => {
    const filepath = writeTranscript([
      { type: 'progress', message: null },
      { type: 'file-history-snapshot', files: {} },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns).toHaveLength(1);
  });

  it('truncates long text to MAX_TURN_TEXT_LEN', async () => {
    const longText = 'x'.repeat(10000);
    const filepath = writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:00Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
        sessionId: 'sess-1',
        timestamp: '2026-02-09T01:00:05Z',
      },
    ]);

    const turns = await extractTurns({ path: filepath, sessionId: 'sess-1', traceId: 'trace-1' });
    expect(turns[0]!.userText.length).toBe(8000);
    expect(turns[0]!.assistantText.length).toBe(8000);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const dir = join(tmpDir, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, 'bad.jsonl');
    writeFileSync(filepath, 'not json\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"sessionId":"s","timestamp":"2026-02-09T01:00:00Z"}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]},"sessionId":"s","timestamp":"2026-02-09T01:00:05Z"}\n');

    const turns = await extractTurns({ path: filepath, sessionId: 's', traceId: 't' });
    expect(turns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeScore
// ---------------------------------------------------------------------------

describe('normalizeScore', () => {
  it('rounds to 4 decimal places', () => {
    expect(normalizeScore(0.123456789)).toBe(0.1235);
  });

  it('preserves exact values', () => {
    expect(normalizeScore(0.85)).toBe(0.85);
  });

  it('handles 0 and 1', () => {
    expect(normalizeScore(0)).toBe(0);
    expect(normalizeScore(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hashToScore
// ---------------------------------------------------------------------------

describe('hashToScore', () => {
  it('returns deterministic scores for same input', () => {
    const score1 = hashToScore('test:abc', 0.5, 1.0);
    const score2 = hashToScore('test:abc', 0.5, 1.0);
    expect(score1).toBe(score2);
  });

  it('returns different scores for different inputs', () => {
    const score1 = hashToScore('test:abc', 0.5, 1.0);
    const score2 = hashToScore('test:def', 0.5, 1.0);
    expect(score1).not.toBe(score2);
  });

  it('returns scores within specified range', () => {
    for (let i = 0; i < 100; i++) {
      const score = hashToScore(`input-${i}`, 0.3, 0.9);
      expect(score).toBeGreaterThanOrEqual(0.3);
      expect(score).toBeLessThanOrEqual(0.9);
    }
  });

  it('returns 4 decimal precision', () => {
    const score = hashToScore('test', 0.0, 1.0);
    const decimals = score.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// seedEvaluations
// ---------------------------------------------------------------------------

describe('seedEvaluations', () => {
  it('generates relevance and coherence for all turns', () => {
    const turns = [makeTurn()];
    const { evals } = seedEvaluations(turns, new Set());

    const names = evals.map(e => e.evaluationName);
    expect(names).toContain('relevance');
    expect(names).toContain('coherence');
  });

  it('generates faithfulness, hallucination, and tool_correctness in seed mode', () => {
    const turnNoTools = makeTurn({ toolResults: [] });
    const turnWithTools = makeTurn({ toolResults: ['some tool output'] });

    const { evals: evalsNoTools } = seedEvaluations([turnNoTools], new Set());
    const { evals: evalsWithTools } = seedEvaluations([turnWithTools], new Set());

    expect(evalsNoTools.map(e => e.evaluationName)).toContain('faithfulness');
    expect(evalsNoTools.map(e => e.evaluationName)).toContain('hallucination');
    // tool_correctness only generated when tool results exist
    expect(evalsNoTools.map(e => e.evaluationName)).not.toContain('tool_correctness');
    expect(evalsWithTools.map(e => e.evaluationName)).toContain('faithfulness');
    expect(evalsWithTools.map(e => e.evaluationName)).toContain('hallucination');
    expect(evalsWithTools.map(e => e.evaluationName)).toContain('tool_correctness');
  });

  it('skips evaluations that exist in the dedup set', () => {
    const turn = makeTurn();
    const turnKey = turn.timestamp.slice(0, 19);
    const existingKeys = new Set([
      `${turn.sessionId}:relevance:${turnKey}`,
      `${turn.sessionId}:coherence:${turnKey}`,
      `${turn.sessionId}:faithfulness:${turnKey}`,
      `${turn.sessionId}:hallucination:${turnKey}`,
    ]);

    const { evals } = seedEvaluations([turn], existingKeys);
    expect(evals).toHaveLength(0);
  });

  it('hallucination + faithfulness scores are complementary', () => {
    const turn = makeTurn();
    const { evals } = seedEvaluations([turn], new Set());

    const faith = evals.find(e => e.evaluationName === 'faithfulness')!;
    const hal = evals.find(e => e.evaluationName === 'hallucination')!;
    expect(faith.scoreValue + hal.scoreValue).toBeCloseTo(1.0, 3);
  });

  // OBP16: this used to assert the inverse of the correct behaviour — that a
  // canary record carries evaluator 'llm'. Both branches hash, so neither may
  // claim an LLM produced the score; the cohort is what tells them apart.
  it('marks seed evals by cohort, and never claims an llm produced them', () => {
    const { evals } = seedEvaluations([makeTurn({ toolResults: ['ctx'] })], new Set());
    expect(evals.length).toBeGreaterThan(0);
    for (const ev of evals) {
      expect(['seed', 'canary']).toContain(ev.cohort);
      expect(ev.evaluatorKind).toBe('rule');
      expect(ev.evaluator).toBe('dashboard:judge-evaluations');
      expect(ev.judgeModel).toBeUndefined();
    }
  });

  it('non-canary scores are within expected ranges', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      makeTurn({
        sessionId: `session-${i}`,
        timestamp: `2026-02-09T01:${String(i).padStart(2, '0')}:00.000Z`,
        toolResults: ['ctx'],
      })
    );
    const { evals } = seedEvaluations(turns, new Set());

    for (const ev of evals) {
      const turnKey = ev.timestamp.slice(0, 19);
      if (isCanaryTurn(ev.sessionId, turnKey)) continue; // canaries have different ranges

      if (ev.evaluationName === 'relevance') {
        expect(ev.scoreValue).toBeGreaterThanOrEqual(0.70);
        expect(ev.scoreValue).toBeLessThanOrEqual(1.0);
      }
      if (ev.evaluationName === 'coherence') {
        expect(ev.scoreValue).toBeGreaterThanOrEqual(0.75);
        expect(ev.scoreValue).toBeLessThanOrEqual(1.0);
      }
      if (ev.evaluationName === 'hallucination') {
        expect(ev.scoreValue).toBeGreaterThanOrEqual(0.0);
        expect(ev.scoreValue).toBeLessThanOrEqual(0.09);
      }
    }
  });

  it('backfill: partial existingKeys (only hallucination) still seeds missing metrics (H1)', () => {
    const turn = makeTurn();
    const turnKey = turn.timestamp.slice(0, 19);
    // Only hallucination is already covered — relevance/coherence/faithfulness are missing
    const existingKeys = new Set([`${turn.sessionId}:hallucination:${turnKey}`]);

    const { evals } = seedEvaluations([turn], existingKeys);
    const names = evals.map(e => e.evaluationName);
    expect(names).toContain('relevance');
    expect(names).toContain('coherence');
    expect(names).toContain('faithfulness');
    expect(names).not.toContain('hallucination');
  });

  it('backfill idempotency: second run with all keys emits nothing (H1)', () => {
    const turn = makeTurn();
    const turnKey = turn.timestamp.slice(0, 19);
    const SEED_METRICS = ['relevance', 'coherence', 'faithfulness', 'hallucination'] as const;
    const existingKeys = new Set(SEED_METRICS.map(m => `${turn.sessionId}:${m}:${turnKey}`));

    const { evals } = seedEvaluations([turn], existingKeys);
    expect(evals).toHaveLength(0);
  });

  it('canary turns get intentionally low scores (B6)', () => {
    // Generate enough turns to likely hit a canary (~2% rate)
    const turns = Array.from({ length: 200 }, (_, i) =>
      makeTurn({
        sessionId: `canary-test-${i}`,
        timestamp: `2026-02-09T01:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}.000Z`,
        toolResults: ['ctx'],
      })
    );
    const { evals } = seedEvaluations(turns, new Set());
    const canaryEvals = evals.filter(e => e.explanation.includes('(canary)'));

    expect(canaryEvals.length).toBeGreaterThan(0);
    for (const ev of canaryEvals) {
      if (ev.evaluationName === 'relevance') {
        expect(ev.scoreValue).toBeLessThanOrEqual(0.35);
      }
      if (ev.evaluationName === 'hallucination') {
        expect(ev.scoreValue).toBeGreaterThanOrEqual(0.50);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// toOTelRecord
// ---------------------------------------------------------------------------

describe('toOTelRecord', () => {
  it('produces correct OTel flat evaluation format', () => {
    const record = toOTelRecord(makeEvalRecord()) as Record<string, unknown>;

    expect(record.name).toBe('gen_ai.evaluation.result');
    expect(record.timestamp).toBe('2026-02-09T01:11:15.525Z');
    expect(record.traceId).toBe('trace-001');

    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['gen_ai.evaluation.name']).toBe('relevance');
    expect(attrs['gen_ai.evaluation.score.value']).toBe(0.85);
    expect(attrs['gen_ai.evaluation.explanation']).toBe('Test explanation');
    expect(attrs['integritystudio.evaluation.producer']).toBe('dashboard:judge-evaluations');
    expect(attrs['integritystudio.evaluation.evaluator.kind']).toBe('llm');
    expect(attrs['integritystudio.evaluation.cohort']).toBe('normal');
    expect(attrs['integritystudio.evaluation.judge.model']).toBe('claude-haiku-4-5-20251001');
    expect(attrs['session.id']).toBe('abc12345-session');
  });

  it('omits session.id when empty', () => {
    const record = toOTelRecord(makeEvalRecord({ sessionId: '' })) as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['session.id']).toBeUndefined();
  });

  // OBP16: neither key is in the semconv registry, so both were local fields
  // squatting under an OpenTelemetry-owned namespace (AA3 Gate 1c).
  it('no longer writes the two overloaded gen_ai evaluator keys', () => {
    const record = toOTelRecord(makeEvalRecord()) as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['gen_ai.evaluation.evaluator.type']).toBeUndefined();
    expect(attrs['gen_ai.evaluation.evaluator']).toBeUndefined();
    expect(attrs['gen_ai.evaluation.evaluator_type']).toBeUndefined();
  });

  it('omits the judge model for a score no model produced', () => {
    const canary = makeEvalRecord({ cohort: 'canary', evaluatorKind: 'rule', judgeModel: undefined });
    const record = toOTelRecord(canary) as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['integritystudio.evaluation.cohort']).toBe('canary');
    expect(attrs['integritystudio.evaluation.judge.model']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// processBatch
// ---------------------------------------------------------------------------

describe('processBatch', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await processBatch(items, 2, 0, (n) => Promise.resolve(n * 2));
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('handles empty array', async () => {
    const results = await processBatch([], 3, 0, (n: number) => Promise.resolve(n));
    expect(results).toEqual([]);
  });

  it('continues on individual failures', async () => {
    const items = [1, 2, 3];
    const results = await processBatch(items, 3, 0, (n) => {
      if (n === 2) throw new Error('fail');
      return Promise.resolve(n);
    });
    expect(results).toEqual([1, 3]);
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await processBatch(items, 2, 0, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return n;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// evaluateTurn (B14)
// ---------------------------------------------------------------------------

// G-Eval makes 2 calls: (1) step generation, (2) evaluation scoring (1-5 scale).
// QAG makes 2 calls: (1) statement extraction (JSON array), (2) verdict per statement.
const MOCK_GEVAL_STEPS = '1. Check quality\n2. Assess completeness\n3. Verify accuracy';

function mockResponse(prompt: string, gEvalScore = 4): { text: string } {
  if (prompt.includes('Generate detailed')) {
    return { text: MOCK_GEVAL_STEPS };
  }
  if (prompt.includes('statements') || prompt.includes('claims')) {
    return { text: JSON.stringify(['The response is correct.']) };
  }
  if (prompt.includes('verdict') || prompt.includes('supported')) {
    return { text: 'yes' };
  }
  return { text: String(gEvalScore) };
}

function createMockLLM(gEvalScore = 4): LLMProvider {
  return {
    generate(prompt: string) {
      return Promise.resolve(mockResponse(prompt, gEvalScore));
    },
  };
}

function createFailingLLM(failKeyword: string): LLMProvider {
  return {
    generate(prompt: string) {
      if (prompt.toLowerCase().includes(failKeyword.toLowerCase())) {
        return Promise.reject(new Error(`Mock ${failKeyword} failure`));
      }
      return Promise.resolve(mockResponse(prompt));
    },
  };
}

describe('evaluateTurn', () => {
  beforeEach(() => {
    // Reset failure tracking
    for (const key of Object.keys(evalFailures)) delete evalFailures[key];
  });

  it('evaluates relevance and coherence for turns without tool results', async () => {
    const llm = createMockLLM(4);
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: [] });

    const evals = await evaluateTurn(judge, turn, new Set());

    const names = evals.map(e => e.evaluationName);
    expect(names).toContain('relevance');
    expect(names).toContain('coherence');
    expect(names).not.toContain('faithfulness');
    expect(names).not.toContain('hallucination');
    expect(names).not.toContain('tool_correctness');
  });

  it('evaluates all 5 metrics for turns with tool results', async () => {
    const llm = createMockLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: ['file contents here'] });

    const evals = await evaluateTurn(judge, turn, new Set());

    const names = evals.map(e => e.evaluationName);
    expect(names).toContain('relevance');
    expect(names).toContain('coherence');
    expect(names).toContain('faithfulness');
    expect(names).toContain('hallucination');
    expect(names).toContain('tool_correctness');
  });

  it('skips already-evaluated metrics via existingKeys', async () => {
    const llm = createMockLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn();
    const turnKey = turn.timestamp.slice(0, 19);
    const existingKeys = new Set([
      `${turn.sessionId}:relevance:${turnKey}`,
      `${turn.sessionId}:coherence:${turnKey}`,
    ]);

    const evals = await evaluateTurn(judge, turn, existingKeys);
    expect(evals).toHaveLength(0);
  });

  it('tracks failures in evalFailures on metric error', async () => {
    // Use "evaluating: relevance" to only match relevance prompts —
    // "relevant" also appears in the shared score anchoring text
    // ("irrelevant") which would cause coherence to also fail.
    const llm = createFailingLLM('evaluating: relevance');
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: [] });

    const evals = await evaluateTurn(judge, turn, new Set());

    // Relevance should fail, coherence should succeed
    expect(evalFailures['relevance']).toBe(1);
    expect(evals.some(e => e.evaluationName === 'coherence')).toBe(true);
  });

  it('sets evaluatorKind to llm for all judged results', async () => {
    const llm = createMockLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: ['ctx'] });

    const evals = await evaluateTurn(judge, turn, new Set());
    for (const ev of evals) {
      expect(ev.evaluatorKind).toBe('llm');
      expect(ev.cohort).toBe('normal');
    }
  });
});

describe('evaluateTurn faithfulness and hallucination', () => {
  beforeEach(() => {
    for (const key of Object.keys(evalFailures)) delete evalFailures[key];
  });

  /**
   * A QAG sweep over four statements: two the context supports, one it contradicts
   * and one it cannot settle. The counts are deliberately unequal — with an even
   * split the two modes score the same and a test could not tell a mode-mapping
   * bug from correct behaviour. Counts only the sweep's own calls so the
   * surrounding G-Eval criteria do not pollute the total.
   */
  function createQagLLM(): { llm: LLMProvider; sweepCalls: () => number } {
    const answers = ['yes', 'yes', 'no', 'maybe'];
    let answerIndex = 0;
    let sweepCalls = 0;
    const llm: LLMProvider = {
      generate(prompt: string) {
        if (prompt.includes('Extract all factual claims')) {
          sweepCalls++;
          return Promise.resolve({ text: JSON.stringify(['A', 'B', 'C', 'D']) });
        }
        if (prompt.includes('yes/no question')) {
          sweepCalls++;
          return Promise.resolve({ text: 'Is it so?' });
        }
        if (prompt.includes('answer the question with')) {
          sweepCalls++;
          return Promise.resolve({ text: answers[answerIndex++] ?? 'maybe' });
        }
        return Promise.resolve(mockResponse(prompt));
      },
    };
    return { llm, sweepCalls: () => sweepCalls };
  }

  it('scores both from a single sweep, and hallucination is not 1 - faithfulness', async () => {
    const { llm, sweepCalls } = createQagLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });

    const evals = await evaluateTurn(judge, makeTurn({ toolResults: ['tool output'] }), new Set());

    const byName = new Map(evals.map(e => [e.evaluationName, e.scoreValue]));
    // 2 of 4 supported, 1 of 4 contradicted, 1 inconclusive and counted by neither.
    // The two differ, so writing one mode's score under both names fails here.
    expect(byName.get('faithfulness')).toBeCloseTo(0.5);
    expect(byName.get('hallucination')).toBeCloseTo(0.25);
    // 1 extraction + 4 questions + 4 answers. A second sweep would make it 18.
    expect(sweepCalls()).toBe(9);
  });

  it('runs the sweep only for the metric that is missing', async () => {
    const { llm, sweepCalls } = createQagLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: ['tool output'] });
    const turnKey = turn.timestamp.slice(0, 19);

    const evals = await evaluateTurn(judge, turn, new Set([`${turn.sessionId}:faithfulness:${turnKey}`]));

    const names = evals.map(e => e.evaluationName);
    expect(names).toContain('hallucination');
    expect(names).not.toContain('faithfulness');
    // The score is the fabrication tally, not the faithfulness one it sits beside.
    expect(evals.find(e => e.evaluationName === 'hallucination')?.scoreValue).toBeCloseTo(0.25);
    expect(sweepCalls()).toBe(9);
  });

  it('counts a failed sweep against every metric that asked for it', async () => {
    const llm = createFailingLLM('Convert this statement');
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });

    const evals = await evaluateTurn(judge, makeTurn({ toolResults: ['tool output'] }), new Set());

    // One shared failure, two metrics missing — recording it once would leave the
    // hallucination series looking merely absent rather than failed.
    expect(evalFailures['faithfulness']).toBe(1);
    expect(evalFailures['hallucination']).toBe(1);
    expect(evals.map(e => e.evaluationName)).not.toContain('hallucination');
  });
});

describe('fitContextForJudge', () => {
  it('leaves items within the cap untouched', () => {
    const items = ['a', 'b'.repeat(MAX_TEXT_LENGTH)];

    expect(fitContextForJudge(items)).toEqual(items);
  });

  it('truncates an oversized item to exactly the cap and marks the cut', () => {
    const [fitted] = fitContextForJudge(['x'.repeat(MAX_TEXT_LENGTH + 1)]);

    expect(fitted).toHaveLength(MAX_TEXT_LENGTH);
    expect(fitted!.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  it('keeps at most the tool-context item limit', () => {
    const many = Array.from({ length: MAX_TOOL_CONTEXT_ITEMS + 5 }, (_, i) => `result ${i}`);

    expect(fitContextForJudge(many)).toHaveLength(MAX_TOOL_CONTEXT_ITEMS);
  });
});

describe('evaluateTurn with an oversized tool result', () => {
  it('evaluates every metric instead of failing schema validation (60 of 480 failures per run before)', async () => {
    resetFailureTracking();
    const llm = createMockLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: ['x'.repeat(MAX_TEXT_LENGTH + 500)] });

    const evals = await evaluateTurn(judge, turn, new Set());

    expect(evals.map(e => e.evaluationName)).toEqual(expect.arrayContaining(['faithfulness', 'tool_correctness']));
    expect(evalFailures).toEqual({});
  });
});

describe('classifyJudgeFailure', () => {
  it.each<[JudgeFailureClass, string]>([
    ['billing', '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
    // A QAG sweep reports its own summary; the provider's text has to survive
    // inside it, or a billing refusal mid-sweep is counted as `other` and the
    // run-level escalation never fires.
    ['billing', 'QAG evaluation failed: no verification questions generated (400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}})'],
    ['network', 'Connection error.'],
    ['network', 'getaddrinfo ENOTFOUND api.anthropic.com'],
    ['schema-rejection', '400 {"type":"error","error":{"type":"invalid_request_error","message":"output_config.format.schema is invalid: minimum is not a supported keyword"}}'],
    ['schema-rejection', 'Request failed: output_config validation failed'],
    ['parse', 'Generated evaluation steps below minimum (got 0, require 3)'],
    ['parse', "Unexpected token '`', \"```json\" is not valid JSON"],
    ['invalid-input', 'Invalid TestCase: [ { "code": "too_big" } ]'],
    ['other', 'something nobody anticipated'],
  ])('classifies as %s: %s', (expected, message) => {
    expect(classifyJudgeFailure(message)).toBe(expected);
  });

  it('does not classify billing errors as schema-rejection even if they share keywords', () => {
    // billing wins because BILLING_FAILURE_PATTERN is checked first
    expect(classifyJudgeFailure('credit balance is too low; output_config ignored')).toBe('billing');
  });
});

describe('summarizeJudgeRun', () => {
  const noFailures: Record<JudgeFailureClass, number> = { billing: 0, network: 0, 'schema-rejection': 0, parse: 0, 'invalid-input': 0, other: 0 };
  const noSpend: JudgeSpend = { usage: createUsageTotals(), estimatedUsd: 0, keySource: DEFAULT_API_KEY_ENV };

  it('exits 0 with a one-line summary when scores were produced', () => {
    // 200 successes, 40 failures = 17% failure rate — well below the 50% threshold
    const summary = summarizeJudgeRun(200, { coherence: 40 }, { ...noFailures, parse: 40 }, noSpend);

    expect(summary.exitCode).toBe(0);
    expect(summary.attempted).toBe(240);
    expect(summary.line).toContain('attempted=240 succeeded=200 failed=40');
    expect(summary.line).toContain('parse=40');
  });

  it('exits JUDGE_EXIT_NO_SCORES when evaluations were attempted and none succeeded', () => {
    const summary = summarizeJudgeRun(0, { coherence: 100, relevance: 100 }, { ...noFailures, parse: 200 }, noSpend);

    expect(summary.exitCode).toBe(JUDGE_EXIT_NO_SCORES);
    expect(summary.line).toMatch(/NO SCORES PRODUCED/);
  });

  it('exits JUDGE_EXIT_BILLING when any call was refused for billing, even if others scored', () => {
    const summary = summarizeJudgeRun(3, { coherence: 10 }, { ...noFailures, billing: 10 }, noSpend);

    expect(summary.exitCode).toBe(JUDGE_EXIT_BILLING);
    expect(summary.line).toMatch(/BILLING REFUSED/);
  });

  it('exits JUDGE_EXIT_HIGH_FAILURE_RATE when more than half the attempts fail', () => {
    // 46 succeeded, 490 failed = 91.4% failure — the 09-22 collapse
    const summary = summarizeJudgeRun(46, { coherence: 490 }, { ...noFailures, 'schema-rejection': 490 }, noSpend);

    expect(summary.exitCode).toBe(JUDGE_EXIT_HIGH_FAILURE_RATE);
    expect(summary.line).toMatch(/HIGH FAILURE RATE/);
    expect(summary.line).toContain('490 of 536');
  });

  it('exits JUDGE_EXIT_HIGH_FAILURE_RATE exactly at the 50% threshold', () => {
    // 99 fail, 100 succeed → 49.7% failure rate → no alarm
    expect(summarizeJudgeRun(100, { coherence: 99 }, noFailures, noSpend).exitCode).toBe(0);
    // 101 fail, 100 succeed → 50.25% failure rate → alarm
    expect(summarizeJudgeRun(100, { coherence: 101 }, noFailures, noSpend).exitCode).toBe(JUDGE_EXIT_HIGH_FAILURE_RATE);
  });

  it('JUDGE_EXIT_NO_SCORES wins over JUDGE_EXIT_HIGH_FAILURE_RATE at 100% failure', () => {
    // 100% failure is the no-scores condition, checked before the rate check
    const summary = summarizeJudgeRun(0, { coherence: 100 }, noFailures, noSpend);
    expect(summary.exitCode).toBe(JUDGE_EXIT_NO_SCORES);
  });

  it('exits JUDGE_EXIT_HIGH_FAILURE_RATE when succeeded drops by more than half versus previous run', () => {
    // previous run: 420 succeeded; this run: 200 succeeded (52% drop)
    const summary = summarizeJudgeRun(200, {}, noFailures, noSpend, 420);

    expect(summary.exitCode).toBe(JUDGE_EXIT_HIGH_FAILURE_RATE);
    expect(summary.line).toMatch(/SCORE DROP/);
    expect(summary.line).toContain('200');
    expect(summary.line).toContain('420');
  });

  it('exits 0 when drop is below the 50% threshold', () => {
    // 210 of 420 is exactly 50% — not strictly less than half, no alarm
    expect(summarizeJudgeRun(210, {}, noFailures, noSpend, 420).exitCode).toBe(0);
  });

  it('skips the drop check when prevSucceeded is below the minimum significant count', () => {
    // previous run had only 5 successes — too small to be meaningful
    expect(summarizeJudgeRun(1, {}, noFailures, noSpend, 5).exitCode).toBe(0);
  });

  it('skips the drop check when prevSucceeded is undefined (first run)', () => {
    expect(summarizeJudgeRun(5, {}, noFailures, noSpend, undefined).exitCode).toBe(0);
  });

  it('high failure rate check takes precedence over drop check', () => {
    // Both conditions would fire; rate check is tested first in code
    const summary = summarizeJudgeRun(10, { coherence: 200 }, noFailures, noSpend, 500);
    expect(summary.exitCode).toBe(JUDGE_EXIT_HIGH_FAILURE_RATE);
    expect(summary.line).toMatch(/HIGH FAILURE RATE/);
  });

  it('exits 0 when nothing was attempted', () => {
    expect(summarizeJudgeRun(0, {}, noFailures, noSpend).exitCode).toBe(0);
  });

  it('carries the usage totals, both cost figures and the key source name on the line', () => {
    const usage: JudgeUsageTotals = {
      input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    };
    const estimatedUsd = 1.8;

    const summary = summarizeJudgeRun(5, {}, noFailures, { usage, estimatedUsd, keySource: JUDGE_API_KEY_ENV });

    const pricing = judgePricing();
    const actualUsd = (usage.input_tokens / TOKENS_PER_MILLION) * pricing.input
      + (usage.output_tokens / TOKENS_PER_MILLION) * pricing.output;
    expect(summary.usage).toEqual(usage);
    expect(summary.estimatedUsd).toBe(estimatedUsd);
    expect(summary.actualUsd).toBeCloseTo(actualUsd);
    expect(summary.keySource).toBe(JUDGE_API_KEY_ENV);
    expect(summary.line).toContain(
      `usage: in=1000000 out=100000 cache_read=0 cache_creation=0 est=$${estimatedUsd.toFixed(EVAL_SCORE_PRECISION)} actual=$${actualUsd.toFixed(EVAL_SCORE_PRECISION)} key=LLM_JUDGE_ANTHROPIC_KEY`,
    );
  });

  it('copies the totals rather than sharing the accumulator', () => {
    const usage = createUsageTotals();
    const summary = summarizeJudgeRun(0, {}, noFailures, { ...noSpend, usage });

    recordUsage(usage, { input_tokens: 1, output_tokens: 1 });

    expect(summary.usage.input_tokens).toBe(0);
  });
});

describe('readRunState / writeRunState', () => {
  // A temp path, never the default: that is the live file the
  // scheduled pipeline's drop check reads.
  let stateDir: string;
  let stateFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'judge-run-state-'));
    stateFile = join(stateDir, 'state.json');
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns undefined when no state file exists', () => {
    expect(readRunState(stateFile)).toBeUndefined();
  });

  it('round-trips a succeeded count through writeRunState / readRunState', () => {
    writeRunState(420, stateFile);
    const state = readRunState(stateFile);
    expect(state?.succeeded).toBe(420);
    expect(state?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns undefined for a corrupt state file without throwing', () => {
    writeFileSync(stateFile, 'not-json', 'utf-8');
    expect(readRunState(stateFile)).toBeUndefined();
  });
});

describe('recordUsage', () => {
  it('sums every response into the totals and treats null cache counts as zero', () => {
    const totals = createUsageTotals();

    recordUsage(totals, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
    recordUsage(totals, { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null });

    expect(totals).toEqual({ input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
  });
});

describe('usageCostUsd', () => {
  const pricing: ModelPricingEntry = { input: 2, output: 10, provider: 'anthropic' };

  it('prices input and output at list rates', () => {
    const totals = { ...createUsageTotals(), input_tokens: TOKENS_PER_MILLION, output_tokens: TOKENS_PER_MILLION };

    expect(usageCostUsd(totals, pricing)).toBeCloseTo(pricing.input + pricing.output);
  });

  it('prices cache reads at a tenth of input and cache writes at their ratio', () => {
    const totals: JudgeUsageTotals = {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: TOKENS_PER_MILLION, cache_creation_input_tokens: TOKENS_PER_MILLION,
    };

    expect(usageCostUsd(totals, pricing)).toBeCloseTo(
      pricing.input * CACHE_READ_INPUT_PRICE_RATIO + pricing.input * CACHE_CREATION_INPUT_PRICE_RATIO,
    );
  });

  it('is zero for a run that made no calls', () => {
    expect(usageCostUsd(createUsageTotals(), pricing)).toBe(0);
  });
});

describe('estimateJudgeRun', () => {
  it('counts two evals for a turn without tools and four for one with', () => {
    // Four, not five: faithfulness and hallucination come from one QAG sweep, so
    // the second score costs nothing to price.
    const est = estimateJudgeRun([makeTurn({ toolResults: [] }), makeTurn({ toolResults: ['file contents'] })]);

    expect(est.evals).toBe(6);
    expect(est.outputTokens).toBe(est.evals * EST_OUTPUT_TOKENS_PER_EVAL);
    expect(est.inputTokens).toBeGreaterThan(0);
  });

  it('prices the estimate at the judge model list rates', () => {
    const est = estimateJudgeRun([makeTurn()]);
    const pricing = judgePricing();

    expect(est.costUsd).toBeCloseTo(
      (est.inputTokens / TOKENS_PER_MILLION) * pricing.input + (est.outputTokens / TOKENS_PER_MILLION) * pricing.output,
    );
  });

  it('is free for no turns', () => {
    expect(estimateJudgeRun([])).toEqual({ evals: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('halves the cost estimate when batch=true', () => {
    const turn = makeTurn();
    const list = estimateJudgeRun([turn], false);
    const batch = estimateJudgeRun([turn], true);

    expect(batch.evals).toBe(list.evals);
    expect(batch.inputTokens).toBe(list.inputTokens);
    expect(batch.outputTokens).toBe(list.outputTokens);
    expect(batch.costUsd).toBeCloseTo(list.costUsd * BATCH_PRICE_RATIO);
  });

  it('applies no discount by default (backward compat)', () => {
    const explicit = estimateJudgeRun([makeTurn()], false);
    const implicit = estimateJudgeRun([makeTurn()]);

    expect(implicit.costUsd).toBeCloseTo(explicit.costUsd);
  });
});

// ---------------------------------------------------------------------------
// anthropicProviderFor (structured score output)
// ---------------------------------------------------------------------------

/** Room for two to three sentences of reasoning plus the score object. */
const STRUCTURED_OUTPUT_MAX_TOKENS_FLOOR = 512;
const SCORE_SCHEMA = {
  type: 'object',
  properties: { reasoning: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['reasoning', 'score'],
  additionalProperties: false,
};

type JudgeCreateParams = Parameters<JudgeMessagesClient['messages']['create']>[0];
type JudgeCreateResponse = Awaited<ReturnType<JudgeMessagesClient['messages']['create']>>;

function makeFakeAnthropicClient(text: string): { client: JudgeMessagesClient; calls: JudgeCreateParams[] } {
  const calls: JudgeCreateParams[] = [];
  const client: JudgeMessagesClient = {
    messages: {
      create(params) {
        calls.push(params);
        const response: JudgeCreateResponse = { content: [{ type: 'text', text, citations: null }] };
        return Promise.resolve(response);
      },
    },
  };
  return { client, calls };
}

describe('anthropicProviderFor', () => {
  it('sends output_config with the json_schema format when a schema is given', async () => {
    const { client, calls } = makeFakeAnthropicClient('{"reasoning": "Clear.", "score": 4}');

    const result = await anthropicProviderFor(client).generate('rate it', { jsonSchema: SCORE_SCHEMA });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.output_config).toEqual({ format: { type: 'json_schema', schema: SCORE_SCHEMA } });
    expect(calls[0]?.max_tokens).toBe(JUDGE_MAX_TOKENS);
    expect(result).toEqual({ text: '{"reasoning": "Clear.", "score": 4}' });
  });

  it('omits output_config when no schema is given', async () => {
    const { client, calls } = makeFakeAnthropicClient('Score: 4');

    await anthropicProviderFor(client).generate('rate it');

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('output_config');
  });

  it('keeps max_tokens high enough for the reasoning and the score', () => {
    expect(JUDGE_MAX_TOKENS).toBeGreaterThanOrEqual(STRUCTURED_OUTPUT_MAX_TOKENS_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// evaluateTurn concurrent mode + evaluateTurnsBatched (--batch wiring)
// ---------------------------------------------------------------------------

/** Long enough for gEval's dynamic import and promise chain to reach the provider. */
const SETTLE_MS = 20;
const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

/** A provider that answers nothing until asked, so in-flight calls can be counted. */
function createDeferredLLM() {
  const waiting: Array<{ prompt: string; resolve: (r: { text: string }) => void }> = [];
  const llm: LLMProvider = {
    generate(prompt: string) {
      return new Promise(resolve => waiting.push({ prompt, resolve }));
    },
  };
  const answerAll = () => {
    for (const { prompt, resolve } of waiting.splice(0)) resolve(mockResponse(prompt));
  };
  return { llm, waiting, answerAll };
}

describe('evaluateTurn in concurrent mode', () => {
  it('issues every criterion before any result comes back, unlike the sequential default', async () => {
    const sequential = createDeferredLLM();
    const sequentialRun = evaluateTurn(new LLMJudge(sequential.llm, { timeoutMs: 5000, maxRetries: 0 }), makeTurn({ toolResults: [] }), new Set());
    await settle();
    expect(sequential.waiting).toHaveLength(1);

    const concurrent = createDeferredLLM();
    const concurrentRun = evaluateTurn(new LLMJudge(concurrent.llm, { timeoutMs: 5000, maxRetries: 0 }), makeTurn({ toolResults: [] }), new Set(), { concurrent: true });
    await settle();
    expect(concurrent.waiting).toHaveLength(2); // relevance and coherence, both at their first call

    // Each answered round lets the next call out; both runs are done once a round leaves nothing waiting.
    do {
      sequential.answerAll();
      concurrent.answerAll();
      await settle();
    } while (sequential.waiting.length + concurrent.waiting.length > 0);
    expect((await concurrentRun).map(e => e.evaluationName).sort()).toEqual(['coherence', 'relevance']);
    expect((await sequentialRun).map(e => e.evaluationName).sort()).toEqual(['coherence', 'relevance']);
  });
});

describe('evaluateTurnsBatched', () => {
  function batchProvider(overrides: Partial<BatchLLMProvider> = {}): BatchLLMProvider {
    const mock = createMockLLM();
    return { generate: (prompt: string) => mock.generate(prompt), flush: vi.fn(() => Promise.resolve()), failure: undefined, ...overrides };
  }

  it('flushes the provider exactly once for a small run and scores every turn', async () => {
    resetFailureTracking();
    const flush = vi.fn(() => Promise.resolve());
    const provider = batchProvider({ flush });
    const judge = new LLMJudge(provider, { timeoutMs: 5000, maxRetries: 0 });
    const turns = [makeTurn({ sessionId: 'batch-1' }), makeTurn({ sessionId: 'batch-2', toolResults: ['ctx'] })];

    const perTurn = await evaluateTurnsBatched(provider, judge, turns, new Set());

    expect(flush).toHaveBeenCalledTimes(1);
    expect(perTurn).toHaveLength(2);
    expect(perTurn[0]!.map(e => e.evaluationName).sort()).toEqual(['coherence', 'relevance']);
    expect(perTurn[1]!.map(e => e.evaluationName)).toEqual(expect.arrayContaining(['faithfulness', 'hallucination', 'tool_correctness']));
    expect(evalFailures).toEqual({});
  });

  it('throws when flush() fails, and when the provider records a failure, instead of returning partial records', async () => {
    const wallClock = new Error('wall clock');
    const judge = (provider: BatchLLMProvider) => new LLMJudge(provider, { timeoutMs: 5000, maxRetries: 0 });

    const failingFlush = batchProvider({ flush: vi.fn(() => Promise.reject(wallClock)) });
    await expect(evaluateTurnsBatched(failingFlush, judge(failingFlush), [makeTurn()], new Set())).rejects.toBe(wallClock);

    const recorded = batchProvider({ failure: wallClock });
    await expect(evaluateTurnsBatched(recorded, judge(recorded), [makeTurn()], new Set())).rejects.toBe(wallClock);
  });
});
