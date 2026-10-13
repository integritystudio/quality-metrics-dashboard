/**
 * The Worker binding types obtool-api's `Bindings` names. The parity tests reach
 * that file through the fixture server's wire-row types, and this program cannot
 * load `@cloudflare/workers-types`, whose fetch types clash with Node's, so the
 * bindings are opaque here; nothing in scripts/ touches them.
 */
type D1Database = unknown;
type R2Bucket = unknown;
type KVNamespace = unknown;
