import { writeFileSync } from 'node:fs';

/** Writes `entries` to `path` one JSON object per line and returns the path. */
export function writeJsonl(path: string, entries: readonly object[]): string {
  writeFileSync(path, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

/** One Claude Code transcript line; `line` carries the line-level fields such as `sessionId` and `timestamp`. */
export function transcriptMessage(role: 'user' | 'assistant', content: unknown, line: Record<string, unknown> = {}): object {
  return { type: role, message: { role, content }, ...line };
}
