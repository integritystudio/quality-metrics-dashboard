#!/usr/bin/env tsx
/**
 * LLM-as-Judge Evaluation Generator
 *
 * Discovers session transcripts from telemetry logs, extracts user/assistant
 * turns, and evaluates them using the LLM-as-Judge library (relevance,
 * coherence, hallucination) via the Anthropic API (Claude Haiku).
 *
 * Appends results to existing evaluations-*.jsonl files alongside rule-based
 * evaluations from derive-evaluations.ts.
 *
 * Usage:
 *   npx tsx dashboard/scripts/judge-evaluations.ts --dry-run
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts --limit 5
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts
 */

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, readdirSync, openSync, closeSync, createReadStream, statSync, constants } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { join, basename } from 'path';
import type { LLMProvider } from '../../src/lib/llm-as-judge.js';
import { sanitizeForPrompt } from '../../src/lib/llm-as-judge.js';
import type { GEvalConfig } from '../../src/lib/llm-as-judge.js';
import {
  LLMJudge,
  RELEVANCE_CRITERIA,
  COHERENCE_CRITERIA,
} from '../../src/lib/llm-judge-config.js';

/** B9: Tool correctness criteria — evaluates whether tool usage was appropriate */
export const TOOL_CORRECTNESS_CRITERIA: GEvalConfig = {
  name: 'tool_correctness',
  criteria: 'Evaluate whether the assistant used the correct tools with appropriate arguments and whether tool results were properly incorporated into the response. Consider: (1) Were the right tools selected for the task? (2) Were tool arguments reasonable? (3) Were tool results accurately reflected in the response?',
  evaluationParams: ['input', 'output', 'context'],
};

/** Tool correctness sub-criteria for structured evaluation */
export const TOOL_SELECTION_CRITERIA: GEvalConfig = {
  name: 'tool_selection',
  criteria: 'Evaluate whether the assistant selected the appropriate tools for the given task. Were the chosen tools the best fit for the user request? Were unnecessary tools avoided? Were any required tools missing that should have been used?',
  evaluationParams: ['input', 'output', 'context'],
};

export const TOOL_ARGUMENTS_CRITERIA: GEvalConfig = {
  name: 'tool_arguments',
  criteria: 'Evaluate whether the tool arguments provided by the assistant were correct and appropriate. Were all required parameters provided with accurate values? Were parameter formats and types correct? Were optional parameters used effectively when beneficial?',
  evaluationParams: ['input', 'output', 'context'],
};

export const TOOL_INTEGRATION_CRITERIA: GEvalConfig = {
  name: 'tool_integration',
  criteria: 'Evaluate whether tool results were properly incorporated into the assistant response. Were results accurately reflected without distortion? Was relevant information extracted and presented clearly? Were errors or unexpected results handled appropriately?',
  evaluationParams: ['input', 'output', 'context'],
};

// ============================================================================
// Constants
// ============================================================================

export const TELEMETRY_DIR = join(process.env.HOME ?? '', '.claude', 'telemetry');
export const CONCURRENCY = 3;
export const BATCH_DELAY_MS = 500;
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const MAX_TURN_TEXT_LEN = 8000;
export const MAX_TOOL_CONTEXT_ITEMS = 10;
export const MAX_TOOL_RESULTS_PER_TURN = 20;
export const MAX_TURN_LIMIT = 10_000;

/** Round score to 4 decimal places (B10: extract from repeated pattern) */
export function normalizeScore(score: number): number {
  return parseFloat(score.toFixed(4));
}

// ============================================================================
// Types
// ============================================================================

export interface TranscriptInfo {
  path: string;
  sessionId: string;
  traceId: string;
}

export interface Turn {
  sessionId: string;
  traceId: string;
  timestamp: string;
  userText: string;
  assistantText: string;
  toolResults: string[];
}

export interface EvalRecord {
  timestamp: string;
  evaluationName: string;
  scoreValue: number;
  explanation: string;
  evaluator: string;
  evaluatorType: string;
  traceId: string;
  sessionId: string;
}

// ============================================================================
// Transcript Discovery
// ============================================================================

async function discoverTranscripts(): Promise<TranscriptInfo[]> {
  const logFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('logs-') && f.endsWith('.jsonl'))
    .sort();

  const seen = new Set<string>();
  const transcripts: TranscriptInfo[] = [];

  for (const file of logFiles) {
    const filepath = join(TELEMETRY_DIR, file);
    // P1-2: Stream line-by-line instead of loading entire file into memory
    const rl = createInterface({
      input: createReadStream(filepath, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const attrs = typeof entry.attributes === 'object' && entry.attributes !== null
        && !Array.isArray(entry.attributes)
        ? entry.attributes as Record<string, unknown> : undefined;
      if (!attrs || attrs['hook.name'] !== 'token-metrics-extraction') continue;

      const tPath = typeof attrs['transcript.path'] === 'string' ? attrs['transcript.path'] : undefined;
      if (!tPath || seen.has(tPath)) continue;

      if (!existsSync(tPath)) continue;

      seen.add(tPath);
      // Session ID is the UUID filename (without .jsonl)
      const sessionId = basename(tPath, '.jsonl');
      const traceId = typeof entry.traceId === 'string' ? entry.traceId : '';

      transcripts.push({ path: tPath, sessionId, traceId });
    }
  }

  return transcripts;
}

// ============================================================================
// Turn Extraction
// ============================================================================

/** B8: Discriminated union for transcript content blocks */
export interface TextBlock { type: 'text'; text: string }
export interface ToolResultBlock { type: 'tool_result'; content: string | ContentBlock[] }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string }
export type ContentBlock = TextBlock | ToolResultBlock | ToolUseBlock;

function isContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'text' || obj.type === 'tool_result' || obj.type === 'tool_use';
}

function asContentBlocks(content: unknown): ContentBlock[] {
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

export async function extractTurns(info: TranscriptInfo): Promise<Turn[]> {
  // H1: Stream line-by-line to avoid loading entire transcript into memory
  const rl = createInterface({
    input: createReadStream(info.path, 'utf-8'),
    crlfDelay: Infinity,
  });
  const turns: Turn[] = [];

  let pendingUser: { text: string; timestamp: string } | null = null;
  const accumulatedToolResults: string[] = [];

  for await (const line of rl) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type as string;
    if (type === 'progress' || type === 'file-history-snapshot') continue;

    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const role = message.role as string | undefined;
    const content = message.content;

    if (type === 'user' && role === 'user') {
      // Collect tool results from user messages (tool_result content)
      const toolRes = extractToolResults(content);
      if (toolRes.length > 0) {
        accumulatedToolResults.push(...toolRes);
        // P1-7: Bound tool results to prevent unbounded memory growth
        if (accumulatedToolResults.length > MAX_TOOL_RESULTS_PER_TURN) {
          accumulatedToolResults.splice(0, accumulatedToolResults.length - MAX_TOOL_RESULTS_PER_TURN);
        }
      }

      // Skip tool_result-only messages
      if (isToolResultOnly(content)) continue;

      const userText = extractTextFromContent(content);
      if (!userText || isSystemPrompt(userText)) continue;

      // P2-10: Skip entries without valid timestamp (required for correlation)
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (!timestamp) continue;

      // P0-1: Sanitize text before LLM evaluation to mitigate prompt injection
      const sanitizedUser = sanitizeForPrompt(userText, MAX_TURN_TEXT_LEN);
      if (!sanitizedUser.trim()) continue; // H2: skip if sanitization removed all content

      pendingUser = {
        text: sanitizedUser,
        timestamp,
      };
    }

    if (type === 'assistant' && role === 'assistant' && pendingUser) {
      const assistantText = extractTextFromContent(content);
      if (!assistantText) continue;

      turns.push({
        sessionId: info.sessionId,
        traceId: info.traceId,
        timestamp: pendingUser.timestamp,
        userText: pendingUser.text,
        // P0-1: Sanitize assistant text before LLM evaluation
        assistantText: sanitizeForPrompt(assistantText, MAX_TURN_TEXT_LEN),
        toolResults: accumulatedToolResults.slice(-MAX_TOOL_RESULTS_PER_TURN),
      });

      pendingUser = null;
      accumulatedToolResults.length = 0; // M4: clear for next turn
    }
  }

  return turns;
}

// ============================================================================
// Anthropic LLM Provider
// ============================================================================

async function createAnthropicProvider(): Promise<LLMProvider> {
  // Dynamic import to avoid requiring @anthropic-ai/sdk when using --seed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  return {
    async generate(
      prompt: string,
      options?: { temperature?: number; logprobs?: boolean }
    ): Promise<{ text: string; logprobs?: Array<{ token: string; logprob: number }> }> {
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        temperature: options?.temperature ?? 0.1,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((b: { type: string; text?: string }) => b.type === 'text')
        .map((b: { type: string; text?: string }) => b.text)
        .join('');

      // B15: Anthropic Messages API doesn't support logprobs, so G-Eval
      // falls back to text-parsed scores. This may cause score clustering
      // around round numbers (0.7, 0.8) due to lack of logprob calibration.
      return { text };
    },
  };
}

// ============================================================================
// Seed Mode (deterministic scores from turn content, no API calls)
// ============================================================================

export function hashToScore(input: string, min: number, max: number): number {
  const hash = createHash('sha256').update(input).digest();
  const value = hash.readUInt16BE(0) / 0xFFFF; // 0-1
  return normalizeScore(min + value * (max - min));
}

/** B6: Deterministic canary check — ~2% of turns get intentionally low scores */
export function isCanaryTurn(sessionId: string, turnKey: string): boolean {
  return hashToScore(`canary:${sessionId}:${turnKey}`, 0, 1) < 0.02;
}

export interface SeedResult {
  evals: EvalRecord[];
  canaryCount: number;
}

export function seedEvaluations(turns: Turn[], existingKeys: Set<string>): SeedResult {
  const evals: EvalRecord[] = [];
  let canaryCount = 0;

  for (const turn of turns) {
    const turnKey = turn.timestamp.slice(0, 19);
    const canary = isCanaryTurn(turn.sessionId, turnKey);
    if (canary) canaryCount++;

    // Relevance: realistic range for code assistant turns (0.70-1.0)
    const relKey = `${turn.sessionId}:relevance:${turnKey}`;
    if (!existingKeys.has(relKey)) {
      evals.push({
        timestamp: turn.timestamp,
        evaluationName: 'relevance',
        scoreValue: canary
          ? hashToScore(`rel:${turn.sessionId}:${turnKey}`, 0.10, 0.35)
          : hashToScore(`rel:${turn.sessionId}:${turnKey}`, 0.70, 1.0),
        explanation: canary
          ? `Relevance (canary) for session ${turn.sessionId.slice(0, 8)}`
          : `Relevance (seeded) for session ${turn.sessionId.slice(0, 8)}`,
        evaluator: 'llm-judge',
        evaluatorType: canary ? 'canary' : 'seed',
        traceId: turn.traceId,
        sessionId: turn.sessionId,
      });
    }

    // Coherence: realistic range (0.75-1.0)
    const cohKey = `${turn.sessionId}:coherence:${turnKey}`;
    if (!existingKeys.has(cohKey)) {
      evals.push({
        timestamp: turn.timestamp,
        evaluationName: 'coherence',
        scoreValue: canary
          ? hashToScore(`coh:${turn.sessionId}:${turnKey}`, 0.15, 0.40)
          : hashToScore(`coh:${turn.sessionId}:${turnKey}`, 0.75, 1.0),
        explanation: canary
          ? `Coherence (canary) for session ${turn.sessionId.slice(0, 8)}`
          : `Coherence (seeded) for session ${turn.sessionId.slice(0, 8)}`,
        evaluator: 'llm-judge',
        evaluatorType: canary ? 'canary' : 'seed',
        traceId: turn.traceId,
        sessionId: turn.sessionId,
      });
    }

    // Faithfulness + Hallucination
    {
      const halScore = canary
        ? hashToScore(`hal:${turn.sessionId}:${turnKey}`, 0.50, 0.80)
        : hashToScore(`hal:${turn.sessionId}:${turnKey}`, 0.0, 0.09);
      const faithScore = normalizeScore(1 - halScore);

      const faithKey = `${turn.sessionId}:faithfulness:${turnKey}`;
      if (!existingKeys.has(faithKey)) {
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'faithfulness',
          scoreValue: faithScore,
          explanation: canary
            ? `Faithfulness (canary) for session ${turn.sessionId.slice(0, 8)}`
            : `Faithfulness (seeded) for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: canary ? 'canary' : 'seed',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      }

      const halKey = `${turn.sessionId}:hallucination:${turnKey}`;
      if (!existingKeys.has(halKey)) {
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'hallucination',
          scoreValue: halScore,
          explanation: canary
            ? `Hallucination (canary) for session ${turn.sessionId.slice(0, 8)}`
            : `Hallucination (seeded) for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: canary ? 'canary' : 'seed',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      }
    }

    // B9: Tool correctness (only meaningful when tool results exist)
    if (turn.toolResults.length > 0) {
      const tcKey = `${turn.sessionId}:tool_correctness:${turnKey}`;
      if (!existingKeys.has(tcKey)) {
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'tool_correctness',
          scoreValue: canary
            ? hashToScore(`tc:${turn.sessionId}:${turnKey}`, 0.10, 0.30)
            : hashToScore(`tc:${turn.sessionId}:${turnKey}`, 0.75, 1.0),
          explanation: canary
            ? `Tool correctness (canary) for session ${turn.sessionId.slice(0, 8)}`
            : `Tool correctness (seeded) for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: canary ? 'canary' : 'seed',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      }
    }
  }

  return { evals, canaryCount };
}

// ============================================================================
// Evaluation
// ============================================================================

/** Track evaluation failures for summary reporting (P1-6) */
export const evalFailures: Record<string, number> = {};

function trackFailure(metric: string): void {
  evalFailures[metric] = (evalFailures[metric] ?? 0) + 1;
}

export async function evaluateTurn(
  judge: LLMJudge,
  turn: Turn,
  existingKeys: Set<string>,
): Promise<EvalRecord[]> {
  const evals: EvalRecord[] = [];
  const turnKey = turn.timestamp.slice(0, 19);

  // Relevance
  const relKey = `${turn.sessionId}:relevance:${turnKey}`;
  if (!existingKeys.has(relKey)) {
    try {
      const result = await judge.evaluateRelevance(
        turn.userText,
        turn.assistantText,
        turn.toolResults.length > 0 ? turn.toolResults.slice(0, MAX_TOOL_CONTEXT_ITEMS) : [],
      );
      evals.push({
        timestamp: turn.timestamp,
        evaluationName: 'relevance',
        scoreValue: normalizeScore(result.score),
        explanation: result.reason ?? `Relevance: ${result.score.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
        evaluator: 'llm-judge',
        evaluatorType: 'llm',
        traceId: turn.traceId,
        sessionId: turn.sessionId,
      });
    } catch (err) {
      trackFailure('relevance');
      console.warn(`  [relevance] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  // Coherence
  const cohKey = `${turn.sessionId}:coherence:${turnKey}`;
  if (!existingKeys.has(cohKey)) {
    try {
      const result = await judge.evaluateCoherence(turn.assistantText);
      evals.push({
        timestamp: turn.timestamp,
        evaluationName: 'coherence',
        scoreValue: normalizeScore(result.score),
        explanation: result.reason ?? `Coherence: ${result.score.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
        evaluator: 'llm-judge',
        evaluatorType: 'llm',
        traceId: turn.traceId,
        sessionId: turn.sessionId,
      });
    } catch (err) {
      trackFailure('coherence');
      console.warn(`  [coherence] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  // Faithfulness + Hallucination (only when tool results exist as context)
  if (turn.toolResults.length > 0) {
    const faithKey = `${turn.sessionId}:faithfulness:${turnKey}`;
    const halKey = `${turn.sessionId}:hallucination:${turnKey}`;
    const needsFaith = !existingKeys.has(faithKey);
    const needsHal = !existingKeys.has(halKey);

    // M2: Use judge.qagEvaluate() for retry support; M5: evaluate independently
    if (needsFaith) {
      try {
        const faithResult = await judge.qagEvaluate(
          turn.userText,
          turn.assistantText,
          turn.toolResults.slice(0, MAX_TOOL_CONTEXT_ITEMS),
        );
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'faithfulness',
          scoreValue: normalizeScore(faithResult.score),
          explanation: faithResult.reason ?? `Faithfulness: ${faithResult.score.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: 'llm',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      } catch (err) {
        trackFailure('faithfulness');
        console.warn(`  [faithfulness] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
      }
    }

    // Hallucination derived by inverting faithfulness score (1 - faithfulness)
    if (needsHal) {
      try {
        const halResult = await judge.evaluateFaithfulness(
          turn.userText,
          turn.assistantText,
          turn.toolResults.slice(0, MAX_TOOL_CONTEXT_ITEMS),
        );
        // Invert: faithfulness measures consistency, hallucination is the complement
        const halScore = normalizeScore(1 - halResult.score);
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'hallucination',
          scoreValue: halScore,
          explanation: halResult.reason ?? `Hallucination: ${halScore.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: 'llm',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      } catch (err) {
        trackFailure('hallucination');
        console.warn(`  [hallucination] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
      }
    }

    // B9: Tool correctness — composite + structured sub-criteria
    const tcKey = `${turn.sessionId}:tool_correctness:${turnKey}`;
    if (!existingKeys.has(tcKey)) {
      const tcTestCase = {
        input: turn.userText,
        output: turn.assistantText,
        context: turn.toolResults.slice(0, MAX_TOOL_CONTEXT_ITEMS),
      };
      try {
        const tcResult = await judge.gEval(TOOL_CORRECTNESS_CRITERIA, tcTestCase);
        evals.push({
          timestamp: turn.timestamp,
          evaluationName: 'tool_correctness',
          scoreValue: normalizeScore(tcResult.score),
          explanation: tcResult.reason ?? `Tool correctness: ${tcResult.score.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
          evaluator: 'llm-judge',
          evaluatorType: 'llm',
          traceId: turn.traceId,
          sessionId: turn.sessionId,
        });
      } catch (err) {
        trackFailure('tool_correctness');
        console.warn(`  [tool_correctness] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
      }

      // Structured sub-criteria: selection, arguments, integration
      const subCriteria = [
        { config: TOOL_SELECTION_CRITERIA, name: 'tool_selection' },
        { config: TOOL_ARGUMENTS_CRITERIA, name: 'tool_arguments' },
        { config: TOOL_INTEGRATION_CRITERIA, name: 'tool_integration' },
      ] as const;

      for (const { config, name } of subCriteria) {
        const subKey = `${turn.sessionId}:${name}:${turnKey}`;
        if (existingKeys.has(subKey)) continue;
        try {
          const result = await judge.gEval(config, tcTestCase);
          evals.push({
            timestamp: turn.timestamp,
            evaluationName: name,
            scoreValue: normalizeScore(result.score),
            explanation: result.reason ?? `${name}: ${result.score.toFixed(2)} for session ${turn.sessionId.slice(0, 8)}`,
            evaluator: 'llm-judge',
            evaluatorType: 'llm',
            traceId: turn.traceId,
            sessionId: turn.sessionId,
          });
        } catch (err) {
          trackFailure(name);
          console.warn(`  [${name}] Error for ${turn.sessionId.slice(0, 8)}: ${(err as Error).message}`);
        }
      }
    }
  }

  return evals;
}

// ============================================================================
// OTel Serialization
// ============================================================================

export function toOTelRecord(ev: EvalRecord): object {
  const attrs: Record<string, unknown> = {
    'gen_ai.evaluation.name': ev.evaluationName,
    'gen_ai.evaluation.score.value': ev.scoreValue,
    'gen_ai.evaluation.explanation': ev.explanation,
    'gen_ai.evaluation.evaluator': ev.evaluator,
    'gen_ai.evaluation.evaluator.type': ev.evaluatorType,
  };
  if (ev.sessionId) attrs['session.id'] = ev.sessionId;
  return {
    timestamp: ev.timestamp,
    name: 'gen_ai.evaluation.result',
    attributes: attrs,
    traceId: ev.traceId,
  };
}

// ============================================================================
// Deduplication
// ============================================================================

function loadExistingKeys(): Set<string> {
  const keys = new Set<string>();
  const evalFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('evaluations-') && f.endsWith('.jsonl'));

  for (const file of evalFiles) {
    const filepath = join(TELEMETRY_DIR, file);
    const lines = readFileSync(filepath, 'utf-8').split('\n').filter(Boolean);

    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const attrs = typeof record.attributes === 'object' && record.attributes !== null
        ? record.attributes as Record<string, unknown> : undefined;
      if (!attrs) continue;
      const evalType = attrs['gen_ai.evaluation.evaluator.type'];
      if (evalType !== 'llm' && evalType !== 'seed') continue;

      const sessionId = typeof attrs['session.id'] === 'string' ? attrs['session.id'] : '';
      const metricName = typeof attrs['gen_ai.evaluation.name'] === 'string' ? attrs['gen_ai.evaluation.name'] : '';
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
      const turnKey = timestamp.slice(0, 19);

      keys.add(`${sessionId}:${metricName}:${turnKey}`);
    }
  }

  return keys;
}

// ============================================================================
// Output
// ============================================================================

const LOCK_FILE = join(TELEMETRY_DIR, '.judge-evaluations.lock');

function acquireLock(): boolean {
  // P1-1: Atomic create via O_CREAT | O_EXCL eliminates TOCTOU race
  try {
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    // Lock file exists — check if owning process is still alive
    let stale = false;
    try {
      const lockContent = readFileSync(LOCK_FILE, 'utf-8').trim();
      const lockPid = parseInt(lockContent, 10);
      if (isNaN(lockPid) || lockPid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(lockPid, 0);
          return false; // Process alive, lock held
        } catch (killErr) {
          // EPERM = process exists but we can't signal it — lock is valid
          if ((killErr as NodeJS.ErrnoException).code === 'EPERM') return false;
          stale = true; // Process dead — stale lock
        }
      }
    } catch {
      return false;
    }

    // Also check lock age — stale if older than 1 hour regardless of PID
    if (!stale) {
      try {
        const lockStat = statSync(LOCK_FILE);
        const lockAgeMs = Date.now() - lockStat.mtimeMs;
        if (lockAgeMs > 3_600_000) {
          console.warn(`[judge] Lock file is ${Math.round(lockAgeMs / 60_000)}min old, treating as stale`);
          stale = true;
        }
      } catch { /* stat failed, leave stale as-is */ }
    }

    if (stale) {
      // Remove stale lock and re-acquire atomically (no recursive retry)
      try { unlinkSync(LOCK_FILE); } catch { /* another process may have removed it */ }
      try {
        const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      } catch {
        return false; // Another process won the race
      }
    }
    return false;
  }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** B12: Safe exit that always attempts lock cleanup */
function safeExit(code: number): never {
  releaseLock();
  process.exit(code);
}

function writeEvaluations(evals: EvalRecord[]): void {
  // Group by date
  const byDate = new Map<string, EvalRecord[]>();
  for (const ev of evals) {
    const date = ev.timestamp.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(ev);
  }

  for (const [date, records] of byDate) {
    const outFile = join(TELEMETRY_DIR, `evaluations-${date}.jsonl`);
    const content = records.map(e => JSON.stringify(toOTelRecord(e))).join('\n') + '\n';
    appendFileSync(outFile, content);
    console.log(`  Appended ${records.length} evaluations to evaluations-${date}.jsonl`);
  }
}

// ============================================================================
// Batching
// ============================================================================

export async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      }
    }

    if (i + concurrency < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const seed = args.includes('--seed');
  const limitIdx = args.indexOf('--limit');
  let limit = Infinity;
  if (limitIdx !== -1) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error('Error: --limit must be a positive integer');
      process.exit(1);
    }
    limit = Math.min(parsed, MAX_TURN_LIMIT);
  }

  // Step 1: Discover transcripts
  console.log('Discovering transcripts...');
  const transcripts = await discoverTranscripts();
  console.log(`Found ${transcripts.length} unique transcripts`);

  // Step 2: Extract turns
  console.log('Extracting turns...');
  let allTurns: Turn[] = [];
  for (const info of transcripts) {
    const turns = await extractTurns(info);
    allTurns.push(...turns);
  }
  console.log(`Extracted ${allTurns.length} conversation turns`);

  // Apply limit
  if (limit < allTurns.length) {
    allTurns = allTurns.slice(0, limit);
    console.log(`Limited to ${limit} turns`);
  }

  if (dryRun) {
    // P2-14: Accurate cost estimate based on tool result presence
    // 2 base evals (relevance, coherence) + 3 with tools (faithfulness, hallucination, tool_correctness)
    const estEvals = allTurns.reduce((sum, t) =>
      sum + 2 + (t.toolResults.length > 0 ? 3 : 0), 0);
    // B7: Estimate tokens from actual content length (~4 chars/token)
    const estInputTokens = allTurns.reduce((sum, t) => {
      const contentChars = t.userText.length + t.assistantText.length
        + t.toolResults.reduce((s, r) => s + r.length, 0);
      const evalsPerTurn = 2 + (t.toolResults.length > 0 ? 2 : 0);
      return sum + Math.ceil(contentChars / 4) * evalsPerTurn;
    }, 0);
    const estOutputTokens = estEvals * 200;
    // Haiku 3.5 pricing: $0.80/1M input, $4.00/1M output
    const HAIKU_INPUT_PER_M = 0.80;
    const HAIKU_OUTPUT_PER_M = 4.0;
    const estCost = (estInputTokens * HAIKU_INPUT_PER_M + estOutputTokens * HAIKU_OUTPUT_PER_M) / 1_000_000;
    console.log('\n--- Dry Run Summary ---');
    console.log(`Transcripts: ${transcripts.length}`);
    console.log(`Turns to evaluate: ${allTurns.length}`);
    console.log(`Estimated evaluations: ${estEvals}`);
    console.log(`Estimated cost: ~$${estCost.toFixed(2)}`);

    const bySession = new Map<string, number>();
    for (const t of allTurns) {
      bySession.set(t.sessionId.slice(0, 8), (bySession.get(t.sessionId.slice(0, 8)) ?? 0) + 1);
    }
    console.log(`\nTurns per session (top 10):`);
    const sorted = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [sid, count] of sorted) {
      console.log(`  ${sid}: ${count} turns`);
    }
    return;
  }

  // P1-5: Validate API key early (before expensive operations)
  if (!seed && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY required (or use --seed for offline mode)');
    process.exit(1);
  }

  // P0-2: Acquire lock to prevent concurrent writes
  if (!acquireLock()) {
    console.error('Error: Another judge-evaluations process is running (lockfile exists)');
    process.exit(1);
  }

  try {
    // Step 3: Load existing keys for dedup
    console.log('Loading existing evaluation keys for deduplication...');
    const existingKeys = loadExistingKeys();
    console.log(`Found ${existingKeys.size} existing LLM evaluation keys`);

    // Reset failure tracking
    for (const key of Object.keys(evalFailures)) delete evalFailures[key];

    let flatEvals: EvalRecord[];

    if (seed) {
      // Seed mode: generate deterministic scores from turn content, no API calls
      console.log(`\nSeeding evaluations for ${allTurns.length} turns...`);
      const seedResult = seedEvaluations(allTurns, existingKeys);
      flatEvals = seedResult.evals;
      if (seedResult.canaryCount > 0) {
        console.log(`  Canary turns: ${seedResult.canaryCount}`);
      }
    } else {
      const llm = await createAnthropicProvider();
      const judge = new LLMJudge(llm, {
        timeoutMs: 60_000,
        maxRetries: 2,
        evaluator: 'llm-judge',
        evaluatorType: 'llm',
        logger: {
          debug: (msg) => console.log(`  [debug] ${msg}`),
          warn: (msg) => console.warn(`  [warn] ${msg}`),
          error: (msg) => console.error(`  [error] ${msg}`),
        },
      });

      console.log(`\nEvaluating ${allTurns.length} turns (concurrency=${CONCURRENCY})...`);
      const allEvals = await processBatch(
        allTurns,
        CONCURRENCY,
        BATCH_DELAY_MS,
        (turn) => evaluateTurn(judge, turn, existingKeys),
      );

      flatEvals = allEvals.flat();
    }

    console.log(`\nGenerated ${flatEvals.length} evaluations`);

    if (flatEvals.length === 0) {
      console.log('No new evaluations to write (all deduplicated or failed)');
      return;
    }

    // Write results
    writeEvaluations(flatEvals);

    // Summary
    const byCat = new Map<string, number>();
    for (const ev of flatEvals) {
      byCat.set(ev.evaluationName, (byCat.get(ev.evaluationName) ?? 0) + 1);
    }
    console.log('\nSummary:');
    for (const [name, count] of byCat) {
      console.log(`  ${name}: ${count}`);
    }

    // P1-6: Report failures
    const failureEntries = Object.entries(evalFailures).filter(([, n]) => n > 0);
    if (failureEntries.length > 0) {
      console.log('\nFailures:');
      for (const [name, count] of failureEntries) {
        console.log(`  ${name}: ${count} failed`);
      }
    }
  } finally {
    releaseLock();
  }
}

// Only run when executed directly (not imported as module for testing)
const isDirectRun = process.argv[1]?.endsWith('judge-evaluations.ts') ||
  process.argv[1]?.endsWith('judge-evaluations.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal error:', err);
    safeExit(1);
  });
}
