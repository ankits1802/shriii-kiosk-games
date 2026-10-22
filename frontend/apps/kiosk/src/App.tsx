import type { EventValidator, KioskRuntime, KioskRuntimeOptions } from '@shriii/kiosk-game';
import { KioskRuntimeView } from '@shriii/kiosk-game';
import { createArtKit } from '@shriii/kiosk-game/art';
import { AudioEngine } from '@shriii/kiosk-game/audio';
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useState } from 'react';
import type { KioskConfig } from './config.ts';

// Dev-only code is behind `import.meta.env.DEV` (statically replaced), so the dev panel and the
// 550 kB strict validator are dropped from production bundles.
const DevPanel = import.meta.env.DEV
  ? lazy(() => import('@shriii/kiosk-game').then((m) => ({ default: m.DevPanel })))
  : null;

const ART_FACTORY: NonNullable<KioskRuntimeOptions['artFactory']> = (app, layout) =>
  createArtKit({ app, layout });
const AUDIO_FACTORY: NonNullable<KioskRuntimeOptions['audioFactory']> = (clock) =>
  new AudioEngine({ clock });

async function loadDevValidator(bridge: boolean): Promise<EventValidator | null> {
  if (!import.meta.env.DEV && !bridge) return null;
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
    void loadDevValidator(config.bridge).then((v) => {
      if (alive) setValidate(() => v);
    });
    return () => {
      alive = false;
    };
  }, [config.bridge]);
  useEffect(() => {
    // Test bridge: scripted bots read the runtime (controller, input targets, outbox).
    if (!config.bridge) return;
    (globalThis as { __shriiiKiosk?: KioskRuntime | null }).__shriiiKiosk = runtime;
  }, [config.bridge, runtime]);
  const options = useMemo(
    () => ({
      apiBase: config.apiBase,
      dev: config.dev,
      mode: config.mode,
      siteMode: config.siteMode,
      arm: config.arm,
      strictTargets: import.meta.env.DEV,
      artFactory: ART_FACTORY,
      audioFactory: AUDIO_FACTORY,
      ...(config.kioskId ? { device: { kioskId: config.kioskId } } : {}),
      ...(config.deviceToken ? { deviceToken: config.deviceToken } : {}),
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
