/**
 * Derive's input-drift check (HOOK-RENAME-SILENT): whether a day's spans still
 * record what the rule metrics read. Split into a per-day tally and the
 * verdict over tallies, so a partitioned read (the parent's derive Workflow)
 * can tally one account-day at a time and judge the days once they are summed.
 */

import { ascending } from 'd3-array';
import type { LocalTraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
import { GENAI_CORE_ATTRIBUTES } from '../../src/lib/otel/genai-attributes.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { AGENT_FINALIZE_SPAN, AGENT_PREPARE_SPAN, isToolSpan, toolSuccessOf } from './derive-rule-metrics.js';
import { hrtToISO } from './hrt.js';

/**
 * `gen_ai.operation.name` of the synthetic `invoke_agent <agent>` span each agent
 * invocation emits, whatever the hook spans are named. No other span carries it, so
 * this counts one span per invocation; before 2026-09-29 the hook spans carried it too.
 */
const INVOKE_AGENT_OPERATION = 'invoke_agent';
/** Fewer tool spans than this in a day cannot tell a renamed attribute from a few hooks that failed before recording one. */
export const DRIFT_MIN_TOOL_SPANS = 20;
/** A day's tool spans may lack a success flag up to this share; past it the flag has most likely been renamed. */
const DRIFT_MAX_MISSING_SUCCESS_SHARE = 0.5;

export type DayInput = {
  agentEvidence: number;
  agentMatched: number;
  toolSpans: number;
  toolMissingSuccess: number;
}

/** What each day's spans record of the inputs the derivations read. */
export function tallyDayInputs(spans: readonly LocalTraceSpan[], dateScope: ReadonlySet<string> | null): Map<string, DayInput> {
  const days = new Map<string, DayInput>();
  for (const span of spans) {
    const date = toDateOnly(hrtToISO(span.startTime));
    if (dateScope && !dateScope.has(date)) continue;
    let day = days.get(date);
    if (!day) days.set(date, day = { agentEvidence: 0, agentMatched: 0, toolSpans: 0, toolMissingSuccess: 0 });
    const attrs = span.attributes;
    if (attrs[GENAI_CORE_ATTRIBUTES.OPERATION_NAME] === INVOKE_AGENT_OPERATION) day.agentEvidence++;
    if (span.name === AGENT_PREPARE_SPAN || span.name === AGENT_FINALIZE_SPAN) day.agentMatched++;
    if (isToolSpan(span)) {
      day.toolSpans++;
      if (typeof toolSuccessOf(span, attrs) !== 'boolean') day.toolMissingSuccess++;
    }
  }
  return days;
}

/** Tallies of the same date added up: a partitioned read tallies each account's day apart, and a day is judged whole. */
export function sumDayInputs(tallies: Iterable<readonly [date: string, input: DayInput]>): Map<string, DayInput> {
  const days = new Map<string, DayInput>();
  for (const [date, input] of tallies) {
    const day = days.get(date);
    days.set(date, day ? {
      agentEvidence: day.agentEvidence + input.agentEvidence,
      agentMatched: day.agentMatched + input.agentMatched,
      toolSpans: day.toolSpans + input.toolSpans,
      toolMissingSuccess: day.toolMissingSuccess + input.toolMissingSuccess,
    } : input);
  }
  return days;
}

/**
 * Days whose input the derivations can no longer read. A hooks-side rename can
 * empty a metric while every stage exits 0 (docs/data-pipeline.md § Historical
 * incidents). Each check compares a day's spans with themselves, never with a
 * previous run, so it fires on the first run after a rename rather than once
 * the old names have aged out of the read window, and a quiet day cannot trip it:
 * - spans record an agent invocation, but none has a name derive matches;
 * - most tool spans carry no success flag under the key derive reads.
 */
export function detectInputDrift(spans: readonly LocalTraceSpan[], dateScope: ReadonlySet<string> | null): string[] {
  return driftWarnings(tallyDayInputs(spans, dateScope));
}

/** `detectInputDrift`'s verdict over tallies already taken, one per date. */
export function driftWarnings(days: ReadonlyMap<string, DayInput>): string[] {
  const warnings: string[] = [];
  for (const [date, day] of [...days].toSorted(([a], [b]) => ascending(a, b))) {
    if (day.agentEvidence > 0 && day.agentMatched === 0) {
      warnings.push(`${date}: ${day.agentEvidence} spans record agent invocations, but none is named ${AGENT_PREPARE_SPAN} or ${AGENT_FINALIZE_SPAN}, so the agent metrics are empty. Were the hook spans renamed?`);
    }
    if (day.toolSpans >= DRIFT_MIN_TOOL_SPANS && day.toolMissingSuccess / day.toolSpans > DRIFT_MAX_MISSING_SUCCESS_SHARE) {
      warnings.push(`${date}: ${day.toolMissingSuccess} of ${day.toolSpans} tool spans carry no success flag, so tool_correctness scores them as failures. Was the attribute renamed?`);
    }
  }
  return warnings;
}
