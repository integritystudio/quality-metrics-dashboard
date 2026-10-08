/**
 * Scorer inputs for the agent heuristics in `agent-eval-metrics.ts`
 * (AGENT-EVAL-METRICS-UNUSED), built from Claude Code transcripts. Spans carry
 * neither response text nor tool arguments, so a transcript is the only source
 * the heuristics can score without inventing input.
 *
 * - A subagent transcript is one task: its prompt, its tool calls and its last
 *   text reply (`readSingleTurnInput`).
 * - A session transcript is a conversation: each prompt the user typed and the
 *   agent's work until the next one (`readMultiTurnInput`).
 */

import {
  SCORING_THRESHOLDS,
  type ConversationTurn,
  type MultiTurnInput,
  type SingleTurnInput,
  type ToolCallRecord,
} from '../../src/lib/agent-judge/agent-eval-metrics.js';
import { transcriptEntrySchema, type TranscriptEntry } from '../../src/lib/validation/dashboard-schemas.js';
import { streamJsonlWithValidation } from '../src/lib/dashboard-file-utils.js';
import { extractTextFromContent, isSystemPrompt, isToolResultOnly } from './judge-turns.js';

const USER_ROLE = 'user';
const ASSISTANT_ROLE = 'assistant';

/**
 * Stands in for a tool result's content: the scorers only ask whether a call
 * got a result, so the content itself is not kept.
 */
const TOOL_RESULT_PRESENT = true;

interface ToolUse { id: string; name: string; arguments: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function toolUsesOf(content: unknown): ToolUse[] {
  return blocksOf(content).flatMap(b =>
    b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'
      ? [{ id: b.id, name: b.name, arguments: isRecord(b.input) ? b.input : {} }]
      : [],
  );
}

function toolResultIdsOf(content: unknown): string[] {
  return blocksOf(content).flatMap(b =>
    b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : [],
  );
}

/** The scorers read at most this much of any text, so nothing longer is kept. */
function capped(text: string): string {
  return text.slice(0, SCORING_THRESHOLDS.MAX_CONTENT_LENGTH);
}

/** Text the user typed, or `null` for a tool result, a system injection or an empty entry. */
function userPromptOf(entry: TranscriptEntry): string | null {
  const message = entry.message;
  if (entry.type !== USER_ROLE || message?.role !== USER_ROLE) return null;
  if (isToolResultOnly(message.content)) return null;
  const text = extractTextFromContent(message.content);
  return text && !isSystemPrompt(text) ? text : null;
}

function isAssistant(entry: TranscriptEntry): boolean {
  return entry.type === ASSISTANT_ROLE && entry.message?.role === ASSISTANT_ROLE;
}

function toolCallRecords(uses: readonly ToolUse[], resulted: ReadonlySet<string>): ToolCallRecord[] {
  return uses.map(u => ({
    name: u.name,
    arguments: u.arguments,
    ...(resulted.has(u.id) && { result: TOOL_RESULT_PRESENT }),
  }));
}

/**
 * A subagent transcript as one task. `null` when it holds no prompt, which
 * leaves nothing to score the reply against.
 */
export async function readSingleTurnInput(path: string): Promise<SingleTurnInput | null> {
  let task: string | null = null;
  let response = '';
  const uses: ToolUse[] = [];
  const resulted = new Set<string>();

  for await (const entry of streamJsonlWithValidation(path, transcriptEntrySchema)) {
    const content = entry.message?.content;
    if (isAssistant(entry)) {
      uses.push(...toolUsesOf(content));
      const text = extractTextFromContent(content);
      if (text) response = text;
      continue;
    }
    if (entry.type !== USER_ROLE) continue;
    for (const id of toolResultIdsOf(content)) resulted.add(id);
    task ??= userPromptOf(entry);
  }

  if (task === null) return null;
  return { task: capped(task), response: capped(response), toolCalls: toolCallRecords(uses, resulted) };
}

/**
 * A session transcript as a conversation: one user turn per typed prompt, and
 * one agent turn for everything the agent wrote and called until the next.
 * `null` when the user never typed anything.
 */
export async function readMultiTurnInput(path: string): Promise<MultiTurnInput | null> {
  const turns: ConversationTurn[] = [];
  let agentText: string[] = [];
  let agentUses: ToolUse[] = [];
  let agentSeen = false;
  const resulted = new Set<string>();

  const closeAgentTurn = (): void => {
    if (!agentSeen) return;
    turns.push({
      index: turns.length,
      speaker: 'agent',
      content: capped(agentText.join('\n')),
      toolCalls: toolCallRecords(agentUses, resulted),
    });
    agentText = [];
    agentUses = [];
    agentSeen = false;
  };

  for await (const entry of streamJsonlWithValidation(path, transcriptEntrySchema)) {
    const content = entry.message?.content;
    if (isAssistant(entry)) {
      agentSeen = true;
      agentUses.push(...toolUsesOf(content));
      const text = extractTextFromContent(content);
      if (text) agentText.push(text);
      continue;
    }
    if (entry.type !== USER_ROLE) continue;
    for (const id of toolResultIdsOf(content)) resulted.add(id);
    const prompt = userPromptOf(entry);
    if (prompt === null) continue;
    closeAgentTurn();
    turns.push({ index: turns.length, speaker: 'user', content: capped(prompt) });
  }
  closeAgentTurn();

  const firstPrompt = turns.find(t => t.speaker === 'user');
  if (!firstPrompt) return null;
  return { turns, userIntent: firstPrompt.content };
}
