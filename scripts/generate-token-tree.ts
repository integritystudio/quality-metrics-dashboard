#!/usr/bin/env npx tsx
/**
 * Runs repomix --token-count-tree and writes docs/repomix/token-count-tree.txt
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TREE_PATH = resolve(ROOT, 'docs/repomix/token-count-tree.txt');

const raw = execSync('npx repomix --token-count-tree --no-files -o /dev/null', {
  cwd: ROOT,
  encoding: 'utf-8',
  timeout: 60_000,
});

// Strip ANSI escape codes
const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\[\?25[hl]/g, '');
const lines = clean.split('\n');

const treeStart = lines.findIndex(l => l.startsWith('└──'));
if (treeStart === -1) {
  console.error('Could not find token count tree in repomix output');
  process.exit(1);
}

// Tree ends at first non-tree, non-indented line after start
let treeEnd = lines.length - 1;
while (treeEnd > treeStart && lines[treeEnd].trim() === '') treeEnd--;
for (let j = treeStart + 1; j <= treeEnd; j++) {
  if (!/^[\s│├└─┬┤┘┐┌┼]+/.test(lines[j]) && !lines[j].startsWith(' ')) {
    treeEnd = j - 1;
    break;
  }
}

const tree = lines.slice(treeStart, treeEnd + 1).join('\n') + '\n';
writeFileSync(TREE_PATH, tree);
console.log(`Wrote ${TREE_PATH}`);
