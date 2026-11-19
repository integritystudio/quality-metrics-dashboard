/**
 * Nothing here can reach the emitter — `~/.claude/hooks/` is a separate repo
 * with no package relationship to this one — so parity with what the hooks
 * actually write stays held by citation. What is checkable is that every key is
 * a *canonical* spelling: in the vendor namespace or a semconv key listed by
 * exact spelling, and not one of the retired vendor keys a rename replaced.
 * Stored rows hold canonical keys only (migrations 0018, 0019, 0025) and no
 * reader translates, so a reader using a retired key sees `undefined`.
 */
import { describe, expect, it } from 'vitest';
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
/** Vendor-namespaced keys a later rename retired; the unprefixed legacy keys fail the namespace check. */
const RETIRED_VENDOR_KEYS = new Set(['integritystudio.session.is_resume', 'integritystudio.quality.eval_skipped']);

describe('hook span attribute keys', () => {
  it.each(ALL_KEYS)('%s is not a retired key', (key) => {
    expect(RETIRED_VENDOR_KEYS.has(key)).toBe(false);
  });

  it.each(ALL_KEYS)('%s is in the vendor namespace or a known semconv key', (key) => {
    expect(key.startsWith(VENDOR_PREFIX) || OTEL_SEMCONV_KEYS.has(key)).toBe(true);
  });

  it('spells each key once', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });
});
