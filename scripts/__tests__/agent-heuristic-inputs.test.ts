import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readMultiTurnInput, readSingleTurnInput } from '../agent-heuristic-inputs.js';
import { SCORING_THRESHOLDS } from '../../../src/lib/agent-judge/agent-eval-metrics.js';

const TS = '2026-10-08T12:00:00.000Z';

function userText(content: unknown): object {
  return { type: 'user', timestamp: TS, message: { role: 'user', content } };
}

function assistant(content: unknown[]): object {
  return { type: 'assistant', timestamp: TS, message: { id: 'msg_1', role: 'assistant', content } };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): object {
  return { type: 'tool_use', id, name, input };
}

function toolResult(id: string): object {
  return userText([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-heuristic-inputs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function transcript(entries: object[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('readSingleTurnInput', () => {
  it('reads the prompt, the last reply and each tool call with whether it got a result', async () => {
    const path = transcript([
      userText('<system-reminder>injected</system-reminder>'),
      userText('Find the failing test'),
      assistant([{ type: 'text', text: 'Looking.' }, toolUse('t1', 'Bash', { command: 'npm test' })]),
      toolResult('t1'),
      assistant([toolUse('t2', 'Read', { file_path: '/a.ts' })]),
      assistant([{ type: 'text', text: 'The failure is in a.ts.' }]),
    ]);

    const input = await readSingleTurnInput(path);

    expect(input).toEqual({
      task: 'Find the failing test',
      response: 'The failure is in a.ts.',
      toolCalls: [
        { name: 'Bash', arguments: { command: 'npm test' }, result: true },
        { name: 'Read', arguments: { file_path: '/a.ts' } },
      ],
    });
  });

  it('returns null when the transcript holds no prompt', async () => {
    const path = transcript([assistant([{ type: 'text', text: 'hello' }])]);
    expect(await readSingleTurnInput(path)).toBeNull();
  });

  it('returns null for a transcript that does not exist', async () => {
    expect(await readSingleTurnInput(join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('keeps no more of a prompt than the scorers read', async () => {
    const path = transcript([userText('x'.repeat(SCORING_THRESHOLDS.MAX_CONTENT_LENGTH + 1))]);
    const input = await readSingleTurnInput(path);
    expect(input?.task).toHaveLength(SCORING_THRESHOLDS.MAX_CONTENT_LENGTH);
  });
});

describe('readMultiTurnInput', () => {
  it('makes one user turn per prompt and one agent turn for the work between prompts', async () => {
    const path = transcript([
      userText('Add a flag'),
      assistant([{ type: 'text', text: 'Adding it.' }, toolUse('t1', 'Edit', { file_path: '/b.ts' })]),
      toolResult('t1'),
      assistant([{ type: 'text', text: 'Done.' }]),
      userText('<system-reminder>not a prompt</system-reminder>'),
      userText('Now test it'),
      assistant([{ type: 'text', text: 'Tests pass.' }]),
    ]);

    const input = await readMultiTurnInput(path);

    expect(input).toEqual({
      userIntent: 'Add a flag',
      turns: [
        { index: 0, speaker: 'user', content: 'Add a flag' },
        {
          index: 1,
          speaker: 'agent',
          content: 'Adding it.\nDone.',
          toolCalls: [{ name: 'Edit', arguments: { file_path: '/b.ts' }, result: true }],
        },
        { index: 2, speaker: 'user', content: 'Now test it' },
        { index: 3, speaker: 'agent', content: 'Tests pass.', toolCalls: [] },
      ],
    });
  });

  it('ends on a user turn when the agent never answered the last prompt', async () => {
    const path = transcript([
      userText('First'),
      assistant([{ type: 'text', text: 'Answer.' }]),
      userText('Second'),
    ]);

    const input = await readMultiTurnInput(path);

    expect(input?.turns.map(t => t.speaker)).toEqual(['user', 'agent', 'user']);
  });

  it('returns null when the user never typed a prompt', async () => {
    const path = transcript([toolResult('t1'), assistant([{ type: 'text', text: 'hi' }])]);
    expect(await readMultiTurnInput(path)).toBeNull();
  });
});
