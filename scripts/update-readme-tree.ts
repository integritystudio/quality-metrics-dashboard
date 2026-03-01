#!/usr/bin/env npx tsx
/**
 * Reads docs/repomix/token-count-tree.txt and updates the
 * "## Project Structure" section in README.md with a condensed view.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TREE_PATH = resolve(ROOT, 'docs/repomix/token-count-tree.txt');
const README_PATH = resolve(ROOT, 'README.md');

const SECTION_HEADING = '## Project Structure';
const MAX_SHOWN_PER_DIR = 5;

// 1. Read full tree
const treeLines = readFileSync(TREE_PATH, 'utf-8').trimEnd().split('\n');

// 2. Extract total tokens from root line: "└── src/ (98,844 tokens)"
const totalMatch = treeLines[0].match(/\(([\d,]+)\s+tokens\)/);
const totalTokens = totalMatch ? totalMatch[1] : 'unknown';

// 3. Build condensed tree
const condensed = buildCondensedTree(treeLines);

// 4. Splice into README
const readme = readFileSync(README_PATH, 'utf-8');
const readmeLines = readme.split('\n');

const sectionIdx = readmeLines.findIndex(l => l.startsWith(SECTION_HEADING));
if (sectionIdx === -1) {
  console.error(`Could not find "${SECTION_HEADING}" in README.md`);
  process.exit(1);
}

const fenceOpenIdx = readmeLines.findIndex(
  (l, i) => i > sectionIdx && l.trim() === '```',
);
const fenceCloseIdx = readmeLines.findIndex(
  (l, i) => i > fenceOpenIdx && l.trim() === '```',
);

if (fenceOpenIdx === -1 || fenceCloseIdx === -1) {
  console.error('Could not find fenced code block under Project Structure');
  process.exit(1);
}

const result = [
  ...readmeLines.slice(0, sectionIdx),
  `${SECTION_HEADING} (${totalTokens} tokens)`,
  '',
  '```',
  ...condensed,
  '```',
  ...readmeLines.slice(fenceCloseIdx + 1),
];

writeFileSync(README_PATH, result.join('\n'));

/**
 * Condense tree for README: dirs with >MAX_SHOWN_PER_DIR files
 * show top entries by token count, then "... (N more)".
 */
function buildCondensedTree(allLines: string[]): string[] {
  const out: string[] = [];
  const i = 0;

  while (i < allLines.length) {
    if (!isFileEntry(allLines[i])) {
      out.push(allLines[i]);
      i++;
      continue;
    }

    // Collect consecutive file siblings at the same connector position
    const connectorPos = findConnectorPos(allLines[i]);
    const siblings: { line: string; tokens: number }[] = [];

    while (i < allLines.length && isFileEntry(allLines[i]) && findConnectorPos(allLines[i]) === connectorPos) {
      const m = allLines[i].match(/\(([\d,]+)\s+tokens\)/);
      siblings.push({ line: allLines[i], tokens: m ? parseInt(m[1].replace(/,/g, ''), 10) : 0 });
      i++;
    }

    if (siblings.length > MAX_SHOWN_PER_DIR) {
      const sorted = [...siblings].sort((a, b) => b.tokens - a.tokens);
      const topSet = new Set(sorted.slice(0, MAX_SHOWN_PER_DIR).map(s => s.line));
      const shown: string[] = [];
      for (const s of siblings) {
        if (topSet.has(s.line)) shown.push(s.line);
      }
      // Ensure no shown file uses └── (last-child connector) since "more" line follows
      for (const line of shown) {
        out.push(line.replace(/└── /, '├── '));
      }
      const remaining = siblings.length - MAX_SHOWN_PER_DIR;
      // Check if any sibling-level entries follow (dirs or files)
      const hasMoreAtLevel = i < allLines.length && findConnectorPos(allLines[i]) === connectorPos;
      const connector = hasMoreAtLevel ? '├' : '└';
      const prefix = siblings[0].line.substring(0, connectorPos).replace(/[├└]/g, '│');
      out.push(`${prefix}${connector}── ... (${remaining} more)`);
    } else {
      for (const s of siblings) out.push(s.line);
    }
  }

  return out;
}

/** Find position of the ├ or └ connector in a tree line */
function findConnectorPos(line: string): number {
  const m = line.match(/[├└]/);
  return m ? m.index! : -1;
}

/** True if line is a file (has extension + token count), not a directory */
function isFileEntry(line: string): boolean {
  if (!line) return false;
  return /\.\w+\s+\([\d,]+\s+tokens\)/.test(line) && !/\/\s+\(/.test(line);
}
