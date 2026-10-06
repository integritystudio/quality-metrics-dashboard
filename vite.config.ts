import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { loadEnv } from 'vite';
import { parentDistStub } from './vite-plugins.js';
import { API_HOST, API_PORT } from './src/api/config.js';

/**
 * data-loader keeps one CloudBackend per test file, so its circuit breaker
 * carries one test's injected 500s (fixture `failPath`) into the next test and
 * fails it fast with "circuit breaker is open". Route tests do not exercise the
 * breaker, so it is held closed for them.
 */
const TEST_CIRCUIT_BREAKER_MAX_FAILURES = String(Number.MAX_SAFE_INTEGER);

export default defineConfig(({ command, mode }) => {
  // Merge .env file vars with process.env VITE_* vars (process.env wins — allows CI injection)
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const merged: Record<string, string> = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VITE_') && v !== undefined) merged[k] = v;
  }
  // The SPA always calls /api on its own origin; in dev this proxy forwards it
  // server to server. API_PROXY_TARGET (shell or .env) points it at a deployed
  // Worker instead of the local API server. It has no VITE_ prefix, so it never
  // reaches the bundle.
  const apiProxyTarget = loadEnv(mode, process.cwd(), 'API_PROXY_').API_PROXY_TARGET
    || `http://${API_HOST}:${API_PORT}`;

  return {
    base: '/',
    define: command === 'build' ? Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])
    ) : {},
    plugins: [
      react(),
      ...(process.env.VITEST ? [parentDistStub()] : []),
    ],
    build: {
      rolldownOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('react') && id.includes('react-dom')) return 'react';
            if (id.includes('@tanstack/react-query')) return 'query';
            // No forced chunk for @xyflow/elkjs: WorkflowPage is the sole
            // consumer and is lazy, so they land in its async chunk. Forcing
            // them into a named chunk pulled shared modules in with them,
            // which made the entry import the chunk statically — 1.6 MB of
            // modulepreload plus a render-blocking stylesheet on first paint.
          },
        },
      },
    },
    resolve: {
      alias: {
        '@parent': path.resolve(import.meta.dirname, '../dist'),
        'web-worker': path.resolve(import.meta.dirname, 'src/stubs/web-worker.ts'),
        ...(process.env.VITE_E2E ? {
          '@auth0/auth0-react': path.resolve(import.meta.dirname, 'src/stubs/auth0-e2e.ts'),
        } : {}),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      name: 'src',
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/setup.ts'],
      env: { CIRCUIT_BREAKER_MAX_FAILURES: TEST_CIRCUIT_BREAKER_MAX_FAILURES },
      exclude: ['node_modules/**', 'scripts/__tests__/**', 'e2e/**', '.claude/worktrees/**'],
    },
  };
});
