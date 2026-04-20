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

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, readdirSync, openSync, closeSync, statSync, constants } from 'fs';
import { createHash } from 'crypto';
import { join, basename } from 'path';
import type { LLMProvider, GEvalConfig } from '../../src/lib/judge/llm-as-judge.js';
import { sanitizeForPrompt } from '../../src/lib/judge/llm-as-judge.js';
import {
  LLMJudge,
  COHERENCE_CRITERIA,
} from '../../src/lib/judge/llm-judge-config.js';
import {
  traceSpanSchema,
  otelLogEntrySchema,
  transcriptEntrySchema,
  otelEvaluationRecordSchema,
  type EvaluatorType,
  HALLUCINATION_EVAL_NAME,
  LLM_EVALUATOR_TYPE,
} from '../../src/lib/validation/dashboard-schemas.js';
import { readJsonlWithValidationSync, streamJsonlWithValidation } from '../../src/lib/dashboard-file-utils.js';
import { MODEL_PRICING, TOKENS_PER_CHAR, TOKENS_PER_MILLION } from '../../src/lib/core/constants-models.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { HOOK_NAME } from '../src/api/api-constants.js';
import pLimit from 'p-limit';

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

const HOME = process.env.HOME ?? '';
export const TELEMETRY_DIR = join(HOME, '.claude', 'telemetry');
export const SESSION_ID_PREVIEW_LEN = 8;
export const EVAL_SCORE_PRECISION = 4;
export const SEED_EVALUATOR: EvaluatorType = 'seed';
export const CANARY_EVALUATOR_TYPE = 'canary';
export const SEED_EVALUATOR_TYPE = 'seed';
export const RULE_EVALUATOR_TYPE = 'rule';
export const TRACE_BACKFILL_EVALUATOR_TYPE = 'trace-backfill';
export const RELEVANCE_EVAL_NAME = 'relevance';
export const COHERENCE_EVAL_NAME = 'coherence';
export const FAITHFULNESS_EVAL_NAME = 'faithfulness';
export const CONCURRENCY = 3;
export const BATCH_DELAY_MS = 500;
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const JUDGE_MAX_TOKENS = 1024;
/** Low temperature for consistent, deterministic evaluation scores */
export const JUDGE_DEFAULT_TEMPERATURE = 0.1;
/** Maximum characters per turn to prevent oversized LLM prompts and token explosion */
export const MAX_TURN_TEXT_LEN = 8000;
/** Maximum tool context items to balance quality vs cost in evaluations */
export const MAX_TOOL_CONTEXT_ITEMS = 10;
/** Maximum tool results to include per turn in evaluation context */
export const MAX_TOOL_RESULTS_PER_TURN = 20;
export const MAX_TURN_LIMIT = 10_000;
export const TIMESTAMP_TURN_KEY_LEN = 19; // ISO 8601 up to seconds: "2026-02-09T01:11:15"
export const UUID_PREFIX_REGEX = /^[0-9a-f]{8}-/;

export function normalizeScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

function createEvalRecord(
  turn: Turn,
  evaluationName: string,
  scoreValue: number,
  explanation: string,
  evaluator: EvaluatorType,
  evaluatorType: EvaluatorType,
): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName,
    scoreValue: normalizeScore(scoreValue),
    explanation,
    evaluator,
    evaluatorType,
    traceId: turn.traceId,
    sessionId: turn.sessionId,
  };
}

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
  evaluator: EvaluatorType;
  evaluatorType: EvaluatorType;
  traceId: string;
  sessionId: string;
}

/**
 * Alternate directories where session transcripts may exist.
 * Checked in order when a log-referenced path is missing, and scanned
 * directly to discover transcripts not referenced in logs at all.
 */
const TRANSCRIPT_DIRS = [
  join(HOME, '.claude', 'projects'),
  join(HOME, 'claude-tool-use', 'projects'),
  join(HOME, '.claude-history', 'projects'),
  // Root-level slug dirs (transcripts stored outside projects/ subdirectory)
  join(HOME, 'claude-tool-use'),
  join(HOME, '.claude-history'),
];

/** Try to resolve a missing transcript path by checking alternate directories */
function resolveTranscriptPath(originalPath: string): string | null {
  if (existsSync(originalPath)) return originalPath;

  const projectsIdx = originalPath.indexOf('/projects/');
  if (projectsIdx === -1) return null;
  const suffix = originalPath.slice(projectsIdx + '/projects/'.length);

  for (const dir of TRANSCRIPT_DIRS) {
    const candidate = join(dir, suffix);
    if (candidate !== originalPath && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Discover transcripts from telemetry logs (primary) and directory scan (fallback) */
async function _discoverTranscripts(): Promise<TranscriptInfo[]> {
  // Track by sessionId (UUID) to deduplicate across sources
  const seen = new Set<string>();
  const transcripts: TranscriptInfo[] = [];

  const logFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('logs-') && f.endsWith('.jsonl'))
    .sort();

  for (const file of logFiles) {
    const filepath = join(TELEMETRY_DIR, file);
    for await (const entry of streamJsonlWithValidation(filepath, otelLogEntrySchema)) {
      const attrs = entry.attributes;
      if (!attrs || attrs['hook.name'] !== HOOK_NAME.TOKEN_METRICS) continue;

      const tPath = typeof attrs['transcript.path'] === 'string' ? attrs['transcript.path'] : undefined;
      if (!tPath) continue;

      const sessionId = basename(tPath, '.jsonl');
      if (seen.has(sessionId)) continue;

      const resolved = resolveTranscriptPath(tPath);
      if (!resolved) continue;

      seen.add(sessionId);
      const traceId = typeof entry.traceId === 'string' ? entry.traceId : '';
      transcripts.push({ path: resolved, sessionId, traceId });
    }
  }

  for (const dir of TRANSCRIPT_DIRS) {
    if (!existsSync(dir)) continue;
    let slugDirs: string[];
    try {
      slugDirs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const slug of slugDirs) {
      const slugPath = join(dir, slug);
      let files: string[];
      try {
        files = readdirSync(slugPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = basename(f, '.jsonl');
        // Skip non-UUID filenames (memory files, etc.)
        if (!UUID_PREFIX_REGEX.test(sessionId)) continue;
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        transcripts.push({ path: join(slugPath, f), sessionId, traceId: '' });
      }
    }
  }

  return transcripts;
}

interface TraceSession {
  sessionId: string;
  traceId: string;
  earliestTime: number; // epoch seconds
  spanCount: number;
}

/** Discover sessions from traces-*.jsonl when transcripts are unavailable */
async function discoverSessionsFromTraces(): Promise<Turn[]> {
  const traceFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
    .sort();

  const sessions = new Map<string, TraceSession>();

  for (const file of traceFiles) {
    const filepath = join(TELEMETRY_DIR, file);

    for await (const span of streamJsonlWithValidation(filepath, traceSpanSchema)) {
      const attrs = span.attributes;
      if (!attrs) continue;

      const sessionId = typeof attrs['session.id'] === 'string' ? attrs['session.id'] : '';
      if (!sessionId) continue;

      const startTime = Array.isArray(span.startTime) ? span.startTime[0] : 0;
      const traceId = span.traceId || '';

      const existing = sessions.get(sessionId);
      if (!existing) {
        sessions.set(sessionId, { sessionId, traceId, earliestTime: startTime, spanCount: 1 });
      } else {
        existing.spanCount++;
        if (startTime < existing.earliestTime) {
          existing.earliestTime = startTime;
          existing.traceId = traceId;
        }
      }
    }
  }

  const turns: Turn[] = [];
  for (const s of sessions.values()) {
    const timestamp = new Date(s.earliestTime * 1000).toISOString();
    turns.push({
      sessionId: s.sessionId,
      traceId: s.traceId,
      timestamp,
      userText: '[trace-backfill]',
      assistantText: '[trace-backfill]',
      toolResults: [],
    });
  }

  return turns;
}

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
  const turns: Turn[] = [];

  let pendingUser: { text: string; timestamp: string } | null = null;
  const accumulatedToolResults: string[] = [];

  for await (const entry of streamJsonlWithValidation(info.path, transcriptEntrySchema)) {
    const type = entry.type;
    if (type === 'progress' || type === 'file-history-snapshot') continue;

    const message = entry.message;
    if (!message) continue;

    const role = message.role;
    const content = message.content;

    if (type === 'user' && role === 'user') {
      const toolRes = extractToolResults(content);
      if (toolRes.length > 0) {
        accumulatedToolResults.push(...toolRes);
      }

      if (isToolResultOnly(content)) continue;

      const userText = extractTextFromContent(content);
      if (!userText || isSystemPrompt(userText)) continue;

      // Skip entries without valid timestamp (required for correlation)
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (!timestamp) continue;

      // Sanitize text before LLM evaluation to mitigate prompt injection
      const sanitizedUser = sanitizeForPrompt(userText, MAX_TURN_TEXT_LEN);
      if (!sanitizedUser.trim()) continue;

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
        assistantText: sanitizeForPrompt(assistantText, MAX_TURN_TEXT_LEN),
        toolResults: accumulatedToolResults.slice(-MAX_TOOL_RESULTS_PER_TURN),
      });

      pendingUser = null;
      accumulatedToolResults.length = 0;
    }
  }

  return turns;
}

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
        max_tokens: JUDGE_MAX_TOKENS,
        temperature: options?.temperature ?? JUDGE_DEFAULT_TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((b: { type: string; text?: string }) => b.type === 'text')
        .map((b: { type: string; text?: string }) => b.text)
        .join('');

      // Anthropic Messages API doesn't support logprobs, so G-Eval
      // falls back to text-parsed scores. This may cause score clustering
      // around round numbers (0.7, 0.8) due to lack of logprob calibration.
      return { text };
    },
  };
}

export function hashToScore(input: string, min: number, max: number): number {
  const hash = createHash('sha256').update(input).digest();
  const value = hash.readUInt16BE(0) / 0xFFFF; // 0-1
  return normalizeScore(min + value * (max - min));
}

/** Deterministic canary check — ~2% of turns get intentionally low scores */
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
    const turnKey = turn.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN);
    const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
    const canary = isCanaryTurn(turn.sessionId, turnKey);
    if (canary) canaryCount++;

    const relKey = `${turn.sessionId}:${RELEVANCE_EVAL_NAME}:${turnKey}`;
    if (!existingKeys.has(relKey)) {
      evals.push(
        createEvalRecord(
          turn,
          RELEVANCE_EVAL_NAME,
          canary
            ? hashToScore(`rel:${turn.sessionId}:${turnKey}`, 0.10, 0.35)
            : hashToScore(`rel:${turn.sessionId}:${turnKey}`, 0.70, 1.0),
          canary
            ? `Relevance (canary) for session ${sessionPreview}`
            : `Relevance (seeded) for session ${sessionPreview}`,
          canary ? LLM_EVALUATOR_TYPE : SEED_EVALUATOR,
          canary ? CANARY_EVALUATOR_TYPE : SEED_EVALUATOR_TYPE,
        ),
      );
    }

    const cohKey = `${turn.sessionId}:${COHERENCE_EVAL_NAME}:${turnKey}`;
    if (!existingKeys.has(cohKey)) {
      evals.push(
        createEvalRecord(
          turn,
          COHERENCE_EVAL_NAME,
          canary
            ? hashToScore(`coh:${turn.sessionId}:${turnKey}`, 0.15, 0.40)
            : hashToScore(`coh:${turn.sessionId}:${turnKey}`, 0.75, 1.0),
          canary
            ? `Coherence (canary) for session ${sessionPreview}`
            : `Coherence (seeded) for session ${sessionPreview}`,
          canary ? LLM_EVALUATOR_TYPE : SEED_EVALUATOR,
          canary ? CANARY_EVALUATOR_TYPE : SEED_EVALUATOR_TYPE,
        ),
      );
    }

    {
      const halScore = canary
        ? hashToScore(`hal:${turn.sessionId}:${turnKey}`, 0.50, 0.80)
        : hashToScore(`hal:${turn.sessionId}:${turnKey}`, 0.0, 0.09);
      const faithScore = normalizeScore(1 - halScore);

      const faithKey = `${turn.sessionId}:${FAITHFULNESS_EVAL_NAME}:${turnKey}`;
      if (!existingKeys.has(faithKey)) {
        evals.push(
          createEvalRecord(
            turn,
            FAITHFULNESS_EVAL_NAME,
            faithScore,
            canary
              ? `Faithfulness (canary) for session ${sessionPreview}`
              : `Faithfulness (seeded) for session ${sessionPreview}`,
            canary ? LLM_EVALUATOR_TYPE : SEED_EVALUATOR,
            canary ? CANARY_EVALUATOR_TYPE : SEED_EVALUATOR_TYPE,
          ),
        );
      }

      const halKey = `${turn.sessionId}:${HALLUCINATION_EVAL_NAME}:${turnKey}`;
      if (!existingKeys.has(halKey)) {
        evals.push(
          createEvalRecord(
            turn,
            HALLUCINATION_EVAL_NAME,
            halScore,
            canary
              ? `Hallucination (canary) for session ${sessionPreview}`
              : `Hallucination (seeded) for session ${sessionPreview}`,
            canary ? LLM_EVALUATOR_TYPE : SEED_EVALUATOR,
            canary ? CANARY_EVALUATOR_TYPE : SEED_EVALUATOR_TYPE,
          ),
        );
      }
    }

    // Only evaluate tool correctness when tool results exist
    if (turn.toolResults.length > 0) {
      const tcKey = `${turn.sessionId}:${TOOL_CORRECTNESS_CRITERIA.name}:${turnKey}`;
      if (!existingKeys.has(tcKey)) {
        evals.push(
          createEvalRecord(
            turn,
            TOOL_CORRECTNESS_CRITERIA.name,
            canary
              ? hashToScore(`tc:${turn.sessionId}:${turnKey}`, 0.10, 0.30)
              : hashToScore(`tc:${turn.sessionId}:${turnKey}`, 0.75, 1.0),
            canary
              ? `Tool correctness (canary) for session ${sessionPreview}`
              : `Tool correctness (seeded) for session ${sessionPreview}`,
            canary ? LLM_EVALUATOR_TYPE : SEED_EVALUATOR,
            canary ? CANARY_EVALUATOR_TYPE : SEED_EVALUATOR_TYPE,
          ),
        );
      }
    }
  }

  return { evals, canaryCount };
}

/** Track evaluation failures for summary reporting */
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
  const turnKey = turn.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN);
  const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
  const toolContext = turn.toolResults.slice(0, MAX_TOOL_CONTEXT_ITEMS);

  const relKey = `${turn.sessionId}:${RELEVANCE_EVAL_NAME}:${turnKey}`;
  if (!existingKeys.has(relKey)) {
    try {
      const result = await judge.evaluateRelevance(
        turn.userText,
        turn.assistantText,
        toolContext,
      );
      evals.push(
        createEvalRecord(
          turn,
          RELEVANCE_EVAL_NAME,
          result.score,
          result.reason ?? `Relevance: ${result.score.toFixed(2)} for session ${sessionPreview}`,
          LLM_EVALUATOR_TYPE,
          LLM_EVALUATOR_TYPE,
        ),
      );
    } catch (err) {
      trackFailure(RELEVANCE_EVAL_NAME);
      console.warn(`  [${RELEVANCE_EVAL_NAME}] Error for ${sessionPreview}: ${(err as Error).message}`);
    }
  }

  const cohKey = `${turn.sessionId}:${COHERENCE_EVAL_NAME}:${turnKey}`;
  if (!existingKeys.has(cohKey)) {
    try {
      const result = await judge.gEval(COHERENCE_CRITERIA, { input: turn.userText, output: turn.assistantText });
      evals.push(
        createEvalRecord(
          turn,
          COHERENCE_EVAL_NAME,
          result.score,
          result.reason ?? `Coherence: ${result.score.toFixed(2)} for session ${sessionPreview}`,
          LLM_EVALUATOR_TYPE,
          LLM_EVALUATOR_TYPE,
        ),
      );
    } catch (err) {
      trackFailure(COHERENCE_EVAL_NAME);
      console.warn(`  [${COHERENCE_EVAL_NAME}] Error for ${sessionPreview}: ${(err as Error).message}`);
    }
  }

  if (turn.toolResults.length > 0) {
    const faithKey = `${turn.sessionId}:${FAITHFULNESS_EVAL_NAME}:${turnKey}`;
    const halKey = `${turn.sessionId}:${HALLUCINATION_EVAL_NAME}:${turnKey}`;
    const needsFaith = !existingKeys.has(faithKey);
    const needsHal = !existingKeys.has(halKey);

    // qagEvaluate() for retry support; faithfulness and hallucination evaluated independently
    if (needsFaith) {
      try {
        const faithResult = await judge.qagEvaluate(
          turn.userText,
          turn.assistantText,
          toolContext,
        );
        evals.push(
          createEvalRecord(
            turn,
            FAITHFULNESS_EVAL_NAME,
            faithResult.score,
            faithResult.reason ?? `Faithfulness: ${faithResult.score.toFixed(2)} for session ${sessionPreview}`,
            LLM_EVALUATOR_TYPE,
            LLM_EVALUATOR_TYPE,
          ),
        );
      } catch (err) {
        trackFailure(FAITHFULNESS_EVAL_NAME);
        console.warn(`  [${FAITHFULNESS_EVAL_NAME}] Error for ${sessionPreview}: ${(err as Error).message}`);
      }
    }

    // Hallucination derived by inverting faithfulness score (1 - faithfulness)
    if (needsHal) {
      try {
        const halResult = await judge.evaluateFaithfulness(
          turn.userText,
          turn.assistantText,
          toolContext,
        );
        // Invert: faithfulness measures consistency, hallucination is the complement
        const halScore = 1 - halResult.score;
        evals.push(
          createEvalRecord(
            turn,
            HALLUCINATION_EVAL_NAME,
            halScore,
            halResult.reason ?? `Hallucination: ${normalizeScore(halScore).toFixed(2)} for session ${sessionPreview}`,
            LLM_EVALUATOR_TYPE,
            LLM_EVALUATOR_TYPE,
          ),
        );
      } catch (err) {
        trackFailure(HALLUCINATION_EVAL_NAME);
        console.warn(`  [${HALLUCINATION_EVAL_NAME}] Error for ${sessionPreview}: ${(err as Error).message}`);
      }
    }

    const tcKey = `${turn.sessionId}:${TOOL_CORRECTNESS_CRITERIA.name}:${turnKey}`;
    if (!existingKeys.has(tcKey)) {
      const tcTestCase = {
        input: turn.userText,
        output: turn.assistantText,
        context: toolContext,
      };
      try {
        const tcResult = await judge.gEval(TOOL_CORRECTNESS_CRITERIA, tcTestCase);
        evals.push(
          createEvalRecord(
            turn,
            TOOL_CORRECTNESS_CRITERIA.name,
            tcResult.score,
            tcResult.reason ?? `Tool correctness: ${tcResult.score.toFixed(2)} for session ${sessionPreview}`,
            LLM_EVALUATOR_TYPE,
            LLM_EVALUATOR_TYPE,
          ),
        );
      } catch (err) {
        trackFailure(TOOL_CORRECTNESS_CRITERIA.name);
        console.warn(`  [${TOOL_CORRECTNESS_CRITERIA.name}] Error for ${sessionPreview}: ${(err as Error).message}`);
      }

      const subCriteria = [
        TOOL_SELECTION_CRITERIA,
        TOOL_ARGUMENTS_CRITERIA,
        TOOL_INTEGRATION_CRITERIA,
      ] as const;

      for (const config of subCriteria) {
        const { name } = config;
        const subKey = `${turn.sessionId}:${name}:${turnKey}`;
        if (existingKeys.has(subKey)) continue;
        try {
          const result = await judge.gEval(config, tcTestCase);
          evals.push(
            createEvalRecord(
              turn,
              name,
              result.score,
              result.reason ?? `${name}: ${result.score.toFixed(2)} for session ${sessionPreview}`,
              LLM_EVALUATOR_TYPE,
              LLM_EVALUATOR_TYPE,
            ),
          );
        } catch (err) {
          trackFailure(name);
          console.warn(`  [${name}] Error for ${sessionPreview}: ${(err as Error).message}`);
        }
      }
    }
  }

  return evals;
}

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

function _loadExistingKeys(): Set<string> {
  const keys = new Set<string>();
  const evalFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('evaluations-') && f.endsWith('.jsonl'));

  for (const file of evalFiles) {
    const filepath = join(TELEMETRY_DIR, file);
    const records = readJsonlWithValidationSync(filepath, otelEvaluationRecordSchema);

    for (const record of records) {
      const attrs = record.attributes;
      if (!attrs) continue;
      const evalType = attrs['gen_ai.evaluation.evaluator.type'];
      if (evalType !== LLM_EVALUATOR_TYPE && evalType !== SEED_EVALUATOR_TYPE && evalType !== TRACE_BACKFILL_EVALUATOR_TYPE) continue;

      const sessionId = attrs['session.id'] as string || '';
      const metricName = attrs['gen_ai.evaluation.name'] as string || '';
      const timestamp = record.timestamp || '';
      const turnKey = timestamp.slice(0, 19);

      keys.add(`${sessionId}:${metricName}:${turnKey}`);
    }
  }

  return keys;
}

const LOCK_FILE = join(TELEMETRY_DIR, '.judge-evaluations.lock');

function acquireLock(): boolean {
  // Atomic create via O_CREAT | O_EXCL eliminates TOCTOU race
  try {
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    // Lock file exists — check if owning process is still alive
    try {
      const lockContent = readFileSync(LOCK_FILE, 'utf-8').trim();
      const lockPid = parseInt(lockContent, 10);
      if (!isNaN(lockPid) && lockPid > 0) {
        try {
          process.kill(lockPid, 0);
          return false; // Process alive, lock held
        } catch (killErr) {
          // EPERM = process exists but we can't signal it — lock is valid
          if ((killErr as NodeJS.ErrnoException).code === 'EPERM') return false;
          // Process dead — stale lock, continue to age check
        }
      }
    } catch {
      return false;
    }

    // Also check lock age — stale if older than 1 hour regardless of PID
    const stale = false;
    {
      try {
        const lockStat = statSync(LOCK_FILE);
        const lockAgeMs = Date.now() - lockStat.mtimeMs;
        if (lockAgeMs > TIME_MS.HOUR) {
          console.warn(`[judge] Lock file is ${Math.round(lockAgeMs / TIME_MS.MINUTE)}min old, treating as stale`);
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

/** Safe exit that always attempts lock cleanup */
function safeExit(code: number): never {
  releaseLock();
  process.exit(code);
}

function writeEvaluations(evals: EvalRecord[]): void {
  // Write all evals to today's file so they appear in recent time-window queries.
  // The record's timestamp field still reflects the original turn time for accuracy.
  const today = new Date().toISOString().slice(0, 10);
  const outFile = join(TELEMETRY_DIR, `evaluations-${today}.jsonl`);
  const content = evals.map(e => JSON.stringify(toOTelRecord(e))).join('\n') + '\n';
  appendFileSync(outFile, content);
}

export async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  const settled = await Promise.allSettled(
    items.map(item => limit(async () => {
      const result = await fn(item);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      return result;
    })),
  );
  return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const seed = args.includes('--seed');
  const backfill = args.includes('--backfill');
  const limitIdx = args.indexOf('--limit');
  const limit = Infinity;
  if (limitIdx !== -1) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error('Error: --limit must be a positive integer');
      process.exit(1);
    }
    limit = Math.min(parsed, MAX_TURN_LIMIT);
  }

  // Optional dataset scoping: --dataset-id <uuid>
  const datasetIdx = args.indexOf('--dataset-id');
  const datasetId = datasetIdx !== -1 ? args[datasetIdx + 1] : undefined;

  // --backfill: generate seed evals from trace data for sessions missing transcripts
  if (backfill) {
    const traceTurns = await discoverSessionsFromTraces();
    console.log(`[backfill] Discovered ${traceTurns.length} sessions from trace files`);

    if (!acquireLock()) {
      console.error('Error: Another judge-evaluations process is running (lockfile exists)');
      process.exit(1);
    }

    try {
      const existingKeys = _loadExistingKeys();

      // Checking only hallucination would skip sessions with partial coverage.
      const SEED_METRICS = [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, HALLUCINATION_EVAL_NAME] as const;
      const newTurns = traceTurns.filter(t => {
        const turnKey = t.timestamp.slice(0, 19);
        return SEED_METRICS.some(m => !existingKeys.has(`${t.sessionId}:${m}:${turnKey}`));
      });
      console.log(`[backfill] ${newTurns.length} sessions need evaluations (${traceTurns.length - newTurns.length} already covered)`);

      if (newTurns.length === 0) return;

      const seedResult = seedEvaluations(newTurns, existingKeys);
      // Override evaluatorType for transparency — backfilled data is not organic seed
      for (const ev of seedResult.evals) {
        if (ev.evaluatorType === SEED_EVALUATOR_TYPE) {
          ev.evaluatorType = TRACE_BACKFILL_EVALUATOR_TYPE;
        }
      }

      if (seedResult.evals.length > 0) {
        writeEvaluations(seedResult.evals);
        const byCat = new Map<string, number>();
        for (const ev of seedResult.evals) {
          byCat.set(ev.evaluationName, (byCat.get(ev.evaluationName) ?? 0) + 1);
        }
        console.log(`[backfill] Wrote ${seedResult.evals.length} evaluations:`);
        for (const [name, count] of byCat) {
          console.log(`  ${name}: ${count}`);
        }
      }
    } finally {
      releaseLock();
    }
    return;
  }

  const transcripts = await _discoverTranscripts();

  const concurrencyLimit = pLimit(CONCURRENCY);
  const turnArrays = await Promise.all(transcripts.map(info => concurrencyLimit(() => extractTurns(info))));
  const allTurns = turnArrays.flat().slice(0, limit);

  if (dryRun) {
    // 2 base evals (relevance, coherence) + 3 with tools (faithfulness, hallucination, tool_correctness)
    const estEvals = allTurns.reduce((sum, t) =>
      sum + 2 + (t.toolResults.length > 0 ? 3 : 0), 0);
    // Estimate tokens from actual content length (~4 chars/token)
    const estInputTokens = allTurns.reduce((sum, t) => {
      const contentChars = t.userText.length + t.assistantText.length
        + t.toolResults.reduce((s, r) => s + r.length, 0);
      const evalsPerTurn = 2 + (t.toolResults.length > 0 ? 2 : 0);
      return sum + Math.ceil(contentChars * TOKENS_PER_CHAR) * evalsPerTurn;
    }, 0);
    const estOutputTokens = estEvals * 200;
    const haikuPricing = MODEL_PRICING[HAIKU_MODEL];
    const estCost = (estInputTokens / TOKENS_PER_MILLION) * haikuPricing.input
      + (estOutputTokens / TOKENS_PER_MILLION) * haikuPricing.output;

    console.log(`[dry-run] ${allTurns.length} turns → ${estEvals} evals`);
    console.log(`[dry-run] ~${estInputTokens.toLocaleString()} input tokens, ~${estOutputTokens.toLocaleString()} output tokens`);
    console.log(`[dry-run] estimated cost: $${estCost.toFixed(EVAL_SCORE_PRECISION)}`);

    const bySession = new Map<string, number>();
    for (const t of allTurns) {
      const sid = t.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
      bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
    }
    const sorted = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('[dry-run] top sessions by turn count:');
    for (const [sid, count] of sorted) {
      console.log(`  ${sid}: ${count} turns`);
    }
    return;
  }

  // Validate API key early (before expensive operations)
  if (!seed && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY required (or use --seed for offline mode)');
    process.exit(1);
  }

  // Acquire lock to prevent concurrent writes
  if (!acquireLock()) {
    console.error('Error: Another judge-evaluations process is running (lockfile exists)');
    process.exit(1);
  }

  try {
    const existingKeys = _loadExistingKeys();

    for (const key of Object.keys(evalFailures)) delete evalFailures[key];

    let flatEvals: EvalRecord[];

    if (seed) {
      const seedResult = seedEvaluations(allTurns, existingKeys);
      flatEvals = seedResult.evals;
    } else {
      const llm = await createAnthropicProvider();
      const judge = new LLMJudge(llm, {
        timeoutMs: TIME_MS.MINUTE,
        maxRetries: 2,
        evaluator: LLM_EVALUATOR_TYPE,
        evaluatorType: LLM_EVALUATOR_TYPE,
        logger: {
          warn: (msg) => console.warn(`  [warn] ${msg}`),
          error: (msg) => console.error(`  [error] ${msg}`),
        },
      });
      const allEvals = await processBatch(
        allTurns,
        CONCURRENCY,
        BATCH_DELAY_MS,
        (turn) => evaluateTurn(judge, turn, existingKeys),
      );

      flatEvals = allEvals.flat();
    }

    if (flatEvals.length === 0) {
      return;
    }

    writeEvaluations(flatEvals);

    if (datasetId) {
      // --dataset-id scoping: dataset run recording is not yet supported by the cloud backend API.
      // Evaluations are written to JSONL above; run metadata is skipped.
      console.warn(`[judge] --dataset-id=${datasetId}: dataset run recording not supported in cloud backend; evaluations written to JSONL only.`);
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
