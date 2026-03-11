# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Medium

- **M1** [x] After L1 fix, `PARAM_ID_RE` and `PARAM_METRIC_NAME_RE` are identical patterns — alias one to the other or add explicit comment to document intentional separation (`src/api/api-constants.ts:26,28`)

### Low

- **L4** Regex `[\w.:\-]` has unescaped `-` escape — place `-` at end of class as `[\w.:-]` for idiomatic style (`src/api/api-constants.ts:26`)
- **L5** `useShortcut` silently no-ops when ctx is null (called outside provider) — add code comment to signal this is intentional (`src/contexts/KeyboardNavContext.tsx:21`)
- **L6** CORS validation throws synchronously with no log before exit — add `console.error` before throw to ensure message reaches logs (`src/api/server.ts:21-23`)
