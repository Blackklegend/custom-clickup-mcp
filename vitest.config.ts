import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // Process bootstrap: only exercised by actually spawning the stdio server.
      exclude: ['src/index.ts'],
      // Ratchet floors measured over the whole of src/. They are lower than the previous
      // 80% because that number only ever covered a hand-picked 9 files; these apply to
      // the tool modules too. Raise them as coverage improves, never lower them.
      thresholds: {
        statements: 78,
        branches: 60,
        functions: 88,
        lines: 81,
      },
    },
  },
});
