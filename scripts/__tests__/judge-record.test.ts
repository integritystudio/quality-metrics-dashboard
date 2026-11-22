import { describe, it, expect } from 'vitest';
import { judgeRecord, type ScoredCriterion, type Turn } from '../judge-turns.js';
import { PRODUCER } from '../eval-record.js';
import { CONSOLIDATED_PRODUCER } from '../judge-consolidated.js';
import { HAIKU_MODEL } from '../judge-criteria.js';
import { DEFAULT_JUDGE_SPEC, JUDGE_PROMPT_VERSION } from '../judge-spec.js';

const BASE_TURN = { traceId: 't-1', sessionId: 's-1', timestamp: '2026-11-20T10:00:00.000Z', userText: 'u', assistantText: 'a', toolResults: [] };
const RELEVANCE: ScoredCriterion = { evaluationName: 'relevance', scoreValue: 0.75, explanation: 'why' };

// Pinned from the two builders this replaced (createEvalRecord and buildRecord), byte for byte.
// Key order is part of a record's identity when it has no stableEvaluationKey, so these compare JSON text.
const RECORD_HEAD = '{"timestamp":"2026-11-20T10:00:00.000Z","evaluationName":"relevance","scoreValue":0.75,"scoreLabel":"partial","explanation":"why"';
const RECORD_JUDGE = `"evaluatorType":"llm","evaluatorKind":"llm","cohort":"normal","judgeModel":"${HAIKU_MODEL}","judgeProvider":"anthropic","judgeTier":"specified","judgePromptVersion":"${JUDGE_PROMPT_VERSION}","judgeMode":"sync","stableEvaluationKey":"s-1:relevance:2026-11-20T10:00:00@${HAIKU_MODEL}","traceId":"t-1","sessionId":"s-1"`;

describe('judgeRecord', () => {
  it('writes the per-criterion record as the old builder did', () => {
    const turn: Turn = { ...BASE_TURN, spanId: 'span-1', identityKeyRef: 'ref-1' };

    const json = JSON.stringify(judgeRecord(turn, PRODUCER, DEFAULT_JUDGE_SPEC, RELEVANCE));

    expect(json).toBe(`${RECORD_HEAD},"evaluator":"dashboard:judge-evaluations",${RECORD_JUDGE},"spanId":"span-1","identityKeyRef":"ref-1"}`);
  });

  it('writes the consolidated record identically apart from evaluator', () => {
    const turn: Turn = { ...BASE_TURN, spanId: 'span-1', identityKeyRef: 'ref-1' };

    const json = JSON.stringify(judgeRecord(turn, CONSOLIDATED_PRODUCER, DEFAULT_JUDGE_SPEC, RELEVANCE));

    expect(json).toBe(`${RECORD_HEAD},"evaluator":"dashboard:judge-consolidated",${RECORD_JUDGE},"spanId":"span-1","identityKeyRef":"ref-1"}`);
  });

  it('carries the response id and a withheld (null) stamp when the turn has no span', () => {
    const turn: Turn = { ...BASE_TURN, responseId: 'msg_1', identityKeyRef: null };

    const json = JSON.stringify(judgeRecord(turn, PRODUCER, DEFAULT_JUDGE_SPEC, RELEVANCE));

    expect(json).toBe(`${RECORD_HEAD},"evaluator":"dashboard:judge-evaluations",${RECORD_JUDGE},"responseId":"msg_1","identityKeyRef":null}`);
  });

  it('ends at sessionId for an unanchored turn', () => {
    const json = JSON.stringify(judgeRecord(BASE_TURN, PRODUCER, DEFAULT_JUDGE_SPEC, RELEVANCE));

    expect(json).toBe(`${RECORD_HEAD},"evaluator":"dashboard:judge-evaluations",${RECORD_JUDGE}}`);
  });
});
