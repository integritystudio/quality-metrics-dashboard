/**
 * Unit tests for `renamedAttr` and `gitRepositoryLabel`.
 *
 * On 2026-09-29 the hooks moved three session-start values onto registered
 * semconv keys: `node.version` → `process.runtime.version`, `working.directory`
 * → `process.working_directory`, and the owner out of `vcs.repository.name`
 * into `vcs.owner.name`. The same day they moved the unprefixed hook keys
 * (`tokens.*`, `mcp.*`, `context.*`, …) under `integritystudio.`, numbers and
 * booleans among them. The session header reads spans from both sides of that
 * date, so each helper must answer the same for either shape.
 */

import { describe, it, expect } from 'vitest';

import { gitRepositoryLabel, renamedAttr } from '../api/api-constants.js';
import { MCP_ATTRIBUTES, TOKEN_ATTRIBUTES } from '../lib/hook-attributes.js';

const span = (attributes: Record<string, unknown>) => ({ attributes });
const CANONICAL_INPUT_TOKENS = 120;
const LEGACY_INPUT_TOKENS = 80;

describe('renamedAttr', () => {
  it('reads the canonical key', () => {
    expect(renamedAttr(span({ 'process.runtime.version': 'v26.9.0' }), 'process.runtime.version', 'node.version'))
      .toBe('v26.9.0');
  });

  it('falls back to the pre-rename key on older spans', () => {
    expect(renamedAttr(span({ 'node.version': 'v24.1.0' }), 'process.runtime.version', 'node.version'))
      .toBe('v24.1.0');
  });

  it('prefers the canonical key when a span carries both', () => {
    const both = span({ 'process.working_directory': '/new', 'working.directory': '/old' });
    expect(renamedAttr(both, 'process.working_directory', 'working.directory')).toBe('/new');
  });

  it('is undefined when neither key is present', () => {
    expect(renamedAttr(span({}), 'process.runtime.version', 'node.version')).toBeUndefined();
  });

  // The 2026-09-29 `integritystudio.*` move renamed numeric and boolean keys too.
  it.each([
    ['only the canonical key', { [TOKEN_ATTRIBUTES.INPUT]: CANONICAL_INPUT_TOKENS }, CANONICAL_INPUT_TOKENS],
    ['only the legacy key', { 'tokens.input': LEGACY_INPUT_TOKENS }, LEGACY_INPUT_TOKENS],
    ['both keys', { [TOKEN_ATTRIBUTES.INPUT]: CANONICAL_INPUT_TOKENS, 'tokens.input': LEGACY_INPUT_TOKENS }, CANONICAL_INPUT_TOKENS],
  ])('reads a number from a span with %s', (_shape, attributes, expected) => {
    expect(renamedAttr(span(attributes), TOKEN_ATTRIBUTES.INPUT, 'tokens.input', 'number')).toBe(expected);
  });

  it.each([
    ['only the canonical key', { [MCP_ATTRIBUTES.SUCCESS]: false }, false],
    ['only the legacy key', { 'mcp.success': true }, true],
    ['both keys', { [MCP_ATTRIBUTES.SUCCESS]: false, 'mcp.success': true }, false],
  ])('reads a boolean from a span with %s, keeping a canonical false', (_shape, attributes, expected) => {
    expect(renamedAttr(span(attributes), MCP_ATTRIBUTES.SUCCESS, 'mcp.success', 'boolean')).toBe(expected);
  });

  it('coerces a canonical string-encoded number (D1 stores all OTel int attrs as strings)', () => {
    // Production D1 serialises integer OTel attributes as JSON strings.
    // renamedAttr must coerce them rather than falling through to the legacy key.
    const stringEncoded = span({ [TOKEN_ATTRIBUTES.INPUT]: String(CANONICAL_INPUT_TOKENS), 'tokens.input': LEGACY_INPUT_TOKENS });
    expect(renamedAttr(stringEncoded, TOKEN_ATTRIBUTES.INPUT, 'tokens.input', 'number')).toBe(CANONICAL_INPUT_TOKENS);
  });

  it('coerces a legacy string-encoded number when the canonical key is absent', () => {
    expect(renamedAttr(span({ 'tokens.input': String(LEGACY_INPUT_TOKENS) }), TOKEN_ATTRIBUTES.INPUT, 'tokens.input', 'number'))
      .toBe(LEGACY_INPUT_TOKENS);
  });

  it('is undefined when neither key holds a parseable number', () => {
    expect(renamedAttr(span({ 'tokens.input': 'not-a-number' }), TOKEN_ATTRIBUTES.INPUT, 'tokens.input', 'number'))
      .toBeUndefined();
  });
});

describe('gitRepositoryLabel', () => {
  it('joins the owner and repository the hooks now emit separately', () => {
    expect(gitRepositoryLabel(span({ 'vcs.owner.name': 'aledlie', 'vcs.repository.name': 'env-settings' })))
      .toBe('aledlie/env-settings');
  });

  it('keeps an older span whose repository name already includes the owner', () => {
    expect(gitRepositoryLabel(span({ 'vcs.repository.name': 'aledlie/env-settings' }))).toBe('aledlie/env-settings');
  });

  it('does not prefix the owner onto a repository name that already carries one', () => {
    expect(gitRepositoryLabel(span({ 'vcs.owner.name': 'aledlie', 'vcs.repository.name': 'aledlie/env-settings' })))
      .toBe('aledlie/env-settings');
  });

  it('is empty when no repository was recorded', () => {
    expect(gitRepositoryLabel(span({}))).toBe('');
  });
});
