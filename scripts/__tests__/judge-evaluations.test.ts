import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
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
  evalFailures,
  toOTelRecord,
  processBatch,
  type TranscriptInfo,
  type Turn,
  type EvalRecord,
} from '../judge-evaluations.js';
import { LLMJudge } from '../../../src/lib/llm-judge-config.js';
import type { LLMProvider } from '../../../src/lib/llm-as-judge.js';

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
    evaluator: 'llm-judge',
    evaluatorType: 'llm',
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
    expect(turns[0].userText).toBe('Fix the bug');
    expect(turns[0].assistantText).toBe('I fixed it in auth.ts');
    expect(turns[0].sessionId).toBe('sess-1');
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
    expect(turns[0].toolResults).toContain('tool output 1');
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
    expect(turns[0].toolResults).toContain('tool output from turn 1');
    expect(turns[1].toolResults).toHaveLength(0); // Should not leak from turn 1
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
    expect(turns[0].userText.length).toBe(8000);
    expect(turns[0].assistantText.length).toBe(8000);
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

  it('sets evaluatorType to seed or canary for seed evals', () => {
    const { evals } = seedEvaluations([makeTurn({ toolResults: ['ctx'] })], new Set());
    for (const ev of evals) {
      expect(['seed', 'canary']).toContain(ev.evaluatorType);
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
    expect(attrs['gen_ai.evaluation.evaluator']).toBe('llm-judge');
    expect(attrs['gen_ai.evaluation.evaluator.type']).toBe('llm');
    expect(attrs['session.id']).toBe('abc12345-session');
  });

  it('omits session.id when empty', () => {
    const record = toOTelRecord(makeEvalRecord({ sessionId: '' })) as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['session.id']).toBeUndefined();
  });

  it('uses dot notation for evaluator.type (not underscore)', () => {
    const record = toOTelRecord(makeEvalRecord()) as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['gen_ai.evaluation.evaluator.type']).toBeDefined();
    expect(attrs['gen_ai.evaluation.evaluator_type']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// processBatch
// ---------------------------------------------------------------------------

describe('processBatch', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await processBatch(items, 2, 0, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('handles empty array', async () => {
    const results = await processBatch([], 3, 0, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it('continues on individual failures', async () => {
    const items = [1, 2, 3];
    const results = await processBatch(items, 3, 0, async (n) => {
      if (n === 2) throw new Error('fail');
      return n;
    });
    expect(results).toEqual([1, 3]);
  });

  it('respects concurrency limit', async () => {
    const maxConcurrent = 0;
    const current = 0;

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
function createMockLLM(gEvalScore = 4): LLMProvider {
  return {
    async generate(prompt: string) {
      // G-Eval step generation prompt contains "Generate detailed"
      if (prompt.includes('Generate detailed')) {
        return { text: '1. Check quality\n2. Assess completeness' };
      }
      // QAG statement extraction
      if (prompt.includes('statements') || prompt.includes('claims')) {
        return { text: JSON.stringify(['The response is correct.']) };
      }
      // QAG verdict
      if (prompt.includes('verdict') || prompt.includes('supported')) {
        return { text: 'yes' };
      }
      // G-Eval scoring — return just the score digit
      return { text: String(gEvalScore) };
    },
  };
}

function createFailingLLM(failKeyword: string): LLMProvider {
  return {
    async generate(prompt: string) {
      if (prompt.toLowerCase().includes(failKeyword.toLowerCase())) {
        throw new Error(`Mock ${failKeyword} failure`);
      }
      if (prompt.includes('Generate detailed')) {
        return { text: '1. Check quality\n2. Assess completeness' };
      }
      if (prompt.includes('statements') || prompt.includes('claims')) {
        return { text: JSON.stringify(['The response is correct.']) };
      }
      if (prompt.includes('verdict') || prompt.includes('supported')) {
        return { text: 'yes' };
      }
      return { text: '4' };
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

  it('sets evaluatorType to llm for all results', async () => {
    const llm = createMockLLM();
    const judge = new LLMJudge(llm, { timeoutMs: 5000, maxRetries: 0 });
    const turn = makeTurn({ toolResults: ['ctx'] });

    const evals = await evaluateTurn(judge, turn, new Set());
    for (const ev of evals) {
      expect(ev.evaluatorType).toBe('llm');
    }
  });
});
