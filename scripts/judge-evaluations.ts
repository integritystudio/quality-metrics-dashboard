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
  // Local hook JSONL uses HRT tuples, not the backend's epoch-nanos fields.
  // `backend-schemas.ts` exports a `traceSpanSchema` for the latter; importing
  // that one here would reject every line. See the note on LocalTraceSpan.
  localTraceSpanSchema,
  otelLogEntrySchema,
  transcriptEntrySchema,
  otelEvaluationRecordSchema,
  type EvaluatorType,
  type EvaluatorKind,
  type EvaluationCohort,
  HALLUCINATION_EVAL_NAME,
  LLM_EVALUATOR_TYPE,
} from '../../src/lib/validation/dashboard-schemas.js';
import { readJsonlWithValidationSync, streamJsonlWithValidation } from '../src/lib/dashboard-file-utils.js';
import { MODEL_PRICING, TOKENS_PER_CHAR, TOKENS_PER_MILLION } from '../../src/lib/core/constants-models.js';
import { TIME_MS, NANOSECONDS_PER_MILLISECOND_BIGINT } from '../../src/lib/core/units.js';
import { MAX_TEXT_LENGTH, MAX_CONTEXT_ITEMS } from '../../src/lib/judge/llm-judge-constants.js';
import { JUDGE_EXIT_BILLING, JUDGE_EXIT_NO_SCORES } from './pipeline-stages.js';
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
// Must match the producer: hooks/lib/constants.ts writes telemetry here.
export const TELEMETRY_DIR = join(HOME, '.claude-history', 'telemetry');
export const SESSION_ID_PREVIEW_LEN = 8;
export const EVAL_SCORE_PRECISION = 4;
/** Producer recorded on every record this script writes. */
export const PRODUCER = 'dashboard:judge-evaluations';
export const SEED_EVALUATOR: EvaluatorType = 'seed';
export const CANARY_EVALUATOR_TYPE = 'canary';
export const SEED_EVALUATOR_TYPE = 'seed';
export const RULE_EVALUATOR_TYPE = 'rule';
export const TRACE_BACKFILL_EVALUATOR_TYPE = 'trace-backfill';

/**
 * A seeded or canary score is a SHA-256 of the session and turn key mapped into
 * a range — deterministic and reproducible, with no model and no relationship
 * to the content being scored. That makes its *kind* `rule`; what marks it as
 * not-real-data is the cohort, never the kind (OBP16).
 */
export const SYNTHETIC_EVALUATOR_KIND: EvaluatorKind = 'rule';
export const LLM_EVALUATOR_KIND: EvaluatorKind = 'llm';

/**
 * The legacy `evaluatorType` value for a kind, or `undefined` when the kind has
 * none. Three of the four kinds are also members of the older enum; the fourth,
 * `ground_truth`, is not, and is left unset rather than coerced.
 */
function legacyEvaluatorType(kind: EvaluatorKind): EvaluatorType | undefined {
  return kind === 'ground_truth' ? undefined : kind;
}
export const NORMAL_COHORT: EvaluationCohort = 'normal';
export const SEED_COHORT: EvaluationCohort = 'seed';
export const CANARY_COHORT: EvaluationCohort = 'canary';
export const BACKFILL_COHORT: EvaluationCohort = 'backfill';
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

/**
 * On-disk attribute keys. **Must stay identical to `EVALUATION_ATTRS` in
 * `hooks/lib/quality-signals.ts`** — both writers append to the same
 * `evaluations-YYYY-MM-DD.jsonl` files, so a divergence splits the corpus into
 * two shapes that no single reader handles.
 *
 * `gen_ai.evaluation.evaluator{,.type}` were dropped here (OBP16): neither is
 * in the semconv registry, so they were local fields under an OpenTelemetry
 * namespace, and between them they carried four different facts.
 */
export const EVALUATION_ATTRS = {
  NAME: 'gen_ai.evaluation.name',
  SCORE_VALUE: 'gen_ai.evaluation.score.value',
  SCORE_UNIT: 'gen_ai.evaluation.score.unit',
  EXPLANATION: 'gen_ai.evaluation.explanation',
  EVALUATOR_KIND: 'integritystudio.evaluation.evaluator.kind',
  COHORT: 'integritystudio.evaluation.cohort',
  PRODUCER: 'integritystudio.evaluation.producer',
  JUDGE_MODEL: 'integritystudio.evaluation.judge.model',
  SESSION_ID: 'session.id',
} as const;

/** Legacy overloaded key, read-only — still present on every pre-OBP16 record. */
export const LEGACY_EVALUATOR_TYPE_ATTR = 'gen_ai.evaluation.evaluator.type';

export const EVALUATION_RESULT_EVENT = 'gen_ai.evaluation.result';

export function normalizeScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/**
 * Build one record.
 *
 * `kind` and `cohort` are separate arguments on purpose (OBP16). This function
 * previously took `(evaluator, evaluatorType)` and every caller passed a value
 * that was sometimes a kind and sometimes a cohort — so a hashed canary score
 * was written as `evaluator: 'llm'`, indistinguishable from a judged one. The
 * two axes cannot now be confused, and `judgeModel` is omitted for any score no
 * model produced.
 */
function createEvalRecord(
  turn: Turn,
  evaluationName: string,
  scoreValue: number,
  explanation: string,
  kind: EvaluatorKind,
  cohort: EvaluationCohort,
  judgeModel?: string,
): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName,
    scoreValue: normalizeScore(scoreValue),
    explanation,
    evaluator: PRODUCER,
    // Narrowed to the kind axis; the cohort has its own field now.
    ...(legacyEvaluatorType(kind) && { evaluatorType: legacyEvaluatorType(kind) }),
    evaluatorKind: kind,
    cohort,
    ...(judgeModel && { judgeModel }),
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

/** Canonical evaluation record. Also used by derive-evaluations.ts. */
export interface EvalRecord {
  timestamp: string;
  evaluationName: string;
  scoreValue: number;
  /** e.g. 'seconds', 'ratio_0_1'; omitted when the score is unitless. */
  scoreUnit?: string;
  explanation: string;
  /** Producer — which component wrote this. Never a model id (OBP16). */
  evaluator: string;
  /**
   * @deprecated Overloaded field, kept so the query/export surface keeps
   * filtering. Mirrors `evaluatorKind` where the two enums overlap, and is
   * omitted for `ground_truth`, which has no legacy value — mapping it onto one
   * would be the same misstatement OBP16 removed.
   */
  evaluatorType?: EvaluatorType;
  /** How the score was produced. */
  evaluatorKind: EvaluatorKind;
  /** Whether the score describes real data. */
  cohort: EvaluationCohort;
  /** Judge model — omitted for any score no model produced. */
  judgeModel?: string;
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
      if (attrs?.['integritystudio.hook.name'] !== HOOK_NAME.TOKEN_METRICS) continue;

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

    for await (const span of streamJsonlWithValidation(filepath, localTraceSpanSchema)) {
      const attrs = span.attributes;

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
          SYNTHETIC_EVALUATOR_KIND,
          canary ? CANARY_COHORT : SEED_COHORT,
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
          SYNTHETIC_EVALUATOR_KIND,
          canary ? CANARY_COHORT : SEED_COHORT,
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
            SYNTHETIC_EVALUATOR_KIND,
            canary ? CANARY_COHORT : SEED_COHORT,
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
            SYNTHETIC_EVALUATOR_KIND,
            canary ? CANARY_COHORT : SEED_COHORT,
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
            SYNTHETIC_EVALUATOR_KIND,
            canary ? CANARY_COHORT : SEED_COHORT,
          ),
        );
      }
    }
  }

  return { evals, canaryCount };
}

/** Track evaluation failures for summary reporting */
export const evalFailures: Record<string, number> = {};

export type JudgeFailureClass = 'billing' | 'network' | 'parse' | 'invalid-input' | 'other';
export const JUDGE_FAILURE_CLASSES: readonly JudgeFailureClass[] = ['billing', 'network', 'parse', 'invalid-input', 'other'];

/** Failures by cause across all metrics — what decides the exit code. */
export const failureClasses: Record<JudgeFailureClass, number> = { billing: 0, network: 0, parse: 0, 'invalid-input': 0, other: 0 };

const BILLING_FAILURE_PATTERN = /credit balance|billing|payment required|insufficient (?:funds|credit)/i;
const NETWORK_FAILURE_PATTERN = /Connection error|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed out/i;
const INVALID_INPUT_FAILURE_PATTERN = /Invalid TestCase|Invalid GEvalConfig/;
const PARSE_FAILURE_PATTERN = /below minimum|not valid JSON|Unexpected token|Invalid normalized score|Could not (?:extract|parse)/i;

/** Bucket a judge error by what would fix it: money, the network, the parser, or the input this script built. */
export function classifyJudgeFailure(message: string): JudgeFailureClass {
  if (BILLING_FAILURE_PATTERN.test(message)) return 'billing';
  if (NETWORK_FAILURE_PATTERN.test(message)) return 'network';
  if (INVALID_INPUT_FAILURE_PATTERN.test(message)) return 'invalid-input';
  if (PARSE_FAILURE_PATTERN.test(message)) return 'parse';
  return 'other';
}

export function resetFailureTracking(): void {
  for (const key of Object.keys(evalFailures)) delete evalFailures[key];
  for (const cls of JUDGE_FAILURE_CLASSES) failureClasses[cls] = 0;
}

function trackFailure(metric: string, err: unknown): void {
  evalFailures[metric] = (evalFailures[metric] ?? 0) + 1;
  failureClasses[classifyJudgeFailure(err instanceof Error ? err.message : String(err))] += 1;
}

/** Appended when a context item is cut to fit the judge's schema. */
export const CONTEXT_TRUNCATION_MARKER = '\n…[truncated to fit the judge input cap]';

/**
 * Fit tool results to what `testCaseSchema` accepts: at most the smaller of
 * MAX_TOOL_CONTEXT_ITEMS / MAX_CONTEXT_ITEMS entries, each at most
 * MAX_TEXT_LENGTH characters. Before this, one oversized tool result failed
 * every metric for its turn with "Invalid TestCase … too_big" — 60 of the 480
 * failures in every scheduled run from 2026-09-16 on.
 */
export function fitContextForJudge(toolResults: readonly string[]): string[] {
  const itemLimit = Math.min(MAX_TOOL_CONTEXT_ITEMS, MAX_CONTEXT_ITEMS);
  return toolResults.slice(0, itemLimit).map(item =>
    item.length <= MAX_TEXT_LENGTH
      ? item
      : item.slice(0, MAX_TEXT_LENGTH - CONTEXT_TRUNCATION_MARKER.length) + CONTEXT_TRUNCATION_MARKER,
  );
}

export interface JudgeRunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  byClass: Record<JudgeFailureClass, number>;
  /** 0 when the run produced scores and saw no billing refusal. */
  exitCode: number;
  /** The one line the log gets, verdict included. */
  line: string;
}

/**
 * What the run did and how loudly to say so. A billing refusal wins — nothing
 * else in the run can be trusted and the fix is external. A run that attempted
 * evaluations and produced none is the other failure the pipeline used to
 * report as success: every scheduled run from 2026-09-16 to 09-19 did exactly
 * that while the launchd log said "completed".
 */
export function summarizeJudgeRun(
  succeeded: number,
  byMetric: Record<string, number>,
  byClass: Record<JudgeFailureClass, number>,
): JudgeRunSummary {
  const failed = Object.values(byMetric).reduce((sum, n) => sum + n, 0);
  const attempted = succeeded + failed;
  const classes = JUDGE_FAILURE_CLASSES.filter(c => byClass[c] > 0).map(c => `${c}=${byClass[c]}`).join(' ') || 'none';
  let exitCode = 0;
  let verdict = 'ok';
  if (byClass.billing > 0) {
    exitCode = JUDGE_EXIT_BILLING;
    verdict = 'BILLING REFUSED — no judge output from this run can be trusted; top up credit before re-running';
  } else if (attempted > 0 && succeeded === 0) {
    exitCode = JUDGE_EXIT_NO_SCORES;
    verdict = 'NO SCORES PRODUCED — every evaluation failed';
  }
  const line = `[judge] summary: attempted=${attempted} succeeded=${succeeded} failed=${failed} classes: ${classes} — ${verdict}`;
  return { attempted, succeeded, failed, byClass: { ...byClass }, exitCode, line };
}

export async function evaluateTurn(
  judge: LLMJudge,
  turn: Turn,
  existingKeys: Set<string>,
): Promise<EvalRecord[]> {
  const evals: EvalRecord[] = [];
  const turnKey = turn.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN);
  const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
  const toolContext = fitContextForJudge(turn.toolResults);

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
          LLM_EVALUATOR_KIND,
          NORMAL_COHORT,
          HAIKU_MODEL,
        ),
      );
    } catch (err) {
      trackFailure(RELEVANCE_EVAL_NAME, err);
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
          LLM_EVALUATOR_KIND,
          NORMAL_COHORT,
          HAIKU_MODEL,
        ),
      );
    } catch (err) {
      trackFailure(COHERENCE_EVAL_NAME, err);
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
            LLM_EVALUATOR_KIND,
            NORMAL_COHORT,
            HAIKU_MODEL,
          ),
        );
      } catch (err) {
        trackFailure(FAITHFULNESS_EVAL_NAME, err);
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
            LLM_EVALUATOR_KIND,
            NORMAL_COHORT,
            HAIKU_MODEL,
          ),
        );
      } catch (err) {
        trackFailure(HALLUCINATION_EVAL_NAME, err);
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
            LLM_EVALUATOR_KIND,
            NORMAL_COHORT,
            HAIKU_MODEL,
          ),
        );
      } catch (err) {
        trackFailure(TOOL_CORRECTNESS_CRITERIA.name, err);
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
              LLM_EVALUATOR_KIND,
              NORMAL_COHORT,
              HAIKU_MODEL,
            ),
          );
        } catch (err) {
          trackFailure(name, err);
          console.warn(`  [${name}] Error for ${sessionPreview}: ${(err as Error).message}`);
        }
      }
    }
  }

  return evals;
}

export function toOTelRecord(ev: EvalRecord): object {
  const attrs: Record<string, unknown> = {
    [EVALUATION_ATTRS.NAME]: ev.evaluationName,
    [EVALUATION_ATTRS.SCORE_VALUE]: ev.scoreValue,
    [EVALUATION_ATTRS.EXPLANATION]: ev.explanation,
    [EVALUATION_ATTRS.EVALUATOR_KIND]: ev.evaluatorKind,
    [EVALUATION_ATTRS.COHORT]: ev.cohort,
    [EVALUATION_ATTRS.PRODUCER]: ev.evaluator,
    ...(ev.judgeModel && { [EVALUATION_ATTRS.JUDGE_MODEL]: ev.judgeModel }),
  };
  if (ev.scoreUnit) attrs[EVALUATION_ATTRS.SCORE_UNIT] = ev.scoreUnit;
  if (ev.sessionId) attrs[EVALUATION_ATTRS.SESSION_ID] = ev.sessionId;
  return {
    timestamp: ev.timestamp,
    name: EVALUATION_RESULT_EVENT,
    attributes: attrs,
    // Omit rather than emit '' — TraceIdSchema is optional but rejects an
    // empty string, so a written '' is silently dropped on read.
    ...(ev.traceId && { traceId: ev.traceId }),
    // Org-scoping P4: local derive/judge read the owner's own telemetry JSONL,
    // which carries no org dimension — everything they emit is by definition
    // the home org's data, so stamp the constant rather than "group by org"
    // (docs/roadmap/org-scoped-multi-tenancy.md, Phase 4). Omitted when the
    // env is unset so pre-tenancy behavior is byte-identical.
    ...(process.env.HOME_ORG_ID && { org_id: process.env.HOME_ORG_ID }),
  };
}

/**
 * Whether a record on disk is one this script produced, and therefore counts
 * toward dedup.
 *
 * **Dual-read, deliberately.** The 780,921 records written before OBP16 carry
 * the overloaded `gen_ai.evaluation.evaluator.type`, holding a kind for judged
 * rows and a cohort for seeded ones; records written after it carry
 * `integritystudio.evaluation.cohort` instead. Neither set is being
 * backfilled, so a reader that knows only one shape either re-judges every
 * historical turn or re-seeds every new one — both duplicate silently.
 */
function isThisScriptsRecord(attrs: Record<string, unknown>): boolean {
  const cohort = attrs[EVALUATION_ATTRS.COHORT];
  if (typeof cohort === 'string') {
    // Post-OBP16: judged rows are the NORMAL cohort, the rest are ours by cohort.
    return cohort === NORMAL_COHORT || cohort === SEED_COHORT || cohort === BACKFILL_COHORT;
  }
  const legacy = attrs[LEGACY_EVALUATOR_TYPE_ATTR];
  return legacy === LLM_EVALUATOR_TYPE
    || legacy === SEED_EVALUATOR_TYPE
    || legacy === TRACE_BACKFILL_EVALUATOR_TYPE;
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
      if (!isThisScriptsRecord(attrs)) continue;

      const sessionId = attrs[EVALUATION_ATTRS.SESSION_ID] as string || '';
      const metricName = attrs[EVALUATION_ATTRS.NAME] as string || '';
      // record.timestamp is epoch nanos (bigint) — the schema decodes ISO to nanos.
      // Turn keys are compared against ISO-prefix keys, so convert back.
      const ms = Number(record.timestamp / NANOSECONDS_PER_MILLISECOND_BIGINT);
      const turnKey = new Date(ms).toISOString().slice(0, TIMESTAMP_TURN_KEY_LEN);

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
    let stale = false;
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
  let limit = Infinity;
  if (limitIdx !== -1) {
    const parsed = parseInt(args[limitIdx + 1] ?? '', 10);
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
        const turnKey = t.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN);
        return SEED_METRICS.some(m => !existingKeys.has(`${t.sessionId}:${m}:${turnKey}`));
      });
      console.log(`[backfill] ${newTurns.length} sessions need evaluations (${traceTurns.length - newTurns.length} already covered)`);

      if (newTurns.length === 0) return;

      const seedResult = seedEvaluations(newTurns, existingKeys);
      // Backfilled data is not organic seed, so re-cohort it. The cohort axis
      // owns this now — `evaluatorType` keeps the kind and is left alone
      // (OBP16); previously this line overwrote a kind with a cohort value.
      for (const ev of seedResult.evals) {
        if (ev.cohort === SEED_COHORT) {
          ev.cohort = BACKFILL_COHORT;
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
    if (!haikuPricing) throw new Error(`No pricing data for model ${HAIKU_MODEL}`);
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

    resetFailureTracking();

    let flatEvals: EvalRecord[];

    if (seed) {
      const seedResult = seedEvaluations(allTurns, existingKeys);
      flatEvals = seedResult.evals;
    } else {
      const llm = await createAnthropicProvider();
      const judge = new LLMJudge(llm, {
        timeoutMs: TIME_MS.MINUTE,
        maxRetries: 2,
        evaluator: PRODUCER,
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

      const summary = summarizeJudgeRun(flatEvals.length, evalFailures, failureClasses);
      (summary.exitCode === 0 ? console.log : console.error)(summary.line);
      if (summary.exitCode !== 0) {
        // Set rather than exit: the finally below must still release the lock,
        // and populate-dashboard.ts reads this code to keep upload + sync running.
        process.exitCode = summary.exitCode;
      }
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
