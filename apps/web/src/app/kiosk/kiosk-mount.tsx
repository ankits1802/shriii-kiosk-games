'use client';

import dynamic from 'next/dynamic';

/**
 * The kiosk game uses Pixi/WebGL, Web Audio, IndexedDB and the DOM at import time, so it is loaded
 * on the client only. The placeholder matches the kiosk's warm background so there is no flash.
 */
const KioskApp = dynamic(() => import('./kiosk-app'), {
  ssr: false,
  loading: () => (
    <div
      data-testid="kiosk-loading"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'linear-gradient(180deg, #f6c56b 0%, #f0a35e 45%, #b8643c 100%)',
      }}
    />
  ),
});

/** `entry` records which spec route was opened (/kiosk, /kiosk/session, ...); the statechart decides the screen. */
export function KioskMount({ entry }: { readonly entry: 'home' | 'session' | 'play' | 'results' }) {
  return <KioskApp entry={entry} />;
}
