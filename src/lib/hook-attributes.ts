/**
 * Vendor (`integritystudio.*`) span-attribute keys written by the Claude Code
 * hooks, for the code here that reads them and the fixtures that stand in for
 * them. Semconv keys (`gen_ai.*`, `session.id`) live in `otel-attributes.ts`,
 * which re-exports the parent's; these have no semconv counterpart, so they are
 * defined here rather than re-exported.
 *
 * The producer is `~/.claude/hooks/lib/` (`agent-sources.ts` for the identity
 * keys), a separate repo with no package relationship to this one — the parent
 * and the hooks "intentionally share no code"
 * (`../src/lib/observability/instrumentation.ts`), so parity with the emitter is
 * held by citation, as `scripts/eval-record.ts` holds it for the evaluation
 * keys. What this module buys is that every reader and every fixture here spell
 * a key once: a rename that reaches only one of them is now a compile error
 * instead of a reader that silently sees `undefined`.
 *
 * Canonical spellings only. The pre-rename `agent.*` forms are mapped onto these
 * by the parent's `canonicalizeAttributes`, and in `derive-evaluations.ts` by its
 * own `attrsOf`; nothing should read a legacy key directly.
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
