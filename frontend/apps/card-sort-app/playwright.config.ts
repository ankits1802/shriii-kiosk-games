import { defineConfig, devices } from '@playwright/test';

/** Smoke test against the production web bundle (`vite preview` of dist/, IndexedDB storage). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'tablet-chromium',
      use: { ...devices['Galaxy Tab S4'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
