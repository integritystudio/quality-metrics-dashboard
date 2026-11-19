import type { TraceSpan } from '../../derive-evaluations.js';
import { SESSION_ATTRIBUTES } from '../../../../src/lib/otel/constants-otel.js';
import { GENAI_TOOL_ATTRIBUTES } from '../../../../src/lib/otel/genai-attributes.js';
import { TASK_ATTRIBUTES } from '../../../src/lib/hook-attributes.js';

/** 2024-02-08T13:46:40Z, in epoch seconds. */
export const SPAN_START_SEC = 1707400000;
export const SPAN_SESSION = 'sess-abc';

type SpanOverrides = Partial<TraceSpan> & { attributes?: Record<string, unknown> };

/** A one-second builtin post-tool span in {@link SPAN_SESSION}; `attributes` merge over the defaults. */
export function makeSpan(overrides: SpanOverrides = {}): TraceSpan {
  const { attributes, ...rest } = overrides;
  return {
    traceId: 'trace-001',
    spanId: 'span-001',
    name: 'hook:builtin-post-tool',
    startTime: [SPAN_START_SEC, 0],
    endTime: [SPAN_START_SEC + 1, 0],
    duration: [1, 0],
    status: { code: 0 },
    ...rest,
    attributes: { [SESSION_ATTRIBUTES.ID]: SPAN_SESSION, [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: 'TaskCreate', ...attributes },
  };
}

type TaskFields = { status?: string; id?: string; session?: string };

/** A task tool call; leave `status` out for a span written before task statuses were. */
export function taskSpan(tool: 'TaskCreate' | 'TaskUpdate', task: TaskFields = {}, overrides: Partial<TraceSpan> = {}): TraceSpan {
  return makeSpan({
    ...overrides,
    attributes: {
      [SESSION_ATTRIBUTES.ID]: task.session ?? SPAN_SESSION,
      [GENAI_TOOL_ATTRIBUTES.TOOL_NAME]: tool,
      ...(task.status !== undefined && { [TASK_ATTRIBUTES.STATUS]: task.status }),
      ...(task.id !== undefined && { [TASK_ATTRIBUTES.ID]: task.id }),
    },
  });
}
