import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build loads from file:// inside Electron.
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
