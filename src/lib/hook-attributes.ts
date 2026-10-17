/**
 * Vendor (`integritystudio.*`) span-attribute keys, for every reader here and
 * the fixtures that stand in for them. Semconv keys (`gen_ai.*`, `session.id`)
 * come from `otel-attributes.ts` instead.
 *
 * Canonical spellings only: a legacy key reads `undefined` off a canonicalized
 * span. `canonicalizeAttributes` (parent) and `attrsOf` (`derive-evaluations.ts`)
 * are what map the legacy forms onto these.
 *
 * The emitter is `~/.claude/hooks/lib/`, a separate repo this one cannot import,
 * so parity with it is held by citation — as `scripts/eval-record.ts` holds it
 * for the evaluation keys.
 */

export const AGENT_ATTRIBUTES = {
  TYPE: 'integritystudio.agent.type',
  SOURCE_TYPE: 'integritystudio.agent.source_type',
  HAS_ERROR: 'integritystudio.agent.has_error',
  HAS_RATE_LIMIT: 'integritystudio.agent.has_rate_limit',
  OUTPUT_SIZE: 'integritystudio.agent.output_size',
  OUTPUT_TRUNCATED: 'integritystudio.agent.output.truncated',
  OUTPUT_EMPTY: 'integritystudio.agent.output.empty',
  TRANSCRIPT_PATH: 'integritystudio.agent.transcript_path',
} as const;

export const HOOK_ATTRIBUTES = {
  /** A hook span's name is `HOOK_SPAN_PREFIX` plus this attribute's value. */
  NAME: 'integritystudio.hook.name',
  /** The Claude Code event that fired the hook, e.g. `PostToolUse`. */
  TRIGGER: 'integritystudio.hook.trigger',
  TYPE: 'integritystudio.hook.type',
} as const;

/** Built-in tool calls. `integritystudio.mcp.*` carries the same three for MCP tools. */
export const TOOL_ATTRIBUTES = {
  SUCCESS: 'integritystudio.tool.success',
  HAS_ERROR: 'integritystudio.tool.has_error',
  ERROR_TYPE: 'integritystudio.tool.error_type',
} as const;

export const MCP_ATTRIBUTES = {
  SUCCESS: 'integritystudio.mcp.success',
  TOOL: 'integritystudio.mcp.tool',
  SERVER: 'integritystudio.mcp.server',
  ERROR_TYPE: 'integritystudio.mcp.error_type',
} as const;

export const TOKEN_ATTRIBUTES = {
  MESSAGES: 'integritystudio.tokens.messages',
  INPUT: 'integritystudio.tokens.input',
  OUTPUT: 'integritystudio.tokens.output',
  CACHE_READ: 'integritystudio.tokens.cache_read',
  CACHE_CREATION: 'integritystudio.tokens.cache_creation',
  MODEL: 'integritystudio.tokens.model',
} as const;

export const CONTEXT_ATTRIBUTES = {
  MESSAGE_COUNT: 'integritystudio.context.message_count',
  ESTIMATED_TOKENS: 'integritystudio.context.estimated_tokens',
} as const;

export const GIT_ATTRIBUTES = {
  COMMAND: 'integritystudio.git.command',
  UNCOMMITTED: 'integritystudio.git.uncommitted',
} as const;

export const PROJECT_ATTRIBUTES = {
  NAME: 'integritystudio.project.name',
} as const;

export const TASK_ATTRIBUTES = {
  ID: 'integritystudio.task.id',
  STATUS: 'integritystudio.task.status',
  /** Plural namespace, unlike the two above — a count of tasks, not one task's field. */
  ACTIVE: 'integritystudio.tasks.active',
} as const;

export const ALERT_ATTRIBUTES = {
  TRIGGERED_COUNT: 'integritystudio.alerts.triggered_count',
} as const;

/** The session transcript. An agent's own transcript is `AGENT_ATTRIBUTES.TRANSCRIPT_PATH`. */
export const TRANSCRIPT_ATTRIBUTES = {
  PATH: 'integritystudio.transcript.path',
} as const;

export const CODE_ATTRIBUTES = {
  EVENT: 'integritystudio.code.event',
  CONTENT_KIND: 'integritystudio.code.content_kind',
  CHECKPOINT_WINDOW: 'integritystudio.code.checkpoint_window',
  SURVIVAL_COHORT: 'integritystudio.code.survival.cohort',
  SURVIVAL_RATE: 'integritystudio.code.quality.survival_rate',
  CHURN_RATE: 'integritystudio.code.quality.churn_rate',
  DELETION_RATE: 'integritystudio.code.quality.deletion_rate',
} as const;

export const CODE_STRUCTURE_ATTRIBUTES = {
  FILE: 'integritystudio.code.structure.file',
  LINES: 'integritystudio.code.structure.lines',
  EXPORTS: 'integritystudio.code.structure.exports',
  FUNCTIONS: 'integritystudio.code.structure.functions',
  HAS_TYPES: 'integritystudio.code.structure.has_types',
  SCORE: 'integritystudio.code.structure.score',
  TOOL: 'integritystudio.code.structure.tool',
} as const;
