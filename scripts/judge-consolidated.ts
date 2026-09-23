/**
 * Consolidated LLM-as-Judge: one call per turn carrying every applicable criterion.
 *
 * The per-criterion path (`evaluateTurn` in judge-evaluations.ts) sends a
 * turn's user text, assistant text and tool results once per criterion. This
 * module sends the turn content ONCE, together with every applicable
 * criterion — the same criteria text and the same model-generated evaluation
 * steps the per-criterion path uses — and asks for one JSON object keyed by
 * criterion through `output_config` (structured outputs). It then produces
 * the same records the per-criterion path produces: same evaluation names,
 * 1–5 → 0–1 normalization, dedup keys, cohort and judge model — but its OWN
 * producer, see CONSOLIDATED_PRODUCER.
 *
 * Where it differs from the per-criterion path, and why:
 * - `faithfulness` is scored from FAITHFULNESS_CRITERIA, not from QAG, and
 *   `hallucination` is `1 - faithfulness` from that same verdict. The
 *   per-criterion path no longer does either: it runs one QAG sweep and scores
 *   `faithfulness` and `hallucination` as separate tallies over it, so its two
 *   series do not sum to 1 and this one's do. That is a second source of the
 *   disagreement between the two modes. `directHallucination`
 *   (ConsolidatedCriteriaOptions) judges it on its own criterion instead; it is
 *   opt-in and nothing in production sets it.
 * - Evaluation steps depend only on the criteria text, so they are generated
 *   once per criterion per run (`EvaluationStepsCache`) rather than per call.
 * - No `judge.method` attribute is written: `EvalRecord` has no slot for extra
 *   attributes and `toOTelRecord` emits fixed keys, so the record schema does
 *   not allow one. `evaluator` (the producer) carries the distinction instead
 *   — see CONSOLIDATED_PRODUCER.
 *
 * The default since 2026-09-22 (JCP4): against a claude-opus-5 reference on 25
 * real turns it was closer than the per-criterion path (MAE 0.945 vs 1.223 of
 * 5, docs/judge-quality-2026-09-22.json) at ~1/10 the cost. `--per-criterion`
 * in judge-evaluations.ts opts back out; `--batch` routes this path through
 * the Message Batches provider (`adaptBatchProvider`, JCP3).
 * Agreement with the per-criterion path is measured by judge-agreement.ts,
 * distance from a reference by judge-quality-eval.ts.
 */

import type { GEvalConfig } from '../../src/lib/judge/llm-as-judge.js';
import type { BatchLLMProvider } from './judge-batch-provider.js';
import { sanitizeForPrompt, sanitizeContextArray, safeJSONParse } from '../../src/lib/judge/llm-as-judge.js';
import { normalizeEvaluationSteps } from '../../src/lib/judge/llm-judge-geval.js';
import {
  RELEVANCE_CRITERIA,
  FAITHFULNESS_CRITERIA,
  HALLUCINATION_CRITERIA,
  COHERENCE_CRITERIA,
} from '../../src/lib/judge/llm-judge-config.js';
import {
  G_EVAL_MIN_SCORE,
  G_EVAL_MAX_SCORE,
  G_EVAL_SCORE_RANGE,
  G_EVAL_VALID_SCORES,
  G_EVAL_MIN_STEPS,
  G_EVAL_MAX_STEPS,
  LLM_TEMPERATURE_EVALUATION,
} from '../../src/lib/judge/llm-judge-constants.js';
import { HALLUCINATION_EVAL_NAME, LLM_EVALUATOR_TYPE } from '../../src/lib/validation/dashboard-schemas.js';
import {
  type Turn,
  type EvalRecord,
  RELEVANCE_EVAL_NAME,
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  TOOL_CORRECTNESS_CRITERIA,
  TOOL_SELECTION_CRITERIA,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
  LLM_EVALUATOR_KIND,
  NORMAL_COHORT,
  HAIKU_MODEL,
  JUDGE_MAX_TOKENS,
  JUDGE_DEFAULT_TEMPERATURE,
  TIMESTAMP_TURN_KEY_LEN,
  SESSION_ID_PREVIEW_LEN,
  SCORE_PREVIEW_DECIMALS,
  normalizeScore,
  fitContextForJudge,
  evalFailures,
  failureClasses,
  classifyJudgeFailure,
  turnSourceFields,
} from './judge-evaluations.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Output budget for one consolidated verdict: up to seven criteria, each with reasoning. */
export const CONSOLIDATED_MAX_TOKENS = 4096;
export const REASONING_KEY = 'reasoning';
export const SCORE_KEY = 'score';
/**
 * Producer written on every record this module builds.
 *
 * Deliberately NOT the per-criterion path's `PRODUCER`. The two paths measure
 * `faithfulness` and `hallucination` with different instruments — G-Eval and an
 * inversion here, a QAG sweep and a fabrication tally there — so records from
 * the two are not interchangeable samples of one series. They were nevertheless
 * written under the same producer string until 2026-09-22, which made the
 * instrument switch at the JCP4 cutover invisible in the stored data: same
 * evaluation name, same cohort, same evaluator kind, same judge model, nothing
 * to join or filter on. This is the only field in `EvalRecord` free enough to
 * carry that, and nothing filters or groups on its value.
 */
export const CONSOLIDATED_PRODUCER = 'dashboard:judge-consolidated';

const REASONING_DESCRIPTION = 'Your reasoning for this criterion, written before the score.';
const SCORE_DESCRIPTION = `Integer score from ${G_EVAL_MIN_SCORE} to ${G_EVAL_MAX_SCORE}.`;
const JSON_SCHEMA_OUTPUT_FORMAT = 'json_schema';
const MAX_TOKENS_STOP_REASON = 'max_tokens';
const VALID_SCORE_SET: ReadonlySet<number> = new Set<number>(G_EVAL_VALID_SCORES);
/** Tool sub-criteria, judged only alongside tool_correctness — mirrors `evaluateTurn`. */
const TOOL_SUB_CRITERIA: readonly GEvalConfig[] = [
  TOOL_SELECTION_CRITERIA,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
];

const [, G_EVAL_SECOND_SCORE, G_EVAL_THIRD_SCORE, G_EVAL_FOURTH_SCORE] = G_EVAL_VALID_SCORES;

/** Verbatim from `buildEvalPrompt` (src/lib/judge/llm-judge-geval.ts). */
const SCORE_ANCHORING_LINES: readonly string[] = [
  `  ${G_EVAL_MIN_SCORE} = Completely fails the criteria; output is irrelevant, incoherent, or harmful`,
  `  ${G_EVAL_SECOND_SCORE} = Major deficiencies; significant portions fail the criteria`,
  `  ${G_EVAL_THIRD_SCORE} = Adequate; meets basic expectations but has notable issues`,
  `  ${G_EVAL_FOURTH_SCORE} = Good; meets criteria well with only minor issues`,
  `  ${G_EVAL_MAX_SCORE} = Excellent; fully meets all criteria with no meaningful issues`,
];

const PARAM_LABELS: Record<GEvalConfig['evaluationParams'][number], string> = {
  input: 'Input',
  output: 'Output',
  context: 'Context',
  expectedOutput: 'Expected Output',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JudgeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type JsonSchemaObject = Record<string, unknown>;

export interface ConsolidatedGenerateOptions {
  /** When set, the call is made with `output_config.format` = this JSON schema. */
  schema?: JsonSchemaObject;
  temperature?: number;
}

export interface ConsolidatedResponse {
  text: string;
  usage?: JudgeTokenUsage;
}

/** Text provider that can also constrain output to a JSON schema. */
export interface ConsolidatedProvider {
  generate(prompt: string, options?: ConsolidatedGenerateOptions): Promise<ConsolidatedResponse>;
}

/** Evaluation steps per criterion name, shared across a run. Promises dedupe concurrent misses. */
export type EvaluationStepsCache = Map<string, Promise<string>>;

export interface CriterionVerdict {
  reasoning: string;
  score: number;
}

export interface PreparedCriterion {
  config: GEvalConfig;
  steps: string;
}

export interface ConsolidatedSelection {
  /** Criteria the prompt and schema carry, in prompt order. */
  criteria: GEvalConfig[];
  /** Evaluation names to emit records for, in the per-criterion path's order. */
  recordNames: string[];
}

/**
 * Opt-in variants of the consolidated call. Production passes none, so its
 * records are unchanged; judge-hallucination-eval.ts scores the variant.
 */
export interface ConsolidatedCriteriaOptions {
  /**
   * Judge `hallucination` with HALLUCINATION_CRITERIA as a criterion of its own
   * in the same call, instead of inverting the faithfulness verdict. Off until
   * the eval JUDGE-HALLUCINATION-INVERTED-ON-DEFAULT gates on has run.
   */
  directHallucination?: boolean;
}

export interface ParsedConsolidatedResponse {
  verdicts: Map<string, CriterionVerdict>;
  failures: Map<string, Error>;
}

// ---------------------------------------------------------------------------
// Selection — mirrors evaluateTurn's dedup keys and gating exactly
// ---------------------------------------------------------------------------

/**
 * The criterion a record's score comes from: hallucination is derived from
 * faithfulness unless it is judged directly.
 */
export function sourceCriterionName(recordName: string, options: ConsolidatedCriteriaOptions = {}): string {
  if (options.directHallucination) return recordName;
  return recordName === HALLUCINATION_EVAL_NAME ? FAITHFULNESS_EVAL_NAME : recordName;
}

export function selectCriteria(
  turn: Turn,
  existingKeys: Set<string>,
  options: ConsolidatedCriteriaOptions = {},
): ConsolidatedSelection {
  const turnKey = turn.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN);
  const missing = (name: string): boolean => !existingKeys.has(`${turn.sessionId}:${name}:${turnKey}`);
  const criteria: GEvalConfig[] = [];
  const recordNames: string[] = [];

  if (missing(RELEVANCE_EVAL_NAME)) {
    criteria.push(RELEVANCE_CRITERIA);
    recordNames.push(RELEVANCE_EVAL_NAME);
  }
  if (missing(COHERENCE_EVAL_NAME)) {
    criteria.push(COHERENCE_CRITERIA);
    recordNames.push(COHERENCE_EVAL_NAME);
  }

  if (turn.toolResults.length > 0) {
    const needsFaith = missing(FAITHFULNESS_EVAL_NAME);
    const needsHal = missing(HALLUCINATION_EVAL_NAME);
    if (options.directHallucination) {
      if (needsFaith) criteria.push(FAITHFULNESS_CRITERIA);
      if (needsHal) criteria.push(HALLUCINATION_CRITERIA);
    } else if (needsFaith || needsHal) {
      criteria.push(FAITHFULNESS_CRITERIA);
    }
    if (needsFaith) recordNames.push(FAITHFULNESS_EVAL_NAME);
    if (needsHal) recordNames.push(HALLUCINATION_EVAL_NAME);

    if (missing(TOOL_CORRECTNESS_CRITERIA.name)) {
      criteria.push(TOOL_CORRECTNESS_CRITERIA);
      recordNames.push(TOOL_CORRECTNESS_CRITERIA.name);
      for (const config of TOOL_SUB_CRITERIA) {
        if (!missing(config.name)) continue;
        criteria.push(config);
        recordNames.push(config.name);
      }
    }
  }

  return { criteria, recordNames };
}

// ---------------------------------------------------------------------------
// Schema and prompt
// ---------------------------------------------------------------------------

/** JSON schema for `output_config.format`: one required key per selected criterion, reasoning before score. */
export function buildConsolidatedSchema(criterionNames: readonly string[]): JsonSchemaObject {
  const verdictSchema: JsonSchemaObject = {
    type: 'object',
    properties: {
      [REASONING_KEY]: { type: 'string', description: REASONING_DESCRIPTION },
      [SCORE_KEY]: { type: 'integer', enum: [...G_EVAL_VALID_SCORES], description: SCORE_DESCRIPTION },
    },
    required: [REASONING_KEY, SCORE_KEY],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: Object.fromEntries(criterionNames.map(name => [name, verdictSchema])),
    required: [...criterionNames],
    additionalProperties: false,
  };
}

/** Verbatim from `gEval` (src/lib/judge/llm-judge-geval.ts) so the steps are generated the same way. */
export function buildStepsPrompt(sanitizedCriteria: string): string {
  return `
Given the criteria: ${sanitizedCriteria}
Generate detailed evaluation steps to assess this criterion.
List ${G_EVAL_MIN_STEPS}-${G_EVAL_MAX_STEPS} specific steps the evaluator should follow.
Each step must be verifiable from the provided text only. Do not include steps that require external knowledge, code execution, or runtime behavior inference.
Format: a plain numbered list, one step per line ("1. ...", "2. ..."). No JSON, no code fences, no preamble.
`;
}

/**
 * One prompt: the turn content once, then every criterion with its criteria
 * text and evaluation steps, then the per-criterion path's score anchoring.
 */
export function buildConsolidatedPrompt(
  turn: Turn,
  toolContext: readonly string[],
  prepared: readonly PreparedCriterion[],
): string {
  const usesParam = (param: GEvalConfig['evaluationParams'][number]): boolean =>
    prepared.some(p => p.config.evaluationParams.includes(param));
  const names = prepared.map(p => p.config.name);

  const parts: string[] = [
    `You are evaluating one assistant turn against ${prepared.length} criteria: ${names.join(', ')}.`,
    'Judge every criterion independently, using only the material below. Each criterion lists which parts it applies to.',
  ];

  if (usesParam('input')) {
    parts.push(`\nInput: ${sanitizeForPrompt(turn.userText)}`);
  }
  if (usesParam('output')) {
    parts.push(`\nOutput: ${sanitizeForPrompt(turn.assistantText)}`);
  }
  if (usesParam('context') && toolContext.length > 0) {
    parts.push(`\nContext: ${sanitizeContextArray([...toolContext]).join('\n')}`);
  }

  for (const { config, steps } of prepared) {
    parts.push(`\nCriterion: ${config.name}`);
    parts.push(`Applies to: ${config.evaluationParams.map(param => PARAM_LABELS[param]).join(', ')}`);
    parts.push(`Criteria: ${config.criteria}`);
    parts.push(`Evaluation Steps:\n${steps}`);
  }

  parts.push('\nScore anchoring:');
  parts.push(...SCORE_ANCHORING_LINES);
  parts.push(
    `\nFor every criterion, write your ${REASONING_KEY} first and then give an integer ${SCORE_KEY} from ${G_EVAL_MIN_SCORE}-${G_EVAL_MAX_SCORE}. `
    + `Respond with one JSON object whose keys are exactly: ${names.join(', ')}.`,
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluation steps
// ---------------------------------------------------------------------------

export async function generateEvaluationSteps(provider: ConsolidatedProvider, config: GEvalConfig): Promise<string> {
  const response = await provider.generate(
    buildStepsPrompt(sanitizeForPrompt(config.criteria)),
    { temperature: config.temperature ?? LLM_TEMPERATURE_EVALUATION },
  );
  const normalized = normalizeEvaluationSteps(response.text);
  if (normalized.steps.length < G_EVAL_MIN_STEPS) {
    throw new Error(`Generated evaluation steps below minimum (got ${normalized.steps.length}, require ${G_EVAL_MIN_STEPS})`);
  }
  return normalized.text;
}

export function cachedEvaluationSteps(
  provider: ConsolidatedProvider,
  config: GEvalConfig,
  cache: EvaluationStepsCache,
): Promise<string> {
  const cached = cache.get(config.name);
  if (cached) return cached;
  const pending = generateEvaluationSteps(provider, config).catch((err: unknown) => {
    // A failed generation is not cached — the next turn retries it.
    cache.delete(config.name);
    throw err;
  });
  cache.set(config.name, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

export function validateVerdict(name: string, value: unknown): CriterionVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Could not parse verdict for ${name}: missing or not an object`);
  }
  const { [REASONING_KEY]: reasoning, [SCORE_KEY]: score } = value as Record<string, unknown>;
  if (typeof score !== 'number' || !Number.isInteger(score) || !VALID_SCORE_SET.has(score)) {
    throw new Error(
      `Invalid normalized score for ${name}: ${String(score)} is not an integer in ${G_EVAL_MIN_SCORE}-${G_EVAL_MAX_SCORE}`,
    );
  }
  return { reasoning: typeof reasoning === 'string' ? reasoning : '', score };
}

/** Parse the model's JSON with `safeJSONParse`; a bad document throws, a bad criterion lands in `failures`. */
export function parseConsolidatedResponse(text: string, criterionNames: readonly string[]): ParsedConsolidatedResponse {
  const parsed = safeJSONParse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const shape = Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(`Could not parse consolidated verdict: expected a JSON object, got ${shape}`);
  }
  const record = parsed as Record<string, unknown>;
  const verdicts = new Map<string, CriterionVerdict>();
  const failures = new Map<string, Error>();
  for (const name of criterionNames) {
    try {
      verdicts.set(name, validateVerdict(name, record[name]));
    } catch (err) {
      failures.set(name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { verdicts, failures };
}

// ---------------------------------------------------------------------------
// Records — mirrors createEvalRecord in judge-evaluations.ts for kind 'llm'
// ---------------------------------------------------------------------------

/** G-Eval's normalization: (score - min) / range. */
export function toNormalizedScore(score: number): number {
  return (score - G_EVAL_MIN_SCORE) / G_EVAL_SCORE_RANGE;
}

function buildRecord(turn: Turn, evaluationName: string, scoreValue: number, explanation: string): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName,
    scoreValue: normalizeScore(scoreValue),
    explanation,
    evaluator: CONSOLIDATED_PRODUCER,
    evaluatorType: LLM_EVALUATOR_TYPE,
    evaluatorKind: LLM_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    judgeModel: HAIKU_MODEL,
    traceId: turn.traceId,
    sessionId: turn.sessionId,
    ...turnSourceFields(turn),
  };
}

/** Mirrors the per-criterion path's failure bookkeeping (trackFailure + warn line). */
function trackFailure(metric: string, sessionPreview: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  evalFailures[metric] = (evalFailures[metric] ?? 0) + 1;
  failureClasses[classifyJudgeFailure(message)] += 1;
  console.warn(`  [${metric}] Error for ${sessionPreview}: ${message}`);
}

// ---------------------------------------------------------------------------
// Turn evaluation
// ---------------------------------------------------------------------------

export async function evaluateTurnConsolidated(
  provider: ConsolidatedProvider,
  turn: Turn,
  existingKeys: Set<string>,
  stepsCache: EvaluationStepsCache = new Map(),
  options: ConsolidatedCriteriaOptions = {},
): Promise<EvalRecord[]> {
  const selection = selectCriteria(turn, existingKeys, options);
  if (selection.criteria.length === 0) return [];

  const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
  const toolContext = fitContextForJudge(turn.toolResults);
  const recordNamesFor = (criterionName: string): string[] =>
    selection.recordNames.filter(name => sourceCriterionName(name, options) === criterionName);

  // Steps are per criterion; a criterion whose steps fail drops out of this
  // turn alone, as it would on the per-criterion path.
  const prepared: PreparedCriterion[] = [];
  const stepResults = await Promise.allSettled(
    selection.criteria.map(config => cachedEvaluationSteps(provider, config, stepsCache)),
  );
  stepResults.forEach((result, i) => {
    const config = selection.criteria[i]!;
    if (result.status === 'fulfilled') {
      prepared.push({ config, steps: result.value });
      return;
    }
    for (const name of recordNamesFor(config.name)) trackFailure(name, sessionPreview, result.reason);
  });
  if (prepared.length === 0) return [];

  const names = prepared.map(p => p.config.name);
  const wanted = selection.recordNames.filter(name => names.includes(sourceCriterionName(name, options)));

  let parsed: ParsedConsolidatedResponse;
  try {
    const prompt = buildConsolidatedPrompt(turn, toolContext, prepared);
    const response = await provider.generate(prompt, {
      schema: buildConsolidatedSchema(names),
      temperature: LLM_TEMPERATURE_EVALUATION,
    });
    parsed = parseConsolidatedResponse(response.text, names);
  } catch (err) {
    for (const name of wanted) trackFailure(name, sessionPreview, err);
    return [];
  }

  const records: EvalRecord[] = [];
  for (const name of wanted) {
    const source = sourceCriterionName(name, options);
    const verdict = parsed.verdicts.get(source);
    if (!verdict) {
      trackFailure(name, sessionPreview, parsed.failures.get(source) ?? new Error(`Could not parse verdict for ${source}`));
      continue;
    }
    const normalized = toNormalizedScore(verdict.score);
    // Hallucination is stored higher-is-worse and both of its sources grade 5 = best:
    // by default the faithfulness verdict (this path's own convention, see the
    // header), under directHallucination HALLUCINATION_CRITERIA's 5 = no fabrication.
    const score = name === HALLUCINATION_EVAL_NAME ? 1 - normalized : normalized;
    const explanation = verdict.reasoning.trim()
      || `${name}: ${score.toFixed(SCORE_PREVIEW_DECIMALS)} for session ${sessionPreview}`;
    records.push(buildRecord(turn, name, score, explanation));
  }
  return records;
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export interface ConsolidatedProviderOptions {
  /** Explicit key; when absent the SDK resolves ANTHROPIC_API_KEY itself. */
  apiKey?: string;
  /** Called with every response's usage — how judge-agreement.ts totals tokens. */
  onUsage?: (usage: JudgeTokenUsage) => void;
}

interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export function toJudgeTokenUsage(usage: AnthropicUsageLike): JudgeTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export async function createConsolidatedProvider(options: ConsolidatedProviderOptions = {}): Promise<ConsolidatedProvider> {
  // Dynamic import, as in judge-evaluations.ts: the SDK is only needed for a real run.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();

  return {
    async generate(prompt: string, generateOptions: ConsolidatedGenerateOptions = {}): Promise<ConsolidatedResponse> {
      const { schema, temperature } = generateOptions;
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: schema ? CONSOLIDATED_MAX_TOKENS : JUDGE_MAX_TOKENS,
        temperature: temperature ?? JUDGE_DEFAULT_TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
        ...(schema && { output_config: { format: { type: JSON_SCHEMA_OUTPUT_FORMAT, schema } } }),
      });

      const usage = toJudgeTokenUsage(response.usage);
      options.onUsage?.(usage);

      if (response.stop_reason === MAX_TOKENS_STOP_REASON) {
        throw new Error(`Could not parse consolidated verdict: response truncated at ${MAX_TOKENS_STOP_REASON}`);
      }
      const text = response.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
      return { text, usage };
    },
  };
}

/** What judge-evaluations.ts hands to processBatch in place of evaluateTurn on the synchronous path. */
export async function createConsolidatedTurnEvaluator(
  existingKeys: Set<string>,
  options: ConsolidatedProviderOptions = {},
): Promise<(turn: Turn) => Promise<EvalRecord[]>> {
  const provider = await createConsolidatedProvider(options);
  const stepsCache: EvaluationStepsCache = new Map();
  return (turn: Turn) => evaluateTurnConsolidated(provider, turn, existingKeys, stepsCache);
}

// ---------------------------------------------------------------------------
// Batch path (JCP3)
// ---------------------------------------------------------------------------

/**
 * The Message Batches provider behind the consolidated interface. A schema
 * call gets CONSOLIDATED_MAX_TOKENS, as on the synchronous provider. Usage is
 * reported by the batch provider's own `onUsage`, so none is returned here.
 * The batch result carries no stop reason, so a verdict truncated at
 * max_tokens surfaces as the parse failure it produces rather than by name.
 */
export function adaptBatchProvider(batch: BatchLLMProvider): ConsolidatedProvider {
  return {
    async generate(prompt: string, options: ConsolidatedGenerateOptions = {}): Promise<ConsolidatedResponse> {
      const { schema, temperature } = options;
      const { text } = await batch.generate(prompt, {
        ...(temperature !== undefined && { temperature }),
        ...(schema && { jsonSchema: schema, maxTokens: CONSOLIDATED_MAX_TOKENS }),
      });
      return { text };
    },
  };
}

/**
 * The --batch path. Every turn is issued at once; the first round carries the
 * evaluation-steps calls (one per criterion, shared through the cache), the
 * second the verdicts, both drained by one flush(). A wall-clock overrun is
 * thrown, never returned as partial records — as in evaluateTurnsBatched.
 */
export async function evaluateTurnsConsolidatedBatched(
  batch: BatchLLMProvider,
  turns: readonly Turn[],
  existingKeys: Set<string>,
): Promise<EvalRecord[][]> {
  const provider = adaptBatchProvider(batch);
  const stepsCache: EvaluationStepsCache = new Map();
  const inFlight = turns.map(turn => evaluateTurnConsolidated(provider, turn, existingKeys, stepsCache));
  await batch.flush();
  const perTurn = await Promise.all(inFlight);
  if (batch.failure) throw batch.failure;
  return perTurn;
}
