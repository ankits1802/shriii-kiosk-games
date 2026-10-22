import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the built page also loads from file:// inside the kiosk shell.
  base: './',
  server: { port: 5180, strictPort: true },
  build: { target: 'es2023', sourcemap: true },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
