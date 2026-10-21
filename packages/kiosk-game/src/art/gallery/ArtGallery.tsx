/**
 * Storybook-like dev gallery: every backdrop x time of day, character role x expression x animation,
 * buttons and icons, particles, transitions, and live previews of the onboarding and report screens.
 *
 * Dev/QA tool only (the menu has developer text; player screens never do). Routes are URL hashes so the
 * Playwright screenshot run can visit each one: `#/backdrop/attract/golden_hour`, `#/characters`, ...
 * Append `?clean` to hide the menu.
 */
import { Application } from 'pixi.js';
import { type CSSProperties, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { registerAllGalleryRoutes } from './allRoutes.ts';
import { type GalleryRoute, galleryGroups, resolveRoute } from './routes.ts';

registerAllGalleryRoutes();

const menuStyle: CSSProperties = {
  position: 'fixed',
  top: 8,
  left: 8,
  zIndex: 10,
  maxHeight: 'calc(100vh - 16px)',
  overflowY: 'auto',
  background: 'rgba(27,24,56,0.86)',
  color: '#fff4de',
  font: '13px/1.4 system-ui, sans-serif',
  borderRadius: 10,
  padding: '8px 10px',
  boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
};

function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
}

/** Props for {@link ArtGallery}. */
export interface ArtGalleryProps {
  /** Initial route when the URL has no hash (default: the attract backdrop). */
  readonly initialRoute?: string;
  /** Hide the developer menu (screenshots). Defaults to `?clean` in the URL. */
  readonly clean?: boolean;
}

/** The dev gallery React component. Mounts its own Pixi application full-screen. */
export function ArtGallery({ initialRoute, clean }: ArtGalleryProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [route, setRoute] = useState<string>(
    () => currentHash() || initialRoute || '/backdrop/attract/golden_hour',
  );
  const [app, setApp] = useState<Application | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'rendering' | 'shown'>('booting');
  const hideMenu =
    clean ??
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('clean'));

  useEffect(() => {
    const onHash = (): void => setRoute(currentHash() || '/backdrop/attract/golden_hour');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let disposed = false;
    const a = new Application();
    const host = hostRef.current;
    void (async () => {
      await a.init({
        resizeTo: window,
        background: 0x1b1838,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        preference: 'webgl',
      });
      if (disposed || !host) {
        a.destroy(true, { children: true });
        return;
      }
      host.appendChild(a.canvas);
      a.canvas.style.display = 'block';
      (globalThis as { __PIXI_APP__?: Application }).__PIXI_APP__ = a;
      setApp(a);
      setStatus('ready');
    })();
    return () => {
      disposed = true;
      setApp(null);
      if (a.renderer) a.destroy(true, { children: true });
    };
  }, []);

  const resolved = useMemo<GalleryRoute | null>(() => resolveRoute(route), [route]);

  useEffect(() => {
    if (!app || !resolved) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    setStatus('rendering');
    void Promise.resolve(resolved.mount(app, resolved.params)).then((c) => {
      if (cancelled) {
        c();
        return;
      }
      cleanup = c;
      // Let a few frames settle (filters, baked textures) before declaring the scene shown.
      let frames = 0;
      const tick = (): void => {
        frames++;
        if (frames > 20) {
          app.ticker.remove(tick);
          setStatus('shown');
        }
      };
      app.ticker.add(tick);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [app, resolved]);

  return (
    <div
      style={{ position: 'fixed', inset: 0 }}
      data-testid="art-gallery"
      data-status={status}
      data-route={route}
    >
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {!hideMenu && (
        <nav style={menuStyle} aria-label="Gallery routes">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Mela gallery (dev)</div>
          {galleryGroups().map((group) => (
            <details key={group.title} open={route.startsWith(group.prefix)}>
              <summary style={{ cursor: 'pointer' }}>{group.title}</summary>
              {group.items.map((it) => (
                <div key={it.path}>
                  <a
                    href={`#${it.path}`}
                    style={{
                      color: route === it.path ? '#f6b11f' : '#fff4de',
                      textDecoration: 'none',
                    }}
                  >
                    {it.label}
                  </a>
                </div>
              ))}
            </details>
          ))}
        </nav>
      )}
    </div>
  );
}
