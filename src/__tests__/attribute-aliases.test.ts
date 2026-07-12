/**
 * OBP7b dual-read: attrAlias lookup and alias fallback in the shared
 * spanAttr/attrStr/attrNum helpers. Legacy-keyed spans (historical data) and
 * canonical-keyed spans must both resolve regardless of which key a call site
 * uses.
 */

import { describe, it, expect } from 'vitest';
import { attrAlias } from '../api/attribute-aliases.js';
import { spanAttr, attrStr, attrNum } from '../api/api-constants.js';

describe('attrAlias', () => {
  it('maps canonical → legacy', () => {
    expect(attrAlias('integritystudio.hook.name')).toBe('hook.name');
    expect(attrAlias('vcs.ref.head.name')).toBe('git.branch');
    expect(attrAlias('gen_ai.request.model')).toBe('agent.model');
  });

  it('maps legacy → canonical', () => {
    expect(attrAlias('hook.name')).toBe('integritystudio.hook.name');
    expect(attrAlias('git.repository')).toBe('vcs.repository.name');
    expect(attrAlias('code.structure.score')).toBe('integritystudio.code.structure.score');
  });

  it('returns undefined for non-aliased keys', () => {
    expect(attrAlias('session.id')).toBeUndefined();
    expect(attrAlias('agent.name')).toBeUndefined();
    expect(attrAlias('gen_ai.agent.name')).toBeUndefined();
  });
});

describe('dual-read helpers', () => {
  const legacySpan = { attributes: { 'hook.name': 'session-start', 'git.uncommitted': 3, 'agent.has_error': true } };
  const canonicalSpan = { attributes: { 'integritystudio.hook.name': 'session-start', 'integritystudio.git.uncommitted': 3 } };

  it('spanAttr resolves canonical key from legacy-only span', () => {
    expect(spanAttr(legacySpan, 'integritystudio.hook.name', 'string')).toBe('session-start');
    expect(spanAttr(legacySpan, 'integritystudio.git.uncommitted', 'number')).toBe(3);
    expect(spanAttr(legacySpan, 'integritystudio.agent.has_error', 'boolean')).toBe(true);
  });

  it('spanAttr resolves canonical key directly', () => {
    expect(spanAttr(canonicalSpan, 'integritystudio.hook.name', 'string')).toBe('session-start');
  });

  it('spanAttr resolves legacy key from canonical-only span', () => {
    expect(spanAttr(canonicalSpan, 'hook.name', 'string')).toBe('session-start');
  });

  it('prefers the requested key over its alias when both are present', () => {
    const both = { attributes: { 'integritystudio.hook.name': 'canonical', 'hook.name': 'legacy' } };
    expect(spanAttr(both, 'integritystudio.hook.name', 'string')).toBe('canonical');
    expect(spanAttr(both, 'hook.name', 'string')).toBe('legacy');
  });

  it('spanAttr enforces the type guard on the alias fallback', () => {
    expect(spanAttr(legacySpan, 'integritystudio.git.uncommitted', 'string')).toBeUndefined();
  });

  it('attrStr and attrNum fall back to the alias', () => {
    expect(attrStr({ attributes: { 'agent.source_type': 'active' } }, 'integritystudio.agent.source_type')).toBe('active');
    expect(attrNum({ attributes: { 'agent.output_size': 42 } }, 'integritystudio.agent.output_size')).toBe(42);
  });

  it('non-aliased keys keep exact-match behavior', () => {
    expect(spanAttr(legacySpan, 'session.id', 'string')).toBeUndefined();
    expect(attrStr(legacySpan, 'missing')).toBe('unknown');
    expect(attrNum(legacySpan, 'missing')).toBe(0);
  });
});
