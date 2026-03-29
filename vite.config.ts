import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { loadEnv } from 'vite';
import { parentDistStub } from './vite-plugins.js';

export default defineConfig(({ command, mode }) => {
  // Merge .env file vars with process.env VITE_* vars (process.env wins — allows CI injection)
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const merged: Record<string, string> = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VITE_') && v !== undefined) merged[k] = v;
  }

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
            if (id.includes('@xyflow') || id.includes('elkjs')) return 'workflow-viz';
          },
        },
      },
    },
    resolve: {
      alias: {
        '@parent': path.resolve(__dirname, '../dist'),
        'web-worker': path.resolve(__dirname, 'src/stubs/web-worker.ts'),
        ...(process.env.VITE_E2E ? {
          '@auth0/auth0-react': path.resolve(__dirname, 'src/stubs/auth0-e2e.ts'),
        } : {}),
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
      name: 'src',
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/setup.ts'],
      exclude: ['node_modules/**', 'scripts/__tests__/**', 'e2e/**', '.claude/worktrees/**'],
    },
  };
});
