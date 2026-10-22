/**
 * Playwright config for the admin console suite. Reuses the app's base config (web server, browser)
 * but points at this directory, so the suite lives next to the feature code.
 *
 *   pnpm exec playwright test -c src/features/admin/e2e/playwright.admin.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../../../playwright.config';

const webDir = fileURLToPath(new URL('../../../../', import.meta.url));
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;

export default defineConfig({
  ...base,
  // The web server must start from the app directory (Playwright defaults to the config's folder).
  ...(server ? { webServer: { ...server, cwd: webDir } } : {}),
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /admin\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
});
