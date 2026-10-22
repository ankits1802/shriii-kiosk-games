/**
 * Playwright config for the research pages against a LIVE API (CI only: postgres + `shriii-api
 * demo-pipeline --fast` + `shriii-api serve`). Nothing is mocked; the app's rewrites proxy /api/v1 to
 * API_PROXY_TARGET (default http://127.0.0.1:8000).
 *
 *   API_PROXY_TARGET=http://127.0.0.1:8000 pnpm exec playwright test -c src/features/research/e2e/playwright.live.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../../../playwright.config';

const webDir = fileURLToPath(new URL('../../../../', import.meta.url));
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000';

export default defineConfig({
  ...base,
  ...(server ? { webServer: { ...server, cwd: webDir, env: { API_PROXY_TARGET: target } } } : {}),
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /live\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  use: { ...base.use, screenshot: 'on', trace: 'retain-on-failure' },
});
