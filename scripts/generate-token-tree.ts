#!/usr/bin/env npx tsx
/**
 * Runs repomix --token-count-tree and writes docs/repomix/token-count-tree.txt
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TREE_OUTPUT_PATH = resolve(ROOT, 'docs/repomix/token-count-tree.txt');
const REPOMIX_TIMEOUT_MS = 60_000;

// Box-drawing characters that appear on every tree line
const TREE_LINE_RE = /[│├└─]/;

// NO_COLOR suppresses ANSI codes so no stripping is needed
const raw = execSync('npx repomix --token-count-tree --no-files -o /dev/null', {
  cwd: ROOT,
  encoding: 'utf-8',
  timeout: REPOMIX_TIMEOUT_MS,
  env: { ...process.env, NO_COLOR: '1' },
});

const treeLines = raw.split('\n').filter(l => TREE_LINE_RE.test(l));
if (treeLines.length === 0) {
  console.error('Could not find token count tree in repomix output');
  process.exit(1);
}

writeFileSync(TREE_OUTPUT_PATH, treeLines.join('\n') + '\n');
console.log(`Wrote ${TREE_OUTPUT_PATH}`);
