// Empty stub for @parent/ imports when the worker is bundled in CI without
// the parent observability-toolkit dist/. The worker does not consume any
// @parent exports directly; this stub only exists to satisfy wrangler's
// bundler when transitively-imported modules re-export from @parent.
export {};
