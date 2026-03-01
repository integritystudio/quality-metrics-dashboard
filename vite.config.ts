import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const PARENT_DIST_RE = /\.\.\/\.\.\/\.\.(?:\/\.\.)*\/dist\//;

/**
 * Vitest plugin: stub parent dist/ imports so tests pass in CI
 * where the parent monorepo isn't built. vi.mock() provides
 * implementations; this just prevents vite:import-analysis errors.
 */
function parentDistStub(): Plugin {
  return {
    name: 'parent-dist-stub',
    enforce: 'pre',
    resolveId(source) {
      if (PARENT_DIST_RE.test(source)) {
        return '\0' + source.replace(/^(?:\.\.\/)+/, '');
      }
    },
    load(id) {
      if (id.startsWith('\0dist/')) {
        return 'export {};';
      }
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    ...(process.env.VITEST ? [parentDistStub()] : []),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@parent': path.resolve(__dirname, '../dist'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    exclude: ['node_modules/**', 'scripts/__tests__/**', 'e2e/**'],
  },
});
