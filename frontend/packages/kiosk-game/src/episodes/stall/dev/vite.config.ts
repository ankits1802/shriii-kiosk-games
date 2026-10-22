import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev-only route for The Stall (visual QA, Playwright screenshots and bot playthroughs):
 *   npx vite --config src/episodes/stall/dev/vite.config.ts
 *   http://localhost:5347/?seed=123&level=L2&lang=en-IN[&speed=3][&autoplay=1][&tier=medium][&reduced=1]
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../..', import.meta.url)),
  server: {
    port: 5347,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../../../../../..', import.meta.url))] },
  },
});
