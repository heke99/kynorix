import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.e2e.test.ts'],
    passWithNoTests: true,
    testTimeout: 60_000,
  },
});
