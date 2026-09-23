import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright owns tests/e2e (real-browser specs using @playwright/test's own test/expect,
    // which conflict with vitest's globals) — never picked up by the Node/pg-mem unit+integration
    // suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**', 'tests/e2e/**'],
  },
});
