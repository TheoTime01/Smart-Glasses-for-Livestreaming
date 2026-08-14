import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit/integration tests only. The e2e/ directory belongs to Playwright,
    // which owns its own runner (`npm run test:e2e`).
    include: ['test/**/*.test.ts'],
  },
});
