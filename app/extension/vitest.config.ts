import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __LV_DEV_ALLOW_HTTP__: 'false' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
