import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json-summary'],
    },
  },
});
