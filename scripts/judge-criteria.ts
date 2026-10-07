/** Criteria, metric names and model settings shared by every judge path. */

import type { GEvalConfig, QagVerificationMode } from '../../src/lib/judge/llm-as-judge.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';

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

export const RELEVANCE_EVAL_NAME = 'relevance';

export const COHERENCE_EVAL_NAME = 'coherence';

export const FAITHFULNESS_EVAL_NAME = 'faithfulness';

/**
 * How each QAG verification mode is recorded. The judge names the modes after what
 * they measure; the dashboard names the metrics after what they mean, and
 * `fabrication` is recorded as `hallucination` because that is the series every
 * consumer already reads.
 */
export const QAG_MODE_RECORDS = {
  faithfulness: { evalName: FAITHFULNESS_EVAL_NAME, label: 'Faithfulness' },
  fabrication: { evalName: HALLUCINATION_EVAL_NAME, label: 'Hallucination' },
} as const satisfies Record<QagVerificationMode, { evalName: string; label: string }>;

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export const JUDGE_MAX_TOKENS = 1024;

/** Low temperature for consistent, deterministic evaluation scores */
export const JUDGE_DEFAULT_TEMPERATURE = 0.1;
