import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev server for the Pathway B set-2 micro-games and the carousel hub (visual QA, screenshot runs and
 * browser bot playthroughs). Not part of the library build.
 *
 *   npx vite --config src/games/hub/dev/vite.config.ts      ->  http://localhost:5311/?module=share_pot
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../..', import.meta.url)),
  server: { port: Number(process.env.SET2_PORT ?? 5311), strictPort: true },
  preview: { port: Number(process.env.SET2_PORT ?? 5311), strictPort: true },
});
