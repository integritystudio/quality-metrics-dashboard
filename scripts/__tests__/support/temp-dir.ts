import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** A fresh directory for each test, removed after it; call the accessor inside a test. */
export function useTempDir(prefix: string): () => string {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  return () => {
    if (!dir) throw new Error('useTempDir: accessor called outside a test');
    return dir;
  };
}
