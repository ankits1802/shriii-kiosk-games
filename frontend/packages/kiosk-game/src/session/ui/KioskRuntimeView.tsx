/**
 * Full-screen kiosk view: creates the runtime (Pixi stage, input, outbox, uploader, session
 * controller), renders the current state's screen over the stage, the persistent exit control and
 * the walkaway overlay. Screens from the onboarding/report agents plug in through `screens`.
 *
 * Crash wiring: screens render inside a {@link KioskErrorBoundary}, and `window` `error` /
 * `unhandledrejection` are forwarded to `SessionController.reportError` while the runtime lives, so
 * any unexpected failure ends the session with `CRASH` (expected aborts are ignored).
 */
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { installGlobalCrashHandlers } from '../crash-handlers.ts';
import type { KioskRuntime, KioskRuntimeOptions } from '../runtime.ts';
import type { KioskSessionView, SessionControllerEvent } from '../session-controller.ts';
import { STAGE_SCREEN_STATES } from '../stage-screens.ts';
import {
  ExitControl,
  FALLBACK_CSS,
  FALLBACK_SCREENS,
  type ScreenMap,
  WalkawayOverlay,
} from './FallbackScreens.tsx';
import { KioskErrorBoundary } from './KioskErrorBoundary.tsx';

export interface KioskRuntimeViewProps {
  readonly options: KioskRuntimeOptions;
  /** Screens per session state; missing states use the icon-only fallbacks. */
  readonly screens?: ScreenMap;
  /** Called once the runtime exists (devtools, Electron bridge). */
  readonly onRuntime?: (runtime: KioskRuntime | null) => void;
  /** Extra overlay content (e.g. the dev panel). */
  readonly children?: ReactNode;
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

const SESSION_STATES_WITH_EXIT = new Set([
  'languageSelect',
  'consent',
  'bands',
  'practiceWarmup',
  'play',
  'report',
  'survey',
  'contactOptIn',
]);

/** The stage screens draw these states on the Pixi stage: no React screen on top. */
function StageOwned(): null {
  return null;
}
const STAGE_BLANKS: ScreenMap = Object.fromEntries(
  [...STAGE_SCREEN_STATES].map((s) => [s, StageOwned]),
) as ScreenMap;

export function KioskRuntimeView({
  options,
  screens,
  onRuntime,
  children,
}: KioskRuntimeViewProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<KioskRuntime | null>(null);
  const [view, setView] = useState<KioskSessionView | null>(null);
  const [failed, setFailed] = useState(false);
  const optionsRef = useRef(options);
  const onRuntimeRef = useRef(onRuntime);
  onRuntimeRef.current = onRuntime;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let rt: KioskRuntime | null = null;
    let unsub: (() => void) | null = null;
    // Kiosk hardening: no long-press/right-click context menu (KSK-01).
    const block = (e: Event): void => e.preventDefault();
    document.addEventListener('contextmenu', block);
    void import('../runtime.ts')
      .then(({ createKioskRuntime }) => createKioskRuntime(host, optionsRef.current))
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        rt = created;
        const unsubView = created.controller.subscribe(setView);
        const uninstall =
          typeof window !== 'undefined'
            ? installGlobalCrashHandlers(window, (err) => created.controller.reportError(err))
            : () => undefined;
        unsub = () => {
          unsubView();
          uninstall();
        };
        setRuntime(created);
        onRuntimeRef.current?.(created);
      })
      .catch((err: unknown) => {
        console.error('[kiosk] runtime failed to start', err);
        setFailed(true);
      });
    return () => {
      disposed = true;
      document.removeEventListener('contextmenu', block);
      unsub?.();
      rt?.dispose();
      onRuntimeRef.current?.(null);
    };
  }, []);

  const send = useCallback(
    (event: SessionControllerEvent) => {
      if (!runtime) return;
      if (event.type === 'TOUCH_START') void runtime.audio.unlock();
      runtime.controller.send(event);
    },
    [runtime],
  );

  const all: ScreenMap = {
    ...FALLBACK_SCREENS,
    ...(runtime?.stageScreens ? STAGE_BLANKS : {}),
    ...screens,
  };
  const Screen = view ? all[view.state] : undefined;
  const pxPerMm = runtime?.layout.metrics.pxPerMm ?? 3.78;

  return (
    <div style={rootStyle} data-testid="kiosk-runtime" data-state={view?.state ?? 'boot'}>
      <style>{FALLBACK_CSS}</style>
      <div ref={hostRef} data-testid="kiosk-stage-host" style={{ position: 'absolute', inset: 0 }}>
        {runtime && view && Screen && (
          <KioskErrorBoundary
            resetKey={`${view.sessionId}|${view.state}`}
            onError={(err) => runtime.controller.reportError(err)}
          >
            <Screen view={view} controller={runtime.controller} send={send} pxPerMm={pxPerMm} />
          </KioskErrorBoundary>
        )}
        {runtime && view && SESSION_STATES_WITH_EXIT.has(view.state) && (
          <ExitControl send={send} pxPerMm={pxPerMm} />
        )}
        {view && <WalkawayOverlay stage={view.walkawayStage} />}
      </div>
      {failed && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: '#1d1d1b',
          }}
          data-testid="kiosk-out-of-service"
        />
      )}
      {children}
    </div>
  );
}
