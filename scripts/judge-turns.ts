/**
 * Turns: discovered from transcripts (or trace files, for --backfill),
 * extracted, anchored to their spans and fitted to the judge's input caps.
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { sanitizeForPrompt } from '../../src/lib/judge/llm-as-judge.js';
import { localTraceSpanSchema, otelLogEntrySchema, transcriptEntrySchema } from '../../src/lib/validation/dashboard-schemas.js';
import { streamJsonlWithValidation } from '../src/lib/dashboard-file-utils.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { MAX_TEXT_LENGTH, MAX_CONTEXT_ITEMS } from '../../src/lib/judge/llm-judge-constants.js';
import { HOOK_NAME } from '../src/api/api-constants.js';
import { turnAccount, turnSpan, type AccountIndex, type AccountRef } from './account-stamps.js';
import type { EvalRecord } from './eval-record.js';
import { LOGS_FILE_PREFIX, TRACES_FILE_PREFIX, listTelemetryJsonl } from './telemetry-files.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

export const HOME = process.env.HOME ?? '';

/** Maximum characters per turn to prevent oversized LLM prompts and token explosion */
export const MAX_TURN_TEXT_LEN = 8000;

/** Maximum tool context items to balance quality vs cost in evaluations */
export const MAX_TOOL_CONTEXT_ITEMS = 10;

/** Maximum tool results to include per turn in evaluation context */
export const MAX_TOOL_RESULTS_PER_TURN = 20;

export const UUID_PREFIX_REGEX = /^[0-9a-f]{8}-/;

export interface TranscriptInfo {
  path: string;
  sessionId: string;
  traceId: string;
}

export interface Turn {
  sessionId: string;
  traceId: string;
  timestamp: string;
  userText: string;
  assistantText: string;
  toolResults: string[];
  /** Account the turn ran under (`anchorTurns`); absent when no stamped span covers it. */
  identityKeyRef?: AccountRef;
  /** The turn's first span (`anchorTurns`), which its evaluations are parented to. */
  spanId?: string;
  /** API response id of the turn's assistant message — semconv `gen_ai.response.id`. */
  responseId?: string;
}

/**
 * What a record built from a turn carries to link it to that turn: its span
 * (Phase 2), the response id when no span is known, and its account stamp
 * (Phase 1).
 *
 * Spread, not assigned: an unstamped turn must yield a record with no
 * `identityKeyRef` key at all, which upload reads as "fall back to the join";
 * `null` is a real stamp (unmapped account, withheld). The response id follows
 * the semconv rule literally — it is set only "when span id is not available".
 */
export function turnSourceFields(turn: Turn): Pick<EvalRecord, 'identityKeyRef' | 'spanId' | 'responseId'> {
  return {
    ...(turn.spanId ? { spanId: turn.spanId } : turn.responseId ? { responseId: turn.responseId } : {}),
    ...(turn.identityKeyRef !== undefined && { identityKeyRef: turn.identityKeyRef }),
  };
}

/** A turn's identity across sources and runs: its session and start time. */
export function turnKey(turn: { sessionId: string; timestamp: string }): string {
  return `${turn.sessionId}|${turn.timestamp}`;
}

/**
 * Anchor each turn to its own spans: the session's spans between the turn's
 * start and the next turn's. The first of them gives the turn its trace and
 * the span its evaluations are parented to (Phase 2); the first stamped one
 * gives its account (Phase 1).
 *
 * Never from the transcript's trace id. A transcript's turns all share the
 * trace id of whichever prompt the token-metrics log recorded first, so it
 * names the wrong prompt for every turn but one — `extractTurns` no longer
 * copies it. And never from the account signed in now: the judge runs hours
 * after the turn, often under another account.
 */
export function anchorTurns(turns: Turn[], index: AccountIndex): void {
  const bySession = new Map<string, Turn[]>();
  for (const turn of turns) {
    const group = bySession.get(turn.sessionId) ?? [];
    group.push(turn);
    bySession.set(turn.sessionId, group);
  }
  for (const [sessionId, group] of bySession) {
    const timed = group
      .map((turn) => ({ turn, atMs: Date.parse(turn.timestamp) }))
      .sort((a, b) => a.atMs - b.atMs);
    timed.forEach(({ turn, atMs }, i) => {
      const nextMs = timed[i + 1]?.atMs;
      const ref = turnAccount(index, sessionId, atMs, nextMs);
      if (ref !== undefined) turn.identityKeyRef = ref;
      const span = turnSpan(index, sessionId, atMs, nextMs);
      if (span) {
        turn.traceId = span.traceId;
        turn.spanId = span.spanId;
      }
    });
  }
}

/**
 * Alternate directories where session transcripts may exist.
 * Checked in order when a log-referenced path is missing, and scanned
 * directly to discover transcripts not referenced in logs at all.
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

/** The transcript path log attribute; the hooks moved it under `integritystudio.` on 2026-09-29. */
export const TRANSCRIPT_PATH_ATTR = 'integritystudio.transcript.path';

export const LEGACY_TRANSCRIPT_PATH_ATTR = 'transcript.path';

/**
 * A token-metrics log record's transcript path, under its canonical key, else
 * under the key older records carry. These are raw `logs-*.jsonl` lines, which
 * no alias table rewrites, so both spellings reach this reader.
 */
export function transcriptPathOf(attrs: Record<string, unknown>): string | undefined {
  const canonical = attrs[TRANSCRIPT_PATH_ATTR];
  if (typeof canonical === 'string') return canonical;
  const legacy = attrs[LEGACY_TRANSCRIPT_PATH_ATTR];
  return typeof legacy === 'string' ? legacy : undefined;
}

/** Discover transcripts from telemetry logs (primary) and directory scan (fallback) */
export async function _discoverTranscripts(): Promise<TranscriptInfo[]> {
  // Track by sessionId (UUID) to deduplicate across sources
  const seen = new Set<string>();
  const transcripts: TranscriptInfo[] = [];

  for (const filepath of listTelemetryJsonl(LOGS_FILE_PREFIX)) {
    for await (const entry of streamJsonlWithValidation(filepath, otelLogEntrySchema)) {
      const attrs = entry.attributes;
      if (attrs?.['integritystudio.hook.name'] !== HOOK_NAME.TOKEN_METRICS) continue;

      const tPath = transcriptPathOf(attrs);
      if (!tPath) continue;

      const sessionId = basename(tPath, '.jsonl');
      if (seen.has(sessionId)) continue;

      const resolved = resolveTranscriptPath(tPath);
      if (!resolved) continue;

      seen.add(sessionId);
      const traceId = typeof entry.traceId === 'string' ? entry.traceId : '';
      transcripts.push({ path: resolved, sessionId, traceId });
    }
  }

  transcripts.push(...scanTranscriptDirs(TRANSCRIPT_DIRS, seen));
  return transcripts;
}

/**
 * Transcripts found by listing `<dir>/<slug>/<sessionId>.jsonl` under each of
 * `dirs`, first directory winning. Session ids already in `seen` are skipped;
 * the rest are added to it. Reads no telemetry, so the cloud source uses it to
 * find the transcript of a session the cloud named.
 */
export function scanTranscriptDirs(dirs: readonly string[] = TRANSCRIPT_DIRS, seen = new Set<string>()): TranscriptInfo[] {
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
        transcripts.push({ path: join(slugPath, f), sessionId, traceId: '' });
      }
    }
  }
  return transcripts;
}

export interface TraceSession {
  sessionId: string;
  traceId: string;
  earliestTime: number; // epoch seconds
  spanCount: number;
}

/** Discover sessions from traces-*.jsonl when transcripts are unavailable */
export async function discoverSessionsFromTraces(): Promise<Turn[]> {
  const sessions = new Map<string, TraceSession>();

  for (const filepath of listTelemetryJsonl(TRACES_FILE_PREFIX)) {
    for await (const span of streamJsonlWithValidation(filepath, localTraceSpanSchema)) {
      const attrs = span.attributes;

      const recordedSessionId = attrs[SESSION_ATTRIBUTES.ID];
      const sessionId = typeof recordedSessionId === 'string' ? recordedSessionId : '';
      if (!sessionId) continue;

      const startTime = Array.isArray(span.startTime) ? span.startTime[0] : 0;
      const traceId = span.traceId || '';

      const existing = sessions.get(sessionId);
      if (!existing) {
        sessions.set(sessionId, { sessionId, traceId, earliestTime: startTime, spanCount: 1 });
      } else {
        existing.spanCount++;
        if (startTime < existing.earliestTime) {
          existing.earliestTime = startTime;
          existing.traceId = traceId;
        }
      }
    }
  }

  const turns: Turn[] = [];
  for (const s of sessions.values()) {
    const timestamp = new Date(s.earliestTime * TIME_MS.SECOND).toISOString();
    turns.push({
      sessionId: s.sessionId,
      traceId: s.traceId,
      timestamp,
      userText: '[trace-backfill]',
      assistantText: '[trace-backfill]',
      toolResults: [],
    });
  }

  return turns;
}

export interface TextBlock { type: 'text'; text: string }

export interface ToolResultBlock { type: 'tool_result'; content: string | ContentBlock[] }

export interface ToolUseBlock { type: 'tool_use'; id: string; name: string }

export type ContentBlock = TextBlock | ToolResultBlock | ToolUseBlock;

export function isContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'text' || obj.type === 'tool_result' || obj.type === 'tool_use';
}

export function asContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isContentBlock);
}

export function isSystemPrompt(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  return trimmed.startsWith('<system-reminder>') || trimmed.startsWith('Stop hook feedback:');
}

export function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const blocks = asContentBlocks(content);
  return blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asContentBlocks(content)
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

export function extractToolResults(content: unknown): string[] {
  return asContentBlocks(content)
    .filter((b): b is ToolResultBlock => b.type === 'tool_result')
    .map(b => {
      if (typeof b.content === 'string') return b.content;
      return b.content
        .filter((inner): inner is TextBlock => inner.type === 'text')
        .map(inner => inner.text)
        .join('\n');
    })
    .filter(Boolean);
}

export async function extractTurns(info: TranscriptInfo): Promise<Turn[]> {
  const turns: Turn[] = [];

  let pendingUser: { text: string; timestamp: string } | null = null;
  // Anchoring (`anchorTurns`) gives each turn its own trace; `info.traceId` is
  // one prompt's trace for the whole transcript, so it is not copied (TKR8).
  const accumulatedToolResults: string[] = [];

  for await (const entry of streamJsonlWithValidation(info.path, transcriptEntrySchema)) {
    const type = entry.type;
    if (type === 'progress' || type === 'file-history-snapshot') continue;

    const message = entry.message;
    if (!message) continue;

    const role = message.role;
    const content = message.content;

    if (type === 'user' && role === 'user') {
      const toolRes = extractToolResults(content);
      if (toolRes.length > 0) {
        accumulatedToolResults.push(...toolRes);
      }

      if (isToolResultOnly(content)) continue;

      const userText = extractTextFromContent(content);
      if (!userText || isSystemPrompt(userText)) continue;

      // Skip entries without valid timestamp (required for correlation)
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (!timestamp) continue;

      // Sanitize text before LLM evaluation to mitigate prompt injection
      const sanitizedUser = sanitizeForPrompt(userText, MAX_TURN_TEXT_LEN);
      if (!sanitizedUser.trim()) continue;

      pendingUser = {
        text: sanitizedUser,
        timestamp,
      };
    }

    if (type === 'assistant' && role === 'assistant' && pendingUser) {
      const assistantText = extractTextFromContent(content);
      if (!assistantText) continue;

      turns.push({
        sessionId: info.sessionId,
        traceId: '',
        timestamp: pendingUser.timestamp,
        userText: pendingUser.text,
        assistantText: sanitizeForPrompt(assistantText, MAX_TURN_TEXT_LEN),
        toolResults: accumulatedToolResults.slice(-MAX_TOOL_RESULTS_PER_TURN),
        ...(message.id && { responseId: message.id }),
      });

      pendingUser = null;
      accumulatedToolResults.length = 0;
    }
  }

  return turns;
}

/** Appended when a context item is cut to fit the judge's schema. */
export const CONTEXT_TRUNCATION_MARKER = '\n…[truncated to fit the judge input cap]';

/**
 * Fit tool results to what `testCaseSchema` accepts: at most the smaller of
 * MAX_TOOL_CONTEXT_ITEMS / MAX_CONTEXT_ITEMS entries, each at most
 * MAX_TEXT_LENGTH characters, so one oversized tool result cannot fail every
 * metric for its turn with "Invalid TestCase … too_big".
 */
export function fitContextForJudge(toolResults: readonly string[]): string[] {
  const itemLimit = Math.min(MAX_TOOL_CONTEXT_ITEMS, MAX_CONTEXT_ITEMS);
  return toolResults.slice(0, itemLimit).map(item =>
    item.length <= MAX_TEXT_LENGTH
      ? item
      : item.slice(0, MAX_TEXT_LENGTH - CONTEXT_TRUNCATION_MARKER.length) + CONTEXT_TRUNCATION_MARKER,
  );
}
