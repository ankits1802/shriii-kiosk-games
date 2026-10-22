import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev server for the Pathway B set-1 micro-games (visual QA, screenshots, bot playthroughs).
 * `npx vite --config src/games/dont-tap/kit/dev/vite.config.ts` then open
 * `http://localhost:5310/?module=dont_tap&level=L2&lang=en-IN&seed=123[&bot=1][&rm=1]`.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../../..', import.meta.url)),
  server: { port: 5310, strictPort: true },
  preview: { port: 5310, strictPort: true },
});
