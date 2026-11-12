import { defineConfig } from 'vitest/config';

// PBKDF2 runs 600,000 iterations on every account creation / unlock: allow plenty of time.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
