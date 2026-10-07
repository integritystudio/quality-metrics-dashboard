/**
 * Shared span-extraction helpers used by both the API route (`sessions.ts`) and
 * the KV sync script (`sync-to-kv.ts`). Keeping them here (a single source of
 * truth) prevents the two paths from drifting, which was the root cause of
 * SESSION-DETAIL-DRIFT (see dashboard BACKLOG.md).
 *
 * Adding a field: update the helper here, then update both call sites.
 */

import { COMMIT_BODY_START_LINE_INDEX, COMMIT_SUBJECT_FALLBACK_MAX_CHARS, OTEL_STATUS_ERROR_CODE } from './api-constants.js';
import { spanAttr } from './api-constants.js';

/** Minimal shape required by the span-extraction helpers. */
export type ExtractableSpan = {
  name: string;
  status?: { code?: number | string };
  attributes?: Record<string, unknown>;
};

/**
 * Whether a span should count as an error.
 *
 * Accepts both the numeric OTel status code (`2`) and the string form
 * (`'ERROR'`) because cloud spans may carry either depending on the SDK
 * version that emitted them.
 */
export function isSpanError(span: ExtractableSpan): boolean {
  return (
    spanAttr(span, 'integritystudio.tool.has_error', 'boolean') === true ||
    spanAttr(span, 'integritystudio.agent.has_error', 'boolean') === true ||
    span.status?.code === OTEL_STATUS_ERROR_CODE ||
    span.status?.code === 'ERROR'
  );
}

export interface GitCommit {
  subject: string;
  body: string;
  files: string;
}

/** Parse a git commit from a post-commit-review span; returns `null` when no command is present. */
export function extractGitCommit(span: ExtractableSpan): GitCommit | null {
  const raw = spanAttr(span, 'integritystudio.git.command', 'string') ?? '';
  if (!raw) return null;
  const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
  const files = filesMatch ? (filesMatch[1] ?? '').trim() : '';
  const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
  const fullMessage = msgMatch ? msgMatch[1] ?? '' : '';
  return {
    subject: fullMessage ? (fullMessage.split('\n')[0] ?? '').trim() : raw.slice(0, COMMIT_SUBJECT_FALLBACK_MAX_CHARS),
    body: fullMessage ? fullMessage.split('\n').slice(COMMIT_BODY_START_LINE_INDEX).join('\n').trim() : '',
    files,
  };
}
