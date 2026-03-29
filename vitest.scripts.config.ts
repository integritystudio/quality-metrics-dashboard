import { defineConfig } from 'vitest/config';
import path from 'path';
import { parentDistStub, parentSrcToDistRedirect } from './vite-plugins.js';

const PARENT_SRC = path.resolve(__dirname, '../src');
const PARENT_DIST = path.resolve(__dirname, '../dist');

export default defineConfig({
  plugins: [parentDistStub(), parentSrcToDistRedirect(PARENT_SRC, PARENT_DIST)],
  resolve: {
    alias: {
      '@parent': PARENT_DIST,
    },
  },
  test: {
    name: 'scripts',
    environment: 'node',
    setupFiles: [],
    include: ['scripts/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.claude/**'],
  },
});
