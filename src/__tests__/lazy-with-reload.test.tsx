/**
 * A lazy page whose chunk vanished in a deploy reloads once, then fails
 * visibly (LAZY-CHUNK-STALE-AFTER-DEPLOY).
 *
 * Each "page load" below is a fresh `lazyWithReload` call, as a real reload
 * re-creates the module; the storage object stands in for sessionStorage,
 * which is what carries the guard across that reload.
 */

import { Suspense } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from 'react-error-boundary';
import { CHUNK_RELOAD_KEY, lazyWithReload, type ChunkReloadEnv } from '../lib/lazy-with-reload.js';

const STALE_CHUNK = 'Failed to fetch dynamically imported module';
const PAGE_TEXT = 'Workflow page';

function memoryStorage(): NonNullable<ChunkReloadEnv['storage']> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function Page() {
  return <p>{PAGE_TEXT}</p>;
}

const rejectStale = () => Promise.reject(new Error(STALE_CHUNK));
const resolvePage = () => Promise.resolve({ default: Page });

function renderPageLoad(load: () => Promise<{ default: typeof Page }>, env: ChunkReloadEnv) {
  const LazyPage = lazyWithReload(load, env);
  return render(
    <ErrorBoundary fallbackRender={({ error }) => <p role="alert">{(error as Error).message}</p>}>
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage />
      </Suspense>
    </ErrorBoundary>,
  );
}

afterEach(() => {
  cleanup();
});

describe('lazyWithReload', () => {
  it('reloads once on a rejected import and keeps showing the loading state', async () => {
    const env = { storage: memoryStorage(), reload: vi.fn() };

    renderPageLoad(rejectStale, env);

    await vi.waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error fallback, without reloading again, when the import is rejected after the reload', async () => {
    const env = { storage: memoryStorage(), reload: vi.fn() };
    renderPageLoad(rejectStale, env);
    await vi.waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1));
    cleanup();

    renderPageLoad(rejectStale, env);

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE_CHUNK);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('renders the page, and clears the guard so a later deploy can reload again', async () => {
    const env = { storage: memoryStorage(), reload: vi.fn() };
    env.storage.setItem(CHUNK_RELOAD_KEY, '1');

    renderPageLoad(resolvePage, env);

    expect(await screen.findByText(PAGE_TEXT)).toBeInTheDocument();
    expect(env.storage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('shows the error fallback instead of reloading when storage refuses the guard', async () => {
    const refusing = { ...memoryStorage(), setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } };
    const env = { storage: refusing, reload: vi.fn() };

    renderPageLoad(rejectStale, env);

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE_CHUNK);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('renders the page when storage refuses to clear the guard', async () => {
    const refusing = { ...memoryStorage(), removeItem: () => { throw new DOMException('denied', 'SecurityError'); } };
    const env = { storage: refusing, reload: vi.fn() };

    renderPageLoad(resolvePage, env);

    expect(await screen.findByText(PAGE_TEXT)).toBeInTheDocument();
  });

  it('shows the error fallback instead of reloading when storage is unavailable', async () => {
    const env = { storage: undefined, reload: vi.fn() };

    renderPageLoad(rejectStale, env);

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE_CHUNK);
    expect(env.reload).not.toHaveBeenCalled();
  });
});
