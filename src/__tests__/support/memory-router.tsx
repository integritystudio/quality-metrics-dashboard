import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { ReactNode } from 'react';
import { makeQueryWrapper } from './query-harness.js';

/**
 * {@link makeQueryWrapper} plus a recording wouter memory router mounted at `path`
 * (search params included), so pages read their route and query params for real
 * and navigation lands in `location.history`.
 */
export function makeRoutedQueryWrapper(path: string) {
  const location = memoryLocation({ path, record: true });
  const { wrapper: QueryWrapper, queryClient } = makeQueryWrapper();
  function RoutedQueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <Router hook={location.hook} searchHook={location.searchHook}>{children}</Router>
      </QueryWrapper>
    );
  }
  return { wrapper: RoutedQueryWrapper, location, queryClient };
}

/** The path the memory router last navigated to. */
export function currentPath(location: ReturnType<typeof makeRoutedQueryWrapper>['location']): string | undefined {
  return location.history.at(-1);
}
