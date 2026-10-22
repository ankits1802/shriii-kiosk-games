import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev route for The Weighing Post (visual QA, scripted bot runs, screenshots). Not part of any build:
 * `npx vite --config src/episodes/weighing-post/dev/vite.config.ts` then open
 * http://localhost:5383/?level=L2&lang=en-IN&seed=123[&bot=1][&form=form_2][&reduced=1][&tier=medium]
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../../../../..', import.meta.url)),
  // No HMR or file watching: other packages change under parallel development and a reload would
  // restart a scripted playthrough mid-run.
  server: { port: 5383, strictPort: true, hmr: false, watch: null },
});
