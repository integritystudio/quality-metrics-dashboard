/**
 * The entry-point wrapper every pipeline CLI runs under. Node-only: it installs
 * the HTTP/1.1 fetch, which imports undici, so nothing a Worker bundles may
 * import this module.
 */

import { pathToFileURL } from 'node:url';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import { setScriptFetch } from './script-fetch.js';

const FATAL_EXIT_CODE = 1;

export type RunIfMainOptions = {
  fatalExitCode?: number;
}

/**
 * Run `main()` only when this module is the entry point, over the HTTP/1.1
 * fetch (`script-fetch.ts`). Sets `process.exitCode` rather than calling
 * `process.exit`, so buffered stdout and stderr are flushed.
 */
export function runIfMain(
  moduleUrl: string,
  main: () => Promise<unknown>,
  logPrefix: string,
  { fatalExitCode = FATAL_EXIT_CODE }: RunIfMainOptions = {},
): void {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  setScriptFetch(http1Fetch);
  main()
    .then(code => { if (typeof code === 'number') process.exitCode = code; })
    .catch((err: unknown) => {
      console.error(`${logPrefix} fatal:`, err);
      process.exitCode = fatalExitCode;
    });
}
