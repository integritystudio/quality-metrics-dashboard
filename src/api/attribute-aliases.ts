/**
 * OBP7b: canonical OTel-conformant telemetry keys ↔ legacy aliases (consumer side).
 *
 * The hooks telemetry layer (~/.claude/hooks/lib/attribute-aliases.ts) DUAL-WRITES
 * every aliased attribute/metric under both its canonical key (standardized
 * `vcs.*`/`gen_ai.*` per semconv v1.42.0, or the `integritystudio.*` vendor
 * namespace) and its legacy key. Historical spans (pre-rename traces-*.jsonl / D1
 * rows) carry ONLY the legacy key. Consumers therefore DUAL-READ: canonical key
 * first, legacy fallback — via `attrAlias` wired into `spanAttr`/`attrStr`/`attrNum`
 * in api-constants.ts. Once historical data ages out (or is backfilled), the
 * legacy half of this map is dropped in the coordinated hard cutover.
 *
 * Keep this table in sync with the emitter's ALIAS_PAIRS. See parent repo
 * docs/BACKLOG.md OBP7b.
 */

/** [canonical, legacy] — canonical is the going-forward key, legacy the deprecated alias. */
const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // code.structure.* → integritystudio.* (Stable OTel code.* is source-location only)
  ['integritystudio.code.structure.lines', 'code.structure.lines'],
  ['integritystudio.code.structure.exports', 'code.structure.exports'],
  ['integritystudio.code.structure.functions', 'code.structure.functions'],
  ['integritystudio.code.structure.imports', 'code.structure.imports'],
  ['integritystudio.code.structure.max_nesting', 'code.structure.max_nesting'],
  ['integritystudio.code.structure.has_types', 'code.structure.has_types'],
  ['integritystudio.code.structure.is_partial', 'code.structure.is_partial'],
  ['integritystudio.code.structure.score', 'code.structure.score'],
  ['integritystudio.code.structure.file', 'code.structure.file'],
  ['integritystudio.code.structure.tool', 'code.structure.tool'],

  // git.* → standardized vcs.* (Development) where an equivalent exists; vendor otherwise
  ['vcs.ref.head.name', 'git.branch'],
  ['vcs.repository.name', 'git.repository'],
  ['integritystudio.git.uncommitted', 'git.uncommitted'],
  ['integritystudio.git.command', 'git.command'],
  ['integritystudio.git.commits_reviewed', 'git.commits_reviewed'],

  // agent.* standards → gen_ai.* (Development)
  ['gen_ai.request.model', 'agent.model'],
  ['gen_ai.usage.input_tokens', 'agent.estimated_input_tokens'],
  ['gen_ai.usage.output_tokens', 'agent.estimated_output_tokens'],

  // agent.* hook-internal → integritystudio.agent.* (no standard equivalent)
  ['integritystudio.agent.type', 'agent.type'],
  ['integritystudio.agent.category', 'agent.category'],
  ['integritystudio.agent.source_type', 'agent.source_type'],
  ['integritystudio.agent.is_resume', 'agent.is_resume'],
  ['integritystudio.agent.is_background', 'agent.is_background'],
  ['integritystudio.agent.has_prompt', 'agent.has_prompt'],
  ['integritystudio.agent.prompt_length', 'agent.prompt_length'],
  ['integritystudio.agent.parent_skill', 'agent.parent_skill'],
  ['integritystudio.agent.output_size', 'agent.output_size'],
  ['integritystudio.agent.has_rate_limit', 'agent.has_rate_limit'],
  ['integritystudio.agent.has_error', 'agent.has_error'],
  ['integritystudio.agent.output_mentions_error', 'agent.output_mentions_error'],
  ['integritystudio.agent.output.has_structure', 'agent.output.has_structure'],
  ['integritystudio.agent.output.has_code', 'agent.output.has_code'],
  ['integritystudio.agent.output.has_actions', 'agent.output.has_actions'],
  ['integritystudio.agent.output.truncated', 'agent.output.truncated'],
  ['integritystudio.agent.output.empty', 'agent.output.empty'],
  ['integritystudio.agent.invocations', 'agent.invocations'],
  ['integritystudio.agent.completions', 'agent.completions'],

  // hook.* → integritystudio.hook.* (no OTel standard)
  ['integritystudio.hook.name', 'hook.name'],
  ['integritystudio.hook.type', 'hook.type'],
  ['integritystudio.hook.trigger', 'hook.trigger'],
  ['integritystudio.hook.status', 'hook.status'],
  ['integritystudio.hook.duration', 'hook.duration'],
  ['integritystudio.hook.executions', 'hook.executions'],
  ['integritystudio.hook.duration.gauge', 'hook.duration.gauge'],
];

const ALIAS_LOOKUP = new Map<string, string>(
  ALIAS_PAIRS.flatMap(([canonical, legacy]) => [
    [canonical, legacy],
    [legacy, canonical],
  ]),
);

/**
 * Returns the alias for a telemetry key (legacy for a canonical key, canonical
 * for a legacy key), or `undefined` if the key is not aliased. Bidirectional so
 * call sites can migrate to canonical keys while spans written before the
 * OBP7b rename (legacy-only) keep resolving.
 */
export function attrAlias(key: string): string | undefined {
  return ALIAS_LOOKUP.get(key);
}
