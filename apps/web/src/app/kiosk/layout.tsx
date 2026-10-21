import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Kiosk',
  description: 'SHRIII village-market behavioural games (full-screen public kiosk).',
};

/** Kiosk glass: no pinch zoom, full bleed, no console chrome or providers. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#f0a35e',
};

export default function KioskLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 overflow-hidden select-none"
      style={{ touchAction: 'none', background: '#b8643c' }}
    >
      {children}
    </div>
  );
}
