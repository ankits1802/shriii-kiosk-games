import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PW_PORT ?? 3100);
const here = fileURLToPath(new URL('.', import.meta.url));
const built = existsSync(`${here}.next/BUILD_ID`);

/**
 * Smoke tests against the production server (`next start`). The FastAPI backend is mocked at the
 * network layer (see e2e/fixtures.ts) so the suite needs no database; the mock derives each role's
 * permissions from apps/api rbac.py. `PW_DEV=1` runs against `next dev` instead.
 */
const command = process.env.PW_DEV
  ? `pnpm exec next dev --port ${PORT}`
  : built
    ? `pnpm exec next start --port ${PORT}`
    : `pnpm exec next build && pnpm exec next start --port ${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // The API is mocked in the browser; point the rewrite at a closed port so nothing leaks out.
    env: { API_PROXY_TARGET: 'http://127.0.0.1:9' },
  },
});
