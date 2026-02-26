import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: '/',
  plugins: [react()],
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
    exclude: ['node_modules/**', 'scripts/__tests__/**'],
    server: {
      deps: {
        // Parent dist/ imports are mocked via vi.mock() in tests.
        // Mark external so vite doesn't fail resolving them in CI
        // where the parent repo isn't built.
        external: [/\.\.\/\.\.\/\.\.\/\.\.\/dist/],
      },
    },
  },
});
