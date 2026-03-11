# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Low

- **L1** [x] `PARAM_ID_RE` min length 4 is arbitrary — document rationale or lower to 2; short IDs return cryptic "Invalid format" error (`src/api/api-constants.ts:26`)
- **L2** [x] `useShortcut` mutates ref during render (`actionRef.current = action`) — technically impure under React strict mode; previous `useEffect` form was safer (`src/contexts/KeyboardNavContext.tsx:23`)
- **L3** [x] CORS validation error leaks raw env var value in message — omit value from thrown error (`src/api/server.ts:22`)
