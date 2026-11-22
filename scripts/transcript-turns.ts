/**
 * Transcripts on this machine: where they are, and the turns read out of one. Node-only.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sanitizeForPrompt } from '../../src/lib/judge/llm-as-judge.js';
import { transcriptEntrySchema, type TranscriptEntry } from '../../src/lib/validation/dashboard-schemas.js';
import { streamJsonlWithValidation } from '../src/lib/dashboard-file-utils.js';
import { HOME } from './evaluation-constants.js';
import { extractTextFromContent, extractToolResults, isSystemPrompt, isToolResultOnly, type Turn } from './judge-turns.js';

/** Maximum characters per turn to prevent oversized LLM prompts and token explosion */
export const MAX_TURN_TEXT_LEN = 8000;

/** Maximum tool results to include per turn in evaluation context */
export const MAX_TOOL_RESULTS_PER_TURN = 20;

export const UUID_PREFIX_REGEX = /^[0-9a-f]{8}-/;

export type TranscriptInfo = {
  path: string;
  sessionId: string;
}

/**
 * Directories where session transcripts may exist, first match winning:
 * checked when a recorded path is missing, and scanned to find a session's
 * transcript by id.
 */
export const TRANSCRIPT_DIRS: readonly string[] = [
  join(HOME, '.claude', 'projects'),
  join(HOME, 'claude-tool-use', 'projects'),
  join(HOME, '.claude-history', 'projects'),
  // Root-level slug dirs (transcripts stored outside projects/ subdirectory)
  join(HOME, 'claude-tool-use'),
  join(HOME, '.claude-history'),
];

/** Try to resolve a missing transcript path by checking alternate directories */
export function resolveTranscriptPath(originalPath: string): string | null {
  if (existsSync(originalPath)) return originalPath;

  const projectsIdx = originalPath.indexOf('/projects/');
  if (projectsIdx === -1) return null;
  const suffix = originalPath.slice(projectsIdx + '/projects/'.length);

  for (const dir of TRANSCRIPT_DIRS) {
    const candidate = join(dir, suffix);
    if (candidate !== originalPath && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Transcripts found by listing `<dir>/<slug>/<sessionId>.jsonl` under each of
 * `dirs`, first directory winning. The cloud source uses it to find the
 * transcript of a session the cloud named.
 */
export function scanTranscriptDirs(dirs: readonly string[] = TRANSCRIPT_DIRS): TranscriptInfo[] {
  const seen = new Set<string>();
  const transcripts: TranscriptInfo[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let slugDirs: string[];
    try {
      slugDirs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const slug of slugDirs) {
      const slugPath = join(dir, slug);
      let files: string[];
      try {
        files = readdirSync(slugPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = basename(f, '.jsonl');
        // Skip non-UUID filenames (memory files, etc.)
        if (!UUID_PREFIX_REGEX.test(sessionId)) continue;
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        transcripts.push({ path: join(slugPath, f), sessionId });
      }
    }
  }
  return transcripts;
}

type TranscriptMessage = NonNullable<TranscriptEntry['message']>;
type PendingUser = { text: string; timestamp: string };

/**
 * The hook record a forked session writes before its own first turn. A fork
 * copies the parent's history into the new transcript ahead of this record,
 * re-stamped with the new session id; those turns are the parent's, which
 * anchors and judges them under its own id.
 */
export const FORK_SESSION_START_HOOK = 'SessionStart:fork';

function isForkStart(entry: TranscriptEntry): boolean {
  return entry.type === 'attachment' && entry.attachment?.hookName === FORK_SESSION_START_HOOK;
}

/** Entry types that carry no message to read. */
const NON_MESSAGE_ENTRY_TYPES = new Set(['progress', 'file-history-snapshot']);

/** The message on an entry worth reading, or null when the entry carries none. */
function evaluableMessage(entry: TranscriptEntry): TranscriptMessage | null {
  if (NON_MESSAGE_ENTRY_TYPES.has(entry.type)) return null;
  return entry.message ?? null;
}

/**
 * The user turn this entry opens, or null when it carries no evaluable prompt:
 * a tool-result-only entry, a system prompt, one without a timestamp (required
 * for correlation), or one that sanitizes away to nothing.
 */
function pendingUserFrom(content: unknown, rawTimestamp: unknown): PendingUser | null {
  if (isToolResultOnly(content)) return null;

  const userText = extractTextFromContent(content);
  if (!userText || isSystemPrompt(userText)) return null;

  const timestamp = typeof rawTimestamp === 'string' ? rawTimestamp : null;
  if (!timestamp) return null;

  // Sanitize text before LLM evaluation to mitigate prompt injection
  const sanitizedUser = sanitizeForPrompt(userText, MAX_TURN_TEXT_LEN);
  if (!sanitizedUser.trim()) return null;

  return { text: sanitizedUser, timestamp };
}

/** The turn this assistant message closes, or null when it has no text to score. */
function completedTurn(
  info: TranscriptInfo,
  message: TranscriptMessage,
  pendingUser: PendingUser,
  toolResults: readonly string[],
): Turn | null {
  const assistantText = extractTextFromContent(message.content);
  if (!assistantText) return null;
  return {
    sessionId: info.sessionId,
    // Anchoring (`anchorTurns`) gives each turn its own trace.
    traceId: '',
    timestamp: pendingUser.timestamp,
    userText: pendingUser.text,
    assistantText: sanitizeForPrompt(assistantText, MAX_TURN_TEXT_LEN),
    toolResults: toolResults.slice(-MAX_TOOL_RESULTS_PER_TURN),
    ...(message.id && { responseId: message.id }),
  };
}

export async function extractTurns(info: TranscriptInfo): Promise<Turn[]> {
  const turns: Turn[] = [];
  let pendingUser: PendingUser | null = null;
  const accumulatedToolResults: string[] = [];

  for await (const entry of streamJsonlWithValidation(info.path, transcriptEntrySchema)) {
    if (isForkStart(entry)) {
      // Everything so far was copied from the parent session: keep only this fork's own turns.
      turns.length = 0;
      pendingUser = null;
      accumulatedToolResults.length = 0;
      continue;
    }
    const message = evaluableMessage(entry);
    if (!message) continue;

    if (entry.type === 'user' && message.role === 'user') {
      const toolRes = extractToolResults(message.content);
      if (toolRes.length > 0) accumulatedToolResults.push(...toolRes);
      // A skipped user entry leaves the previous pending turn in place.
      pendingUser = pendingUserFrom(message.content, entry.timestamp) ?? pendingUser;
      continue;
    }

    if (entry.type === 'assistant' && message.role === 'assistant' && pendingUser) {
      const turn = completedTurn(info, message, pendingUser, accumulatedToolResults);
      if (!turn) continue;
      turns.push(turn);
      pendingUser = null;
      accumulatedToolResults.length = 0;
    }
  }

  return turns;
}
