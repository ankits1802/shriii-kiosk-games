import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Library-mode build config (used for bundle-size checks such as the logger SDK budget, ENG-07).
 * Apps consume the package from source via the workspace.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'kiosk-game' },
    sourcemap: true,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'pixi.js',
        'pixi-filters',
        'gsap',
        'xstate',
        '@xstate/react',
        'dexie',
        'zod',
      ],
    },
  },
});
