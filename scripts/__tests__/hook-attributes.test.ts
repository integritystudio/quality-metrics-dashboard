/**
 * Nothing here can reach the emitter — `~/.claude/hooks/` is a separate repo
 * with no package relationship to this one — so parity with what the hooks
 * actually write stays held by citation. What is checkable is that every key is
 * a *canonical* spelling rather than one of the pre-rename aliases the parent's
 * table rewrites on read: `agent.has_error` in place of
 * `integritystudio.agent.has_error` fails here, because a reader using it would
 * see `undefined` on every canonicalized span.
 *
 * A key the alias table has never heard of passes — `canonicalAttrKey` returns
 * an unknown key unchanged — so this is a guard against reading a legacy key,
 * not a spell-check. The namespace assertion below is what catches a typo in
 * the prefix. Keys the hooks take from the OTel registry rather than mint are
 * listed by exact spelling, so a misspelt one still fails.
 */
import { describe, expect, it } from 'vitest';
import { canonicalAttrKey } from '../../../src/lib/observability/attribute-aliases.js';
import * as hookAttributes from '../../src/lib/hook-attributes.js';

/**
 * Every group the module exports, so a group added later is covered without
 * touching this file. Flattened by concatenation, never by spreading the groups
 * into one object: several of them declare the same name (`TYPE` in both
 * `AGENT_ATTRIBUTES` and `HOOK_ATTRIBUTES`, `SUCCESS`/`ERROR_TYPE` in both
 * `TOOL_ATTRIBUTES` and `MCP_ATTRIBUTES`), and a spread would drop one key per
 * collision silently.
 */
const ALL_KEYS = Object.values(hookAttributes).flatMap(group => Object.values(group));
const VENDOR_PREFIX = 'integritystudio.';
/** OTel semconv keys the hooks emit as-is (`~/.claude/hooks/lib/survival/code-survival.ts`). */
const OTEL_SEMCONV_KEYS = new Set(['vcs.change.id']);

describe('hook span attribute keys', () => {
  it.each(ALL_KEYS)('%s is canonical, not a legacy alias', (key) => {
    expect(canonicalAttrKey(key)).toBe(key);
  });

  it.each(ALL_KEYS)('%s is in the vendor namespace or a known semconv key', (key) => {
    expect(key.startsWith(VENDOR_PREFIX) || OTEL_SEMCONV_KEYS.has(key)).toBe(true);
  });

  it('spells each key once', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });
});
