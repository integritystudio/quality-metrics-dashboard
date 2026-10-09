import { describe, it, expect } from 'vitest';
import { extractGitCommit, type ExtractableSpan } from '../api/session-detail.js';

const GIT_COMMAND_ATTRIBUTE = 'integritystudio.git.command';

function spanWithCommand(command: string): ExtractableSpan {
  return { name: 'post-commit-review', attributes: { [GIT_COMMAND_ATTRIBUTE]: command } };
}

describe('extractGitCommit', () => {
  it('returns null without a command', () => {
    expect(extractGitCommit({ name: 'post-commit-review', attributes: {} })).toBeNull();
  });

  it('reads the file list up to the &&', () => {
    const span = spanWithCommand("git add a.ts b.ts && git commit -m 'x'");
    expect(extractGitCommit(span)?.files).toBe('a.ts b.ts');
  });

  it('keeps a 2>&1 redirect inside the file list', () => {
    const span = spanWithCommand("git add a.ts 2>&1 && git commit -m 'x'");
    expect(extractGitCommit(span)?.files).toBe('a.ts 2>&1');
  });

  it('parses the heredoc message into subject and body', () => {
    const command = "git add a.ts && git commit -F - <<'EOF'\nfix: subject\n\nbody line\nCo-Authored-By: x\nEOF";
    expect(extractGitCommit(spanWithCommand(command))).toEqual({ subject: 'fix: subject', body: 'body line', files: 'a.ts' });
  });
});
