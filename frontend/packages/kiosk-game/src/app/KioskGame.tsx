import { type CSSProperties, type ReactElement, useEffect } from 'react';
import type { DevFlags, SessionMode, SiteMode } from '../core/contracts.ts';

/** Props for the kiosk root component. */
export interface KioskGameProps {
  /** Session mode for sessions started on this kiosk (default `public`). */
  readonly mode?: SessionMode;
  /** Site mode from the deployment policy (default `supervised`). */
  readonly siteMode?: SiteMode;
  /** Development switches; all false in production builds. */
  readonly dev?: Partial<DevFlags>;
}

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  background: 'linear-gradient(180deg, #f6c56b 0%, #f0a35e 45%, #b8643c 100%)',
};

/**
 * Root of the kiosk experience. It owns the full-screen host element into which the engine mounts the
 * Pixi stage and the session statechart (attract -> ... -> wipe). The shell renders no text: the kiosk
 * needs no reading.
 */
export function KioskGame({
  mode = 'public',
  siteMode = 'supervised',
  dev,
}: KioskGameProps): ReactElement {
  // Kiosk hardening: no long-press/right-click context menu anywhere on the page (KSK-01).
  useEffect(() => {
    const block = (e: Event): void => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);
  return (
    <div
      data-testid="kiosk-game-root"
      data-mode={mode}
      data-site-mode={siteMode}
      data-dev-overlay={dev?.overlay === true ? 'on' : 'off'}
      style={rootStyle}
    >
      <div data-testid="kiosk-stage-host" style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
