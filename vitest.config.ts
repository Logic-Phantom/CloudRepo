import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: { REPOVAULT_QUIET: '1', REPOVAULT_MIN_FREE_BYTES: '0' },
  },
});
