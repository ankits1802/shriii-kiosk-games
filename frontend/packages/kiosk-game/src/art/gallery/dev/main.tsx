/**
 * Dev-only entry for the art gallery (`pnpm --filter @shriii/kiosk-game gallery`).
 * Not part of the library build; used for visual QA and the Playwright screenshot runs.
 */
import { gsap } from 'gsap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArtGallery } from '../ArtGallery.tsx';

// Headless QA renders slowly in software; keep tweens on wall-clock time so screenshots are accurate.
gsap.ticker.lagSmoothing(0);

const container = document.getElementById('root');
if (!container) throw new Error('gallery: #root missing');
createRoot(container).render(
  <StrictMode>
    <ArtGallery />
  </StrictMode>,
);
