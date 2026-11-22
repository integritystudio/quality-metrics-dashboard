/**
 * The fetch the pipeline's HTTP clients use when not handed one: ingest posts,
 * the Anthropic client and the cloud readers.
 *
 * A Node entry point installs the HTTP/1.1 fetch (`runIfMain` does, for every
 * CLI), because Node's built-in one keeps reusing a destroyed HTTP/2 session
 * (NODE-FETCH-HTTP2-DEAD-SESSION). That fetch imports undici, which neither
 * loads under workerd nor type-checks against the Workers types, so no module a
 * Worker bundles may import it, lazily or not. Unset, the platform fetch is
 * looked up per call, which is what a Worker and a test stub want.
 */

type FetchFn = typeof globalThis.fetch;

let installed: FetchFn | undefined;

/** Set (or with `undefined`, clear) the fetch `scriptFetch` returns. */
export function setScriptFetch(fetchFn: FetchFn | undefined): void {
  installed = fetchFn;
}

/**
 * Resolved on each request, not when taken: a client built before the entry
 * point installs its fetch still sends over the installed one.
 */
export function scriptFetch(): FetchFn {
  return async (input, init): Promise<Response> => (installed ? installed(input, init) : globalThis.fetch(input, init));
}
