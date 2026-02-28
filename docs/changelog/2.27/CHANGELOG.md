# 2.27 — Cross-session Agent Stats

**Date**: 2026-02-27

## Features

- **Cross-session agent aggregation** (`scripts/sync-to-kv.ts`): accumulates agent activity across all sessions into `agent:${agentName}` KV entries with RED metrics (error rate, avg/p95 duration), output quality signals (truncated rate, empty output rate, avg output size), rate limit event count, and last 20 sessions with project context
- **Agent list endpoint** (`GET /api/agents`): returns all known agents sorted by invocation count from `meta:agents` KV key
- **Agent detail endpoint** (`GET /api/agents/detail/:agentId`): returns full cross-session stats for a named agent with input validation

## Fixes (from code review)

- **H1**: Replace unbounded per-invocation `durations[]` array with `weightedDurationSum` + `sessionDurations[]` (one entry per session) — O(sessions) not O(invocations)
- **H2**: Add `agentId` input validation — reject non-`[\w:.-]` chars and >200 length
- **H3**: Extract `totalSessions` before `.slice(0, 20)` to prevent silent count bug on future refactor
- **H4**: Rename `/api/agent` to `/api/agents`, `/api/agent/:agentId` to `/api/agents/detail/:agentId` for API naming consistency

## Commits

- `45e425a` feat(agent-stats): add cross-session agent aggregation and KV-backed API endpoints
- `bfb65da` fix(agent-stats): address code-review findings and add backlog
