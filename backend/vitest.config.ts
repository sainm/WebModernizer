import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests touch the real filesystem and SQLite; keep them sequential.
    fileParallelism: false,
    testTimeout: 30000,
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
