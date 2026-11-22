/**
 * Turns: their shape, their key, anchoring to spans and fitting to the judge's input caps.
 * Imports no Node built-in itself, and loads under workerd (the parent's `pipeline-loads.workers.test.ts`);
 * reading turns out of transcripts is `transcript-turns.ts`.
 */

import { group } from 'd3-array';
import { MAX_TEXT_LENGTH, MAX_CONTEXT_ITEMS } from '../../src/lib/judge/llm-judge-constants.js';
import { turnAccount, turnSpan, type AccountIndex, type AccountRef } from './account-index.js';
import {
  LLM_EVALUATOR_KIND,
  NORMAL_COHORT,
  legacyEvaluatorTypeField,
  normalizeScore,
  type EvalRecord,
} from './eval-record.js';
import { turnJudgedKey } from './judge-dedup.js';
import type { JudgeSpec } from './judge-spec.js';
import { scoreLabelForMetric } from '../../src/lib/quality/qfe-label-ordinals.js';
import { turnContentKey } from '../../src/lib/validation/api-schemas.js';

/** Maximum tool context items to balance quality vs cost in evaluations */
export const MAX_TOOL_CONTEXT_ITEMS = 10;

export type Turn = {
  sessionId: string;
  traceId: string;
  timestamp: string;
  userText: string;
  assistantText: string;
  toolResults: string[];
  /** Account the turn ran under (`anchorTurns`); absent when no stamped span covers it. */
  identityKeyRef?: AccountRef;
  /** The turn's first span (`anchorTurns`), which its evaluations are parented to. */
  spanId?: string;
  /** API response id of the turn's assistant message — semconv `gen_ai.response.id`. */
  responseId?: string;
}

/**
 * What a record built from a turn carries to link it to that turn: its span
 * (Phase 2), the response id when no span is known, and its account stamp
 * (Phase 1).
 *
 * Spread, not assigned: an unstamped turn must yield a record with no
 * `identityKeyRef` key at all, which routing reads as "use the span's stamp, else the webhook";
 * `null` is a real stamp (unmapped account, withheld). The response id follows
 * the semconv rule literally — it is set only "when span id is not available".
 */
export function turnSourceFields(turn: Turn): Pick<EvalRecord, 'identityKeyRef' | 'spanId' | 'responseId'> {
  return {
    ...(turn.spanId ? { spanId: turn.spanId } : turn.responseId ? { responseId: turn.responseId } : {}),
    ...(turn.identityKeyRef !== undefined && { identityKeyRef: turn.identityKeyRef }),
  };
}

/** One judge criterion's result on a turn: the raw score, before normalisation. */
export type ScoredCriterion = { evaluationName: string; scoreValue: number; explanation: string };

/**
 * The record a judge path writes for one criterion on one turn; `producer` (the record's `evaluator`) is the
 * only difference between the per-criterion and consolidated paths. Field order is part of a record's
 * identity when it has no `stableEvaluationKey` (`eval-record.ts`), so keep it.
 */
export function judgeRecord(
  turn: Turn,
  producer: string,
  judge: JudgeSpec,
  { evaluationName, scoreValue, explanation }: ScoredCriterion,
): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName,
    scoreValue: normalizeScore(scoreValue),
    scoreLabel: scoreLabelForMetric(evaluationName, scoreValue),
    explanation,
    evaluator: producer,
    ...legacyEvaluatorTypeField(LLM_EVALUATOR_KIND),
    evaluatorKind: LLM_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    judgeModel: judge.model,
    judgeProvider: judge.provider,
    judgeTier: judge.tier,
    judgePromptVersion: judge.promptVersion,
    judgeMode: judge.mode,
    stableEvaluationKey: turnJudgedKey(turn, evaluationName, judge.model),
    traceId: turn.traceId,
    sessionId: turn.sessionId,
    ...turnSourceFields(turn),
  };
}

export function turnKey(turn: { sessionId: string; timestamp: string }): string {
  return turnContentKey(turn.sessionId, turn.timestamp);
}

/**
 * Anchor each turn to its own spans: the session's spans between the turn's
 * start and the next turn's. The first of them gives the turn its trace and
 * the span its evaluations are parented to (Phase 2); the first stamped one
 * gives its account (Phase 1).
 *
 * Never from the transcript's trace id. A transcript's turns all share the
 * trace id of whichever prompt the token-metrics log recorded first, so it
 * names the wrong prompt for every turn but one — `extractTurns` no longer
 * copies it. And never from the account signed in now: the judge runs hours
 * after the turn, often under another account.
 */
export function anchorTurns(turns: Turn[], index: AccountIndex): void {
  for (const [sessionId, sessionTurns] of group(turns, turn => turn.sessionId)) {
    const timed = sessionTurns
      .map((turn) => ({ turn, atMs: Date.parse(turn.timestamp) }))
      .toSorted((a, b) => a.atMs - b.atMs);
    timed.forEach(({ turn, atMs }, i) => {
      const nextMs = timed[i + 1]?.atMs;
      const ref = turnAccount(index, sessionId, atMs, nextMs);
      if (ref !== undefined) turn.identityKeyRef = ref;
      const span = turnSpan(index, sessionId, atMs, nextMs);
      if (span) {
        turn.traceId = span.traceId;
        turn.spanId = span.spanId;
      }
    });
  }
}

export type TextBlock = { type: 'text'; text: string }

export type ToolResultBlock = { type: 'tool_result'; content: string | ContentBlock[] }

export type ToolUseBlock = { type: 'tool_use'; id: string; name: string }

export type ContentBlock = TextBlock | ToolResultBlock | ToolUseBlock;

export function isContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'text' || obj.type === 'tool_result' || obj.type === 'tool_use';
}

export function asContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isContentBlock);
}

export function isSystemPrompt(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  return trimmed.startsWith('<system-reminder>') || trimmed.startsWith('Stop hook feedback:');
}

export function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const blocks = asContentBlocks(content);
  return blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asContentBlocks(content)
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

export function extractToolResults(content: unknown): string[] {
  return asContentBlocks(content)
    .filter((b): b is ToolResultBlock => b.type === 'tool_result')
    .map(b => {
      if (typeof b.content === 'string') return b.content;
      return b.content
        .filter((inner): inner is TextBlock => inner.type === 'text')
        .map(inner => inner.text)
        .join('\n');
    })
    .filter(Boolean);
}

/** Appended when a context item is cut to fit the judge's schema. */
export const CONTEXT_TRUNCATION_MARKER = '\n…[truncated to fit the judge input cap]';

/**
 * Fit tool results to what `testCaseSchema` accepts: the latest
 * MAX_TOOL_CONTEXT_ITEMS / MAX_CONTEXT_ITEMS entries (whichever is smaller),
 * each at most MAX_TEXT_LENGTH characters, so one oversized tool result cannot
 * fail every metric for its turn with "Invalid TestCase … too_big". Keeps the
 * latest, matching `extractTurns`.
 */
export function fitContextForJudge(toolResults: readonly string[]): string[] {
  const itemLimit = Math.min(MAX_TOOL_CONTEXT_ITEMS, MAX_CONTEXT_ITEMS);
  return toolResults.slice(-itemLimit).map(item =>
    item.length <= MAX_TEXT_LENGTH
      ? item
      : item.slice(0, MAX_TEXT_LENGTH - CONTEXT_TRUNCATION_MARKER.length) + CONTEXT_TRUNCATION_MARKER,
  );
}
