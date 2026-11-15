import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// End-to-end scenarios: real server app in-process, one Postgres container (Testcontainers),
// and engine-backed "virtual phones". PBKDF2 (600,000 iterations) runs in every account creation.
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    globalSetup: ['test/global-setup.ts'],
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    maxWorkers: 2,
  },
});
