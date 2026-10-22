/**
 * Playwright config for the research console suite. Reuses the app's base config (web server,
 * browser) but points at this directory, so the suite lives next to the feature code.
 *
 *   pnpm exec playwright test -c src/features/research/e2e/playwright.research.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../../../playwright.config';

const webDir = fileURLToPath(new URL('../../../../', import.meta.url));
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;

export default defineConfig({
  ...base,
  ...(server ? { webServer: { ...server, cwd: webDir } } : {}),
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /research\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  use: { ...base.use, screenshot: 'only-on-failure' },
});
