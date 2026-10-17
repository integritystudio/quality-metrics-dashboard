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
 * the prefix.
 */
import { describe, expect, it } from 'vitest';
import { canonicalAttrKey } from '../../../src/lib/observability/attribute-aliases.js';
import { AGENT_ATTRIBUTES, HOOK_ATTRIBUTES } from '../../src/lib/hook-attributes.js';

/**
 * Concatenated, never spread into one object: both groups declare a `TYPE`, so
 * `{ ...AGENT_ATTRIBUTES, ...HOOK_ATTRIBUTES }` drops the agent one silently.
 * Keys, not entries, so two `TYPE`s cannot give two tests the same title.
 */
const ALL_KEYS = [...Object.values(AGENT_ATTRIBUTES), ...Object.values(HOOK_ATTRIBUTES)];
const VENDOR_PREFIX = 'integritystudio.';

describe('hook span attribute keys', () => {
  it.each(ALL_KEYS)('%s is canonical, not a legacy alias', (key) => {
    expect(canonicalAttrKey(key)).toBe(key);
  });

  it.each(ALL_KEYS)('%s is in the vendor namespace', (key) => {
    expect(key.startsWith(VENDOR_PREFIX)).toBe(true);
  });

  it('spells each key once', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });
});
