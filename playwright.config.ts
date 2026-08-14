import { defineConfig, devices } from '@playwright/test';

const PORT = 3399;
const STUB_PORT = 4599;

/**
 * The glasses UI is verified in a real browser at exactly 600x600 with keyboard
 * input only — that is the whole point of these tests, so no other viewport or
 * input device is configured.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 600, height: 600 },
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      // Keeps the suite offline, free and side-effect free.
      command: `node e2e/apivideo-stub.mjs ${STUB_PORT}`,
      url: `http://127.0.0.1:${STUB_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run build && node dist/server.js',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(PORT),
        HOST: '127.0.0.1',
        API_VIDEO_KEY: 'e2e-key',
        API_VIDEO_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
        JWT_SECRET: 'e2e-secret',
        // Each test pairs a fresh device; the production default would throttle
        // the suite itself.
        PAIR_CLAIM_LIMIT: '200',
        DATA_DIR: 'data/e2e',
        PROBE_LOG_DIR: 'data/e2e/probe',
        CONTROL_TOKEN: '',
      },
    },
  ],
});
