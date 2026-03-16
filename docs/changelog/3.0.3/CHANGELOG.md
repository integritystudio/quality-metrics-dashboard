# v3.0.3 (2026-03-16)

Follow-up backlog clearance: API regex style polish, error logging, and React context safety.

## Fixes

| ID | Title | Notes |
|----|----------|-------|
| L4 | Regex `[\w.:\-]` escaping — move `-` to end of character class | Changed `[\w.:\-]` to `[\w.:-]` for idiomatic regex style. The hyphen at the end of a character class doesn't need escaping, reducing visual noise. See `src/api/api-constants.ts:29`. |
| L5 | `useShortcut` context safety — already throws Error when called outside provider | Verified that attempting to use `useShortcut` outside `KeyboardNavProvider` throws a descriptive error message. No code change required. See `src/contexts/KeyboardNavContext.tsx:34`. |
| L6 | CORS validation logging — add `console.error` before throw | Added `console.error` with context object before throwing to ensure validation failures are logged before process exit. See `src/api/server.ts:22`. |

## Summary

- **Items resolved**: 3 (L4, L5, L6)
- **Code changes**: L4 (regex escaping), L6 (error logging); L5 (no change, already correct)
- **Test coverage**: All 399 tests pass
- **Deferral rationale**: Minor style and logging improvements deferred from v3.0.2 review scope
