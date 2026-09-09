import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is the bootstrap; types.ts declares interfaces only and
      // compiles to no runtime code, so neither is meaningfully coverable.
      exclude: ['src/index.ts', 'src/api/types.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
