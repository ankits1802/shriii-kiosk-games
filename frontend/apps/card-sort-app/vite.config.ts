import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the same bundle loads inside the Capacitor WebView.
  base: './',
  server: { port: 5175, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    outDir: 'dist',
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
