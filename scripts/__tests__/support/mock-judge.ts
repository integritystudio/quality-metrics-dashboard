/** A scripted LLM for the judge: answers each prompt kind G-Eval and QAG send with a fixed reply. */

import { LLMJudge } from '../../../../src/lib/judge/llm-judge-config.js';
import type { LLMProvider } from '../../../../src/lib/judge/llm-as-judge.js';

// G-Eval makes 2 calls: (1) step generation, (2) evaluation scoring (1-5 scale).
// QAG makes 2 calls: (1) statement extraction (JSON array), (2) verdict per statement.
const MOCK_GEVAL_STEPS = '1. Check quality\n2. Assess completeness\n3. Verify accuracy';
const MOCK_GEVAL_SCORE = 4;
const JUDGE_TIMEOUT_MS = 5000;

export function mockResponse(prompt: string): { text: string } {
  if (prompt.includes('Generate detailed')) return { text: MOCK_GEVAL_STEPS };
  if (prompt.includes('statements') || prompt.includes('claims')) return { text: JSON.stringify(['The response is correct.']) };
  if (prompt.includes('verdict') || prompt.includes('supported')) return { text: 'yes' };
  return { text: String(MOCK_GEVAL_SCORE) };
}

export function createMockLLM(): LLMProvider {
  return { generate: (prompt: string) => Promise.resolve(mockResponse(prompt)) };
}

export const judgeOver = (llm: LLMProvider): LLMJudge => new LLMJudge(llm, { timeoutMs: JUDGE_TIMEOUT_MS, maxRetries: 0 });
