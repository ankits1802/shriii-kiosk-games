/**
 * Browser launcher for the module dev harness: `apps/kiosk?module=<id>&level=L2&lang=en-IN&seed=123`
 * starts one module standalone on a full-screen Pixi stage (no onboarding, no session statechart),
 * for screenshots, scripted bots and module development. The module is resolved through the module
 * registry exactly like in the session's play state (placeholder only when nothing is registered).
 *
 * For bots/screenshots the harness publishes its state on `globalThis.__shriiiHarness`:
 * `{ params, state: 'loading'|'running'|'ended', source, result, events() }`, and sets
 * `data-harness-state` on the host element.
 */
import type { EventEnvelope } from '@shriii/contracts';
import { Application, Container } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import type {
  ArtKit,
  AudioService,
  Clock,
  DevFlags,
  Layout,
  ModuleFactoryLookup,
  ModuleRegistry,
  ModuleResult,
  VoiceService,
} from '../core/contracts.ts';
import { SessionClock } from '../engine/clock.ts';
import { loadGameContent } from '../engine/content.ts';
import {
  type ModuleHarnessParams,
  type ModuleHarnessRun,
  runModuleHarness,
} from '../engine/dev-harness.ts';
import { BasicArtKit } from '../engine/fallbacks/basic-art.ts';
import { genericModuleFallback } from '../engine/fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../engine/fallbacks/silent-audio.ts';
import type { ModuleSource } from '../engine/registry.ts';
import { moduleRegistry } from '../engine/registry.ts';
import { DomInputService } from '../input/input-service.ts';
import { CSS_PX_PER_MM } from '../input/metrics.ts';
import type { EventValidator } from '../logging/event-logger.ts';
import { createHostLayout } from './runtime.ts';

/** Options for {@link launchModuleHarness}. */
export interface ModuleHarnessLaunchOptions {
  readonly registry?: ModuleRegistry | ModuleFactoryLookup;
  readonly dev?: Partial<DevFlags>;
  readonly pxPerMm?: number;
  readonly strictTargets?: boolean;
  readonly artFactory?: (app: Application, layout: Layout) => ArtKit;
  readonly audioFactory?: (clock: Clock) => AudioService;
  readonly voiceFactory?: (clock: Clock, audio: AudioService) => VoiceService;
  readonly validate?: EventValidator;
  /** Publish state on `globalThis.__shriiiHarness` (default true). */
  readonly expose?: boolean;
}

/** State published for bots and screenshot scripts. */
export interface ModuleHarnessHandle {
  readonly params: ModuleHarnessParams;
  readonly state: 'loading' | 'running' | 'ended';
  readonly source: ModuleSource | null;
  readonly result: ModuleResult | null;
  readonly run: ModuleHarnessRun;
  readonly app: Application;
  readonly input: DomInputService;
  readonly done: Promise<ModuleResult>;
  events(): Promise<EventEnvelope[]>;
  dispose(): void;
}

/** Start the harness inside `host` (a full-screen element). */
export async function launchModuleHarness(
  host: HTMLElement,
  params: ModuleHarnessParams,
  options: ModuleHarnessLaunchOptions = {},
): Promise<ModuleHarnessHandle> {
  const content = loadGameContent();
  const layout = createHostLayout(host, options.pxPerMm ?? CSS_PX_PER_MM);
  host.dataset.harnessState = 'loading';
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

  const clock = new SessionClock();
  const audio = options.audioFactory?.(clock) ?? new SilentAudioService(clock);
  const voice =
    options.voiceFactory?.(clock, audio) ?? new SilentVoiceService(clock, { lineMs: 600 });
  await voice.setLanguage(params.language);
  const art = options.artFactory?.(app, layout) ?? new BasicArtKit(layout, overlayLayer);
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: host,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: options.strictTargets ?? false,
    voice,
  });

  const run = runModuleHarness(params, {
    content,
    registry: options.registry ?? moduleRegistry,
    fallback: genericModuleFallback(content),
    clock,
    ...(options.dev ? { dev: options.dev } : {}),
    ...(options.validate ? { validate: options.validate } : {}),
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
  input.setLogger(run.logger);

  let state: ModuleHarnessHandle['state'] = 'running';
  let result: ModuleResult | null = null;
  host.dataset.harnessState = 'running';
  const done = run.result.then((r) => {
    state = 'ended';
    result = r;
    host.dataset.harnessState = 'ended';
    return r;
  });
  let disposed = false;
  const handle: ModuleHarnessHandle = {
    params,
    get state() {
      return state;
    },
    get source() {
      return run.source();
    },
    get result() {
      return result;
    },
    run,
    app,
    input,
    done,
    events: () => run.events(),
    dispose() {
      if (disposed) return;
      disposed = true;
      run.abort();
      audio.stopAll();
      voice.stop();
      input.dispose();
      app.renderer.off('resize', onResize);
      app.destroy({ removeView: true }, { children: true });
      const g = globalThis as { __shriiiHarness?: unknown };
      if (g.__shriiiHarness === handle) delete g.__shriiiHarness;
    },
  };
  if (options.expose !== false) {
    (globalThis as { __shriiiHarness?: unknown }).__shriiiHarness = handle;
  }
  return handle;
}
