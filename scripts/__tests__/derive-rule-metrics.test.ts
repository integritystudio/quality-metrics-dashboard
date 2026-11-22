import { describe, expect, it } from 'vitest';
import { deriveAll, deriveSessionRecords, deriveSpanRecords, recordsToPost, sessionEvidence } from '../derive-rule-metrics.js';
import type { LoadedSpans } from '../cloud-trace-source.js';
import { makeSpan, taskSpan } from './support/spans.js';
import { HOOK_NAME, HOOK_SPAN_PREFIX } from '../../src/api/api-constants.js';
import { AGENT_ATTRIBUTES, TOOL_ATTRIBUTES } from '../../src/lib/hook-attributes.js';
import { GENAI_AGENT_ATTRIBUTES, GENAI_TOOL_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { TIME_MS } from '../../../src/lib/core/units.js';

const SECONDS_PER_DAY = TIME_MS.DAY / TIME_MS.SECOND;
/** After `DERIVE_NO_REPOST_BEFORE_MS`, so no record here is held back. */
const DAY_ONE = '2026-12-01';
const DAY_TWO = '2026-12-02';
const DAY_ONE_START_SEC = Date.parse(`${DAY_ONE}T12:00:00.000Z`) / TIME_MS.SECOND;
const ACCOUNT = 'OBTOOL_API_KEY';
const UNREAD_ATTRIBUTE = 'integritystudio.tool.input_bytes';

type Span = ReturnType<typeof makeSpan>;

/** Seconds between one fixture span and the next of its day. */
const SPACING_SEC = 10;
/** The floor of the `recordsToPost` case falls on day two's third span. */
const DAY_TWO_SPANS_BEFORE_FLOOR = 2;

/** `spans` in order from `startSec`, one every `SPACING_SEC`, with ids `<prefix>1`, `<prefix>2`, and so on. */
function spaced(prefix: string, startSec: number, spans: Span[]): Span[] {
  return spans.map((span, index) => {
    const start = startSec + index * SPACING_SEC;
    return { ...span, spanId: `${prefix}${index + 1}`, startTime: [start, 0], endTime: [start + 1, 0] };
  });
}

function agentSpan(hook: typeof HOOK_NAME.AGENT_PREPARE | typeof HOOK_NAME.AGENT_FINALIZE, agentName: string, hasError = false): Span {
  return makeSpan({
    name: `${HOOK_SPAN_PREFIX}${hook}`,
    attributes: { [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: agentName, [AGENT_ATTRIBUTES.HAS_ERROR]: hasError, [UNREAD_ATTRIBUTE]: 4096 },
  });
}

/** One session over two UTC days: tool calls, tasks and a two-agent handoff, the second day finishing what the first began. */
function twoDaySession(): { dayOne: Span[]; dayTwo: Span[] } {
  return {
    dayOne: spaced('a', DAY_ONE_START_SEC, [
      makeSpan({ attributes: { [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Read', [TOOL_ATTRIBUTES.SUCCESS]: true } }),
      taskSpan('TaskCreate', { id: 't1', status: 'pending' }),
      agentSpan(HOOK_NAME.AGENT_PREPARE, 'explorer'),
      agentSpan(HOOK_NAME.AGENT_FINALIZE, 'explorer'),
    ]),
    dayTwo: spaced('b', DAY_ONE_START_SEC + SECONDS_PER_DAY, [
      agentSpan(HOOK_NAME.AGENT_PREPARE, 'reviewer'),
      agentSpan(HOOK_NAME.AGENT_FINALIZE, 'reviewer', true),
      taskSpan('TaskUpdate', { id: 't1', status: 'completed' }),
      makeSpan({ attributes: { [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'Bash', [TOOL_ATTRIBUTES.SUCCESS]: false } }),
    ]),
  };
}

function loaded(spans: Span[]): LoadedSpans {
  return { spans, accounts: new Map(spans.map(span => [span.spanId, ACCOUNT])) };
}

describe('scoring a read split by day', () => {
  it('yields the whole read\'s records from each day\'s spans and the carried session evidence', () => {
    const { dayOne, dayTwo } = twoDaySession();
    const whole = deriveAll(loaded([...dayOne, ...dayTwo]));

    const perDay = [dayOne, dayTwo].flatMap(day => deriveSpanRecords(loaded(day)));
    const carried = [...sessionEvidence(dayOne), ...sessionEvidence(dayTwo)];
    const split = [...perDay, ...deriveSessionRecords(loaded(carried))];

    expect(split).toEqual(whole);
    expect(whole.map(record => record.evaluationName).toSorted()).toEqual([
      'evaluation_latency', 'evaluation_latency', 'evaluation_latency', 'evaluation_latency', 'evaluation_latency', 'evaluation_latency',
      'handoff_correctness', 'task_completion', 'task_completion',
      'tool_correctness', 'tool_correctness', 'tool_correctness', 'tool_correctness',
    ]);
  });

  it('scores a session differently from one day alone, which is why the evidence is carried', () => {
    const { dayOne, dayTwo } = twoDaySession();
    const scores = (spans: Span[]): Array<[string, number | undefined]> =>
      deriveSessionRecords(loaded(spans)).map(record => [record.evaluationName, record.scoreValue]);

    expect(scores(dayTwo)).not.toEqual(scores([...dayOne, ...dayTwo]));
  });

  it('carries only session evidence, without the attributes no session scorer reads', () => {
    const { dayOne } = twoDaySession();

    const evidence = sessionEvidence(dayOne);

    expect(evidence.map(span => span.spanId)).toEqual(['a2', 'a3', 'a4']);
    expect(evidence.filter(span => UNREAD_ATTRIBUTE in span.attributes || 'events' in span || 'endTime' in span)).toEqual([]);
  });
});

describe('recordsToPost', () => {
  it('keeps records dated in scope at or after the floor, and reports the in-scope ones', () => {
    const { dayOne, dayTwo } = twoDaySession();
    const records = deriveSpanRecords(loaded([...dayOne, ...dayTwo]));
    const floorMs = (DAY_ONE_START_SEC + SECONDS_PER_DAY + DAY_TWO_SPANS_BEFORE_FLOOR * SPACING_SEC) * TIME_MS.SECOND;

    const { inScope, toPost, heldBack } = recordsToPost(records, new Set([DAY_TWO]), floorMs);

    expect(inScope.map(record => record.spanId)).toEqual(['b2', 'b3', 'b3', 'b4', 'b4']);
    expect(toPost.map(record => record.spanId)).toEqual(['b3', 'b3', 'b4', 'b4']);
    expect(heldBack).toEqual([]);
  });
});
