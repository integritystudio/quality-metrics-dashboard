/**
 * Resolve after `ms`. Built on the global `setTimeout`, not
 * `node:timers/promises`, so tests that install fake timers control it.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
