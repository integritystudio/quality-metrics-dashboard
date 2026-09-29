/**
 * Unit tests for `renamedAttr` and `gitRepositoryLabel`.
 *
 * On 2026-09-29 the hooks moved three session-start values onto registered
 * semconv keys: `node.version` → `process.runtime.version`, `working.directory`
 * → `process.working_directory`, and the owner out of `vcs.repository.name`
 * into `vcs.owner.name`. The session header reads spans from both sides of
 * that date, so each helper must answer the same for either shape.
 */

import { describe, it, expect } from 'vitest';

import { gitRepositoryLabel, renamedAttr } from '../api/api-constants.js';

const span = (attributes: Record<string, unknown>) => ({ attributes });

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
