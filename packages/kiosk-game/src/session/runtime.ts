/**
 * Kiosk runtime assembly: Pixi stage, input layer, outbox (IndexedDB with in-memory fallback),
 * uploader, module host and session controller. Art, audio, voice, modules and report are injected
 * through the `core/contracts.ts` interfaces; when a provider is absent a minimal fallback is used
 * so the kiosk stays fully playable (and fully offline) on its own.
 */
import type { BatteryArm, CalibrationPolicy, SessionMode, SiteMode } from '@shriii/contracts';
import { Application, Container } from 'pixi.js';
// CSP-safe shader/uniform paths (no `new Function`), required by the Electron shell's strict CSP.
import 'pixi.js/unsafe-eval';
import type {
  ArtKit,
  AudioService,
  Clock,
  DevFlags,
  Layout,
  ModuleRegistry,
  ReportModel,
  SessionSnapshot,
  VoiceService,
} from '../core/contracts.ts';
import { LocalStorageKeyValueStore } from '../engine/assignment.ts';
import { SessionClock } from '../engine/clock.ts';
import { loadGameContent } from '../engine/content.ts';
import { BasicArtKit } from '../engine/fallbacks/basic-art.ts';
import { genericModuleFallback } from '../engine/fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../engine/fallbacks/silent-audio.ts';
import { ModuleHost } from '../engine/module-host.ts';
import { measureRefreshHz } from '../engine/timing.ts';
import { DomInputService } from '../input/input-service.ts';
import { CSS_PX_PER_MM, physicalMetrics } from '../input/metrics.ts';
import type { EventValidator } from '../logging/event-logger.ts';
import { DexieOutbox } from '../logging/outbox/dexie-outbox.ts';
import { MemoryOutbox } from '../logging/outbox/memory-outbox.ts';
import type { KioskOutbox } from '../logging/outbox/types.ts';
import { recoverInterruptedSessions } from '../logging/recovery.ts';
import { BatchUploader } from '../logging/uploader.ts';
import { developmentDeviceConfig, type KioskDeviceConfig } from './device.ts';
import { SessionController } from './session-controller.ts';

export interface KioskRuntimeOptions {
  /** API base URL; empty/undefined = offline only (the queue persists). */
  readonly apiBase?: string | null;
  readonly dev: DevFlags;
  readonly mode?: SessionMode;
  readonly siteMode?: SiteMode;
  readonly arm?: BatteryArm | 'randomised';
  readonly calibrationPolicy?: CalibrationPolicy;
  /** Stage px per mm of glass for this SKU (default CSS 96 dpi). */
  readonly pxPerMm?: number;
  /** Throw on undersized targets (dev builds). */
  readonly strictTargets?: boolean;
  readonly device?: Partial<KioskDeviceConfig>;
  readonly registry?: ModuleRegistry;
  readonly artFactory?: (app: Application, layout: Layout) => ArtKit;
  readonly audioFactory?: (clock: Clock) => AudioService;
  readonly voiceFactory?: (clock: Clock, audio: AudioService) => VoiceService;
  readonly reportProvider?: (snapshot: SessionSnapshot) => ReportModel;
  /** Strict event validation (dev builds). */
  readonly validate?: EventValidator;
  readonly offerContactOptIn?: boolean;
}

export interface KioskRuntime {
  readonly controller: SessionController;
  readonly outbox: KioskOutbox;
  readonly uploader: BatchUploader;
  readonly input: DomInputService;
  readonly app: Application;
  readonly layout: Layout;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  readonly device: KioskDeviceConfig;
  dispose(): void;
}

/** Layout that tracks the host element size. */
function createHostLayout(host: HTMLElement, pxPerMm: number): Layout & { refresh(): void } {
  const listeners = new Set<(l: Layout) => void>();
  const metrics = physicalMetrics(pxPerMm);
  const layout = {
    width: 0,
    height: 0,
    safeArea: { x: 0, y: 0, width: 0, height: 0 },
    orientation: 'landscape' as 'landscape' | 'portrait',
    metrics,
    onChange(listener: (l: Layout) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      const r = host.getBoundingClientRect();
      const margin = 8 * metrics.pxPerMm;
      layout.width = Math.max(1, r.width);
      layout.height = Math.max(1, r.height);
      layout.orientation = r.width >= r.height ? 'landscape' : 'portrait';
      layout.safeArea = {
        x: margin,
        y: margin,
        width: Math.max(1, r.width - 2 * margin),
        height: Math.max(1, r.height - 2 * margin),
      };
      for (const l of listeners) l(layout);
    },
  };
  layout.refresh();
  return layout;
}

async function openOutbox(kioskId: string): Promise<KioskOutbox> {
  if (typeof indexedDB === 'undefined') return new MemoryOutbox({ kioskId });
  try {
    const outbox = new DexieOutbox({ kioskId });
    await outbox.open();
    return outbox;
  } catch (err) {
    console.error(
      '[kiosk] IndexedDB unavailable; using in-memory outbox (data lost on reload)',
      err,
    );
    return new MemoryOutbox({ kioskId });
  }
}

/** Build and start the kiosk runtime inside `host` (a full-screen element). */
export async function createKioskRuntime(
  host: HTMLElement,
  options: KioskRuntimeOptions,
): Promise<KioskRuntime> {
  const content = loadGameContent();
  const store = new LocalStorageKeyValueStore();
  const device = developmentDeviceConfig(store, {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.siteMode ? { siteMode: options.siteMode } : {}),
    ...options.device,
  });
  const pxPerMm = options.pxPerMm ?? CSS_PX_PER_MM;
  const layout = createHostLayout(host, pxPerMm);

  const app = new Application();
  await app.init({
    resizeTo: host,
    background: 0xb8643c,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
  });
  app.canvas.style.position = 'absolute';
  app.canvas.style.inset = '0';
  app.canvas.style.touchAction = 'none';
  host.appendChild(app.canvas);
  const moduleLayer = new Container();
  const overlayLayer = new Container();
  app.stage.addChild(moduleLayer, overlayLayer);
  const onResize = (): void => layout.refresh();
  app.renderer.on('resize', onResize);

  const refreshHz = await measureRefreshHz(undefined, 20).catch(() => 60);
  const runtimeClock = new SessionClock();
  const audio = options.audioFactory?.(runtimeClock) ?? new SilentAudioService(runtimeClock);
  const voice =
    options.voiceFactory?.(runtimeClock, audio) ??
    new SilentVoiceService(runtimeClock, { lineMs: 600 });
  const art = options.artFactory?.(app, layout) ?? new BasicArtKit(layout, overlayLayer);
  const input = new DomInputService({
    clock: runtimeClock,
    metrics: layout.metrics,
    element: host,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: options.strictTargets ?? false,
    voice,
  });

  const outbox = await openOutbox(device.kioskId);
  // Crash policy (KSK-02/ENG-07): sessions a dead renderer left open are abandoned with
  // `crash_recovery` (consented) or purged (never consented) before anything uploads.
  const recovery = await recoverInterruptedSessions(outbox, {
    ...(options.validate ? { validate: options.validate } : {}),
  });
  if (recovery.failed.length > 0) console.error('[kiosk] crash recovery failed', recovery.failed);
  const uploader = new BatchUploader({ outbox, apiBase: options.apiBase ?? null });
  const runner = new ModuleHost({
    content,
    registry: options.registry ?? {},
    dev: options.dev,
    fallback: genericModuleFallback(content),
    services: {
      app,
      layout,
      audio,
      voice,
      input,
      art,
      createStage: () => {
        const c = new Container();
        moduleLayer.addChild(c);
        return c;
      },
      releaseStage: (c) => {
        moduleLayer.removeChild(c);
        c.destroy({ children: true });
      },
    },
  });
  const controller = new SessionController({
    content,
    outbox,
    store,
    uploader,
    runner,
    device,
    refreshHz,
    input,
    ...(options.arm ? { arm: options.arm } : {}),
    ...(options.calibrationPolicy ? { calibrationPolicy: options.calibrationPolicy } : {}),
    ...(options.validate ? { validate: options.validate } : {}),
    ...(options.reportProvider ? { reportProvider: options.reportProvider } : {}),
    ...(options.offerContactOptIn !== undefined
      ? { offerContactOptIn: options.offerContactOptIn }
      : {}),
    clockFactory: () => new SessionClock({ profile: { ...runtimeClock.profile, refreshHz } }),
    onError: (err) => console.error('[kiosk] session error', err),
  });
  // Wipe: the session ending also stops audio (no trace of the previous player).
  const unsub = controller.subscribe((v) => {
    if (v.state === 'wipe') {
      audio.stopAll();
      voice.stop();
    }
  });
  uploader.start();

  return {
    controller,
    outbox,
    uploader,
    input,
    app,
    layout,
    audio,
    voice,
    device,
    dispose() {
      unsub();
      controller.dispose();
      uploader.stop();
      input.dispose();
      app.renderer.off('resize', onResize);
      app.destroy({ removeView: true }, { children: true });
      if (outbox instanceof DexieOutbox) outbox.close();
    },
  };
}
