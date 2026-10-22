/**
 * MG-10 carousel hub: a {@link ModuleRunner} decorator that plays the guide-hosted fair-map bridge
 * before every Pathway B module, then hands the module to the inner runner (normally the
 * `ModuleHost`). Order is never decided here: the session's play state already runs the fixed
 * carousel order from `content/games/session-plan.json` (5 core modules + the seeded slot); the hub
 * only shows that order on the map and walks the player along it.
 *
 * Budget (plan §4.4): all hub bridges together stay within `segments_max_s.bridges` (30 s), so each
 * of the six bridges gets at most a sixth of it (and never more than 5 s, MG-10 "audio bridges are
 * <= 5 s"). A bridge is cut short the moment the session aborts. Bridges are not scorable and log no
 * events (the voice service records its own `audio.played`).
 *
 * Integrator wiring (frontend/packages/kiosk-game/src/session/runtime.ts or the app):
 *
 *   const host = new ModuleHost({...});
 *   const runner = new CarouselHubRunner({ inner: host, services, plan: content.plan });
 *   new SessionController({ ..., runner });
 */
import type { SessionPlan } from '@shriii/contracts';
import { gsap } from 'gsap';
import { type Container, Graphics } from 'pixi.js';
import type {
  ArtKit,
  AudioService,
  Clock,
  Layout,
  MicroGameId,
  ModuleId,
  ModuleResult,
  SfxId,
  SfxOptions,
  VoiceService,
} from '../../core/contracts.ts';
import type { ModuleRunner, ModuleRunRequest } from '../../engine/module-host.ts';
import { FairMap } from './FairMap.ts';
import { hasRenderer } from './kit/runtime.ts';
import { GameStage, type StageHost } from './kit/stage.ts';

/** Services the hub draws with (a subset of the engine's `PlayServices`). */
export interface HubServices {
  readonly app: unknown;
  readonly layout: Layout;
  readonly art: ArtKit;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  createStage(moduleId: ModuleId): Container;
  releaseStage(stage: Container): void;
}

export interface CarouselHubOptions {
  readonly inner: ModuleRunner;
  readonly services: HubServices;
  readonly plan: SessionPlan;
  /** Per-bridge cap in ms (default: `segments_max_s.bridges` / 6, at most 5000). */
  readonly bridgeMs?: number;
  /** Skip the visual bridge (headless bots, tests). */
  readonly headless?: boolean;
  /** Dev tooling: notified when a bridge starts/ends. */
  readonly onBridge?: (info: {
    readonly to: ModuleId;
    readonly index: number;
    readonly phase: 'start' | 'end';
  }) => void;
}

/** The fixed carousel order for a session: core order plus the session's slot module. */
export function carouselOrder(plan: SessionPlan, slot: string | null): MicroGameId[] {
  const core = plan.pathways.B.core_order as MicroGameId[];
  return slot ? [...core, slot as MicroGameId] : [...core];
}

/** Per-bridge budget from the session plan (ms). */
export function bridgeBudgetMs(plan: SessionPlan, modules: number): number {
  const total = plan.segments_max_s.bridges * 1000;
  return Math.min(5000, Math.floor(total / Math.max(1, modules)));
}

export class CarouselHubRunner implements ModuleRunner {
  private readonly opts: CarouselHubOptions;
  /** Booths already played per session (by session id). */
  private readonly played = new Map<string, number>();

  constructor(options: CarouselHubOptions) {
    this.opts = options;
  }

  /** Record that `count` booths of a session were already played (resumed dev previews). */
  markPlayed(sessionId: string, count: number): void {
    this.played.set(sessionId, count);
  }

  async run(req: ModuleRunRequest): Promise<ModuleResult> {
    const order = carouselOrder(this.opts.plan, req.session.slotForm);
    const index = order.indexOf(req.moduleId as MicroGameId);
    if (req.session.pathway === 'B' && index >= 0 && !req.signal.aborted) {
      const budget = this.opts.bridgeMs ?? bridgeBudgetMs(this.opts.plan, order.length);
      this.opts.onBridge?.({ to: req.moduleId, index, phase: 'start' });
      try {
        await this.bridge(req, order, index, budget);
      } catch (err) {
        // A bridge is decoration: it must never stop a module from running.
        console.error('[hub] bridge failed', err);
      }
      this.opts.onBridge?.({ to: req.moduleId, index, phase: 'end' });
    }
    const result = await this.opts.inner.run(req);
    if (index >= 0) this.played.set(req.session.sessionId, index + 1);
    return result;
  }

  /** Walk from the previous booth to booth `index` within `budgetMs`. */
  private async bridge(
    req: ModuleRunRequest,
    order: readonly MicroGameId[],
    index: number,
    budgetMs: number,
  ): Promise<void> {
    const { services } = this.opts;
    const clock = req.clock;
    const deadline = clock.now() + budgetMs;
    if (this.opts.headless || !hasRenderer(services.app)) return;
    const root = services.createStage(req.moduleId);
    const host: StageHost = {
      ctx: { app: services.app, stage: root, layout: services.layout, art: services.art },
      moduleId: 'hub',
      sfx: (id: SfxId, o?: SfxOptions) => {
        try {
          services.audio.playSfx(id, o);
        } catch {
          // decorative
        }
      },
    };
    const stage = new GameStage(host, { sceneId: 'hub', timeOfDay: 'golden_hour' });
    const map = new FairMap(stage, order);
    const fade = new Graphics().rect(0, 0, stage.width, stage.height).fill(0x1b1838);
    stage.overlay.addChild(fade);
    try {
      services.audio.playMusic('hub', { fadeMs: 800 });
      services.audio.setAmbience('market_day', { fadeMs: 800 });
      const played = this.played.get(req.session.sessionId) ?? index;
      const from = map.standAt(index - 1);
      const to = map.standAt(index);
      map.setProgress(Math.min(played, index), index);
      const guide = map.guide;
      const rig = stage.rig(guide);
      guide.view.position.set(from.x, from.y);
      guide.view.zIndex = from.y + 1;
      guide.view.scale.set(map.scaleAt(from.y) * guide.view.scale.y);
      const baseScale = guide.view.scale.y / map.scaleAt(from.y);
      stage.cameraTo({ x: from.x, y: from.y - stage.height * 0.18, zoom: 1.22 }, 0);
      const s = budgetMs / 5000;
      await this.tween(fade, { alpha: 0, duration: 0.35 * s }, req.signal);
      if (services.voice.has('hub.bridge')) {
        const pb = services.voice.play('hub.bridge', { signal: req.signal });
        void guide.speak(pb).catch(() => undefined);
      }
      // Walk the lane (perspective scale follows depth), the camera following.
      const walkS = 3.0 * s;
      rig?.setFacing(to.x >= from.x ? 'right' : 'left');
      rig?.setLocomotion('walk');
      void stage.cameraTo(
        { x: to.x, y: to.y - stage.height * 0.18, zoom: 1.22 },
        walkS,
        'sine.inOut',
      );
      const st = { t: 0 };
      await this.tween(
        st,
        {
          t: 1,
          duration: walkS,
          ease: 'sine.inOut',
          onUpdate: () => {
            if (guide.view.destroyed) return;
            const x = from.x + (to.x - from.x) * st.t;
            const y = from.y + (to.y - from.y) * st.t;
            guide.view.position.set(x, y);
            guide.view.zIndex = y + 1;
            const k = map.scaleAt(y) * baseScale;
            guide.view.scale.set(k);
          },
        },
        req.signal,
      );
      void rig?.stopLocomotion();
      map.arrive(index);
      services.audio.playSfx('chime', { volume: 0.45 });
      guide.setExpression('happy');
      void rig?.play('beckon');
      const left = deadline - clock.now();
      await this.wait(clock, Math.max(0, left - 450 * s), req.signal);
      await this.tween(fade, { alpha: 1, duration: 0.35 * s }, req.signal);
    } finally {
      map.destroy();
      stage.destroy();
      try {
        services.releaseStage(root);
      } catch {
        // already released
      }
    }
  }

  private tween(target: object, vars: gsap.TweenVars, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const t = gsap.to(target, {
        ...vars,
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
      signal.addEventListener(
        'abort',
        () => {
          t.kill();
          resolve();
        },
        { once: true },
      );
    });
  }

  private wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
    return clock.delay(ms, signal).catch(() => undefined);
  }
}
