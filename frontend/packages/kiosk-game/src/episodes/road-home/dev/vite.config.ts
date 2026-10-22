import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Dev server for the Road Home episode (visual QA, Playwright screenshots and bot runs only). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../../../..', import.meta.url)),
  server: { port: Number(process.env.ROAD_HOME_PORT ?? 5377), strictPort: true },
});
