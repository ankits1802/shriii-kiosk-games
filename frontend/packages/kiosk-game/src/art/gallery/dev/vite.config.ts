import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Dev server for the art gallery and onboarding/report previews (visual QA only). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('../../../..', import.meta.url)),
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
});
