import type { EventValidator, KioskRuntime } from '@shriii/kiosk-game';
import { KioskRuntimeView } from '@shriii/kiosk-game';
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useState } from 'react';
import type { KioskConfig } from './config.ts';

// Dev-only code is behind `import.meta.env.DEV` (statically replaced), so the dev panel and the
// 550 kB strict validator are dropped from production bundles.
const DevPanel = import.meta.env.DEV
  ? lazy(() => import('@shriii/kiosk-game').then((m) => ({ default: m.DevPanel })))
  : null;

async function loadDevValidator(): Promise<EventValidator | null> {
  if (!import.meta.env.DEV) return null;
  const [{ ajvEventValidator }, { validateEventEnvelope }] = await Promise.all([
    import('@shriii/kiosk-game'),
    import('@shriii/contracts/validators/event-envelope'),
  ]);
  return ajvEventValidator(validateEventEnvelope);
}

/**
 * Kiosk shell: the full-screen session view, plus (dev builds only) the hidden dev panel and strict
 * Ajv validation of every event. Requests fullscreen on the first touch in the browser build;
 * Electron already runs in kiosk mode.
 */
export function App({ config }: { readonly config: KioskConfig }): ReactElement | null {
  const [runtime, setRuntime] = useState<KioskRuntime | null>(null);
  const [validate, setValidate] = useState<EventValidator | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadDevValidator().then((v) => {
      if (alive) setValidate(() => v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const options = useMemo(
    () => ({
      apiBase: config.apiBase,
      dev: config.dev,
      mode: config.mode,
      siteMode: config.siteMode,
      arm: config.arm,
      strictTargets: import.meta.env.DEV,
      ...(config.pxPerMm ? { pxPerMm: config.pxPerMm } : {}),
      ...(validate ? { validate } : {}),
    }),
    [config, validate],
  );
  if (validate === undefined) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0 }}
      onPointerDown={() => {
        if (!window.shriiiKiosk && !document.fullscreenElement) {
          void document.documentElement.requestFullscreen?.().catch(() => undefined);
        }
      }}
    >
      <KioskRuntimeView options={options} onRuntime={setRuntime}>
        {DevPanel && (
          <Suspense fallback={null}>
            <DevPanel runtime={runtime} pin={config.devPin} />
          </Suspense>
        )}
      </KioskRuntimeView>
    </div>
  );
}
