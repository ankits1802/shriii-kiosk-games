/**
 * FairStage: the cinematic frame every set-1 micro-game scene is built in.
 *
 * Layers (back to front): `world` (camera: backdrop, `set` for the booth, `actors`, `worldFx`),
 * `ambient` (fireflies, motes, god rays), `vignette`, `ui` (diegetic interactive items that must never
 * move with the camera), `probe` (the shared probe tray) and `cover` (fades).
 *
 * Measurement integrity: the camera is exactly at rest (identity transform) whenever trials run, so a
 * stimulus is always drawn where its touch target is; camera moves happen only in the intro, outro
 * and between blocks. Every choreography is budgeted against the module config (`budget.intro_ms`,
 * `budget.outro_ms`) and collapses to short cross-fades under reduced motion.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { MelaArtKit } from '../../../../art/ArtKit.ts';
import type { ProceduralCharacter } from '../../../../art/characters/ProceduralCharacter.ts';
import { lighten } from '../../../../art/color.ts';
import { rgba, rgrad, softShadow, vgrad } from '../../../../art/draw.ts';
import { killTweensDeep, motionSettings } from '../../../../art/motion.ts';
import { MELA } from '../../../../art/palettes.ts';
import type {
  AmbienceId,
  Backdrop,
  Character,
  Layout,
  ModuleContext,
  MusicCueId,
  Point,
  SceneId,
  TimeOfDay,
} from '../../../../core/contracts.ts';
import type { ProbeChoice, ProbeSituation } from '../probe.ts';
import type { GamePhase } from '../types.ts';
import { Fireflies, type FxDeps, GodRays, vignette, warmGlow } from './fx.ts';
import { ProbeLayer } from './ProbeLayer.ts';

export interface FairStageOptions {
  readonly scene: SceneId;
  readonly timeOfDay: TimeOfDay;
  readonly music: MusicCueId | null;
  readonly ambience: AmbienceId | null;
  /** Guide placement (feet) and scale relative to the art unit; null = no guide. */
  readonly guide: {
    readonly at: (layout: Layout) => Point;
    readonly scale: number;
    readonly facing: 'left' | 'right';
  } | null;
  /** Module emblem pictogram for the title medallion (drawn at `size` px). */
  readonly emblem: (size: number) => Container;
  /** Where the camera settles its attention during the intro (the booth). */
  readonly focus: (layout: Layout) => Point;
  /** Firefly count (0 = none). */
  readonly fireflies?: number;
  readonly godRays?: boolean;
  /** God-ray colour. */
  readonly rayColor?: number;
}

/** Duck-typed rig extras (present when the Mela art kit made the character). */
type Rig = Character &
  Partial<
    Pick<ProceduralCharacter, 'walkTo' | 'speakFor' | 'stopSpeaking' | 'pointAt' | 'setFacing'>
  >;

export class FairStage {
  readonly root = new Container();
  readonly world = new Container();
  readonly set = new Container();
  readonly actors = new Container();
  readonly worldFx = new Container();
  readonly ambient = new Container();
  readonly ui = new Container();
  readonly probeLayer: ProbeLayer;
  readonly backdrop: Backdrop;
  readonly guide: Rig | null;
  readonly fx: FxDeps;
  readonly unit: number;
  readonly reducedMotion: boolean;
  private readonly ctx: ModuleContext;
  private readonly opts: FairStageOptions;
  private readonly cover = new Graphics();
  private readonly vignetteLayer = new Container();
  private fireflies: Fireflies | null = null;
  private rays: GodRays | null = null;
  private emblem: Container | null = null;
  private destroyed = false;
  private readonly emitters = new Set<{ destroy(): void }>();

  constructor(ctx: ModuleContext, opts: FairStageOptions) {
    this.ctx = ctx;
    this.opts = opts;
    const L = ctx.layout;
    this.unit = Math.min(L.width, L.height) / 1080;
    const mela = ctx.art instanceof MelaArtKit ? ctx.art : null;
    this.reducedMotion = mela?.quality.reducedMotion ?? motionSettings.reducedMotion;
    this.fx = {
      cache: mela?.cache ?? null,
      ticker: ctx.app.ticker,
      reducedMotion: this.reducedMotion,
      particleScale: mela?.profile.particleScale ?? 0.6,
    };
    this.root.label = `fair-stage:${ctx.config.module_id}`;
    this.backdrop = ctx.art.createBackdrop(opts.scene, opts.timeOfDay);
    this.world.addChild(this.backdrop.view, this.set, this.actors, this.worldFx);
    this.actors.sortableChildren = true;
    this.root.addChild(this.world, this.ambient, this.vignetteLayer, this.ui);
    this.probeLayer = new ProbeLayer(ctx, this.fx, this.unit);
    this.root.addChild(this.probeLayer.view, this.cover);
    ctx.stage.addChild(this.root);

    const dbg = new URLSearchParams(globalThis.location?.search ?? '').get('dbg') ?? '';
    if (dbg.includes('nobd')) this.backdrop.view.visible = false;
    // Ambient life.
    if ((opts.fireflies ?? 0) > 0 && !dbg.includes('noff')) {
      this.fireflies = new Fireflies(
        this.fx,
        { x: 0, y: L.height * 0.12, w: L.width, h: L.height * 0.7 },
        opts.fireflies ?? 0,
        this.unit,
        `ff:${ctx.config.module_id}`,
      );
      this.ambient.addChild(this.fireflies.view);
    }
    if (opts.godRays && (mela?.profile.godrays ?? false)) {
      this.rays = new GodRays(
        this.fx,
        L.width,
        L.height,
        opts.rayColor ?? 0xffe2a0,
        `rays:${ctx.config.module_id}`,
      );
      this.ambient.addChild(this.rays.view);
    }
    if (!dbg.includes('novig')) this.vignetteLayer.addChild(vignette(L.width, L.height, 0.32));

    // Guide.
    if (opts.guide) {
      const g = ctx.art.createCharacter({
        id: `${ctx.config.module_id}.guide`,
        role: 'guide',
        facing: opts.guide.facing,
        scale: opts.guide.scale,
      }) as Rig;
      const at = opts.guide.at(L);
      g.view.position.set(at.x, at.y);
      g.view.zIndex = at.y;
      this.actors.addChild(g.view);
      this.guide = g;
    } else {
      this.guide = null;
    }

    // Start covered (the intro fades in).
    this.cover.rect(0, 0, L.width, L.height).fill(MELA.indigoDeep);
    this.cover.eventMode = 'none';
  }

  get layout(): Layout {
    return this.ctx.layout;
  }

  /**
   * Bake a static drawing into one cached texture (Mela art kit cache) so dense vector set art costs a
   * single sprite per frame; without a renderer-backed cache the live drawing is returned.
   */
  bake(key: string, build: () => Container): Container {
    const mela = this.ctx.art instanceof MelaArtKit ? this.ctx.art : null;
    if (!mela?.cache.canBake) return build();
    const L = this.ctx.layout;
    return mela.cache.bake(`${this.ctx.config.module_id}:${key}:${L.width}x${L.height}`, build, {
      padding: 4,
    });
  }

  /** Scaled seconds for a duration in ms (respects the global motion time scale). */
  private s(ms: number): number {
    return (ms / 1000) * Math.max(0.0001, motionSettings.timeScale);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Intro / outro                                                                                   */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * Opening cinematic: fade up from indigo while the camera tilts down from the garlands and dollies
   * in to rest on the booth; the module medallion drops in with a bounce and a gleam; the guide walks
   * in and greets. `setEntrance` (the module's booth reveal) runs alongside. Finishes inside
   * `budget.intro_ms` (capped at 3.6 s of picture; narration may continue over the resting frame).
   */
  async intro(setEntrance?: () => Promise<void>): Promise<void> {
    if (this.destroyed) return;
    const L = this.ctx.layout;
    const budgetMs = Math.min(3600, Math.max(1200, this.ctx.config.budget.intro_ms - 600));
    this.ctx.audio.setAmbience(this.opts.ambience, { fadeMs: 1500 });
    if (this.opts.music) this.ctx.audio.playMusic(this.opts.music, { fadeMs: 1800 });
    this.ctx.audio.playSfx('whoosh', { volume: 0.5 });
    if (this.reducedMotion) {
      await Promise.all([
        tweenP(this.cover, { alpha: 0, duration: this.s(400) }),
        setEntrance?.() ?? Promise.resolve(),
      ]);
      this.guide?.play('wave');
      return;
    }
    const focus = this.opts.focus(L);
    // Camera starts high and close, looking at the garlands, and settles to identity.
    this.world.pivot.set(focus.x, focus.y);
    this.world.position.set(focus.x, focus.y + L.height * 0.16);
    this.world.scale.set(1.16);
    void this.backdrop.setParallax?.(-0.5);
    const d = budgetMs * 0.72;
    const cam = gsap.timeline();
    cam.to(this.cover, { alpha: 0, duration: this.s(700), ease: 'sine.out' }, 0);
    cam.to(this.world.position, { y: focus.y, duration: this.s(d), ease: 'power2.inOut' }, 0);
    cam.to(this.world.scale, { x: 1, y: 1, duration: this.s(d), ease: 'power2.inOut' }, 0);
    const pan = (this.backdrop as { panTo?: (o: number, ms: number) => Promise<void> }).panTo;
    const panP = pan ? pan.call(this.backdrop, 0, d) : Promise.resolve();

    // Medallion.
    const medallion = this.buildMedallion(Math.min(L.width, L.height) * 0.16);
    medallion.position.set(L.width / 2, -L.height * 0.2);
    this.ui.addChild(medallion);
    this.emblem = medallion;
    const mt = gsap.timeline({ delay: this.s(budgetMs * 0.12) });
    mt.to(medallion, { y: L.height * 0.2, duration: this.s(520), ease: 'back.out(1.6)' });
    mt.to(
      medallion.scale,
      { x: 1.14, y: 0.88, duration: this.s(80), ease: 'power2.out' },
      '>-0.05',
    );
    mt.to(medallion.scale, { x: 1, y: 1, duration: this.s(380), ease: 'elastic.out(1, 0.4)' });
    mt.call(() => {
      warmGlow(
        this.ui,
        this.fx,
        { x: L.width / 2, y: L.height * 0.2 },
        Math.min(L.width, L.height) * 0.22,
      );
      this.ctx.audio.playSfx('chime', { volume: 0.55 });
    });
    mt.to(
      medallion,
      { y: -L.height * 0.2, alpha: 0, duration: this.s(520), ease: 'power2.in' },
      `+=${this.s(budgetMs * 0.28)}`,
    );

    // Guide walks in from the near edge and greets.
    const guideP = this.guideEntrance(budgetMs);
    // Bounded: the picture never holds the session longer than its intro budget.
    await Promise.race([
      Promise.all([
        awaitTimeline(cam),
        panP,
        awaitTimeline(mt),
        guideP,
        setEntrance?.() ?? Promise.resolve(),
      ]),
      waitMs(this.ctx, budgetMs + 400),
    ]);
    cam.kill();
    mt.kill();
    this.cover.alpha = 0;
    this.restCamera();
    gsap.killTweensOf(medallion);
    gsap.killTweensOf(medallion.scale);
    medallion.destroy({ children: true });
    this.emblem = null;
  }

  private async guideEntrance(budgetMs: number): Promise<void> {
    const g = this.guide;
    const spec = this.opts.guide;
    if (!g || !spec) return;
    const L = this.ctx.layout;
    const at = spec.at(L);
    const fromLeft = at.x < L.width / 2;
    const rig = g as Rig & Partial<Pick<ProceduralCharacter, 'setLocomotion' | 'stopLocomotion'>>;
    // Walk in place while the view glides in (a fixed, budgeted entrance; never slower than the intro).
    const dist = Math.min(L.width * 0.16, 260 * this.unit);
    g.view.x = fromLeft ? at.x - dist : at.x + dist;
    rig.setFacing?.(fromLeft ? 'right' : 'left');
    rig.setLocomotion?.('walk');
    await tweenP(g.view, {
      x: at.x,
      duration: this.s(Math.min(1700, budgetMs * 0.5)),
      ease: 'sine.out',
    });
    await rig.stopLocomotion?.();
    rig.setFacing?.(spec.facing);
    void g.play('wave');
  }

  /** Closing beat: guide celebrates, petals, warm glow, camera eases back, fade to indigo. */
  async outro(): Promise<void> {
    if (this.destroyed) return;
    const L = this.ctx.layout;
    const budget = Math.max(900, this.ctx.config.budget.outro_ms);
    void this.guide?.play('celebrate');
    this.ctx.audio.playSfx('bell', { volume: 0.5 });
    this.burst('petals', { x: L.width / 2, y: L.height * 0.05 }, this.reducedMotion ? 10 : 40);
    this.fireflies?.setIntensity(1.3, 0.8);
    if (!this.reducedMotion) {
      const focus = this.opts.focus(L);
      this.world.pivot.set(focus.x, focus.y);
      this.world.position.set(focus.x, focus.y);
      gsap.to(this.world.scale, { x: 0.94, y: 0.94, duration: this.s(budget), ease: 'sine.inOut' });
      gsap.to(this.world.position, {
        y: focus.y + L.height * 0.02,
        duration: this.s(budget),
        ease: 'sine.inOut',
      });
    }
    await waitMs(this.ctx, budget * 0.55);
    this.ctx.audio.stopMusic(900);
    await tweenP(this.cover, { alpha: 1, duration: this.s(budget * 0.4), ease: 'sine.in' });
  }

  /** One-shot particle burst in the world FX layer (emitters are owned and destroyed by the stage). */
  burst(
    kind: 'confetti' | 'sparkle' | 'dust' | 'petals' | 'smoke' | 'coins' | 'leaves',
    at: Point,
    count: number,
    parent?: Container,
  ): void {
    if (this.destroyed) return;
    const fx = this.ctx.art.createParticles({ kind, origin: at, count });
    (parent ?? this.worldFx).addChild(fx.view);
    fx.burst(count);
    this.emitters.add(fx);
    void waitMs(this.ctx, 4000).then(() => {
      if (!this.emitters.delete(fx)) return;
      fx.destroy();
    });
  }

  /** Camera exactly at rest (identity) for trials. */
  restCamera(): void {
    gsap.killTweensOf(this.world.position);
    gsap.killTweensOf(this.world.scale);
    this.world.pivot.set(0, 0);
    this.world.position.set(0, 0);
    this.world.scale.set(1);
    this.world.rotation = 0;
  }

  /** Mood change between blocks (time of day + tension); never during a trial's stimulus. */
  async mood(options: {
    readonly time?: number;
    readonly tension?: number;
    readonly music?: MusicCueId | null;
    readonly ambience?: AmbienceId | null;
    readonly fireflies?: number;
    readonly durationMs?: number;
  }): Promise<void> {
    const dur = options.durationMs ?? 1600;
    const audio = this.ctx.audio as { setTension?: (l: number) => void };
    if (options.tension !== undefined) audio.setTension?.(options.tension);
    if (options.music !== undefined) {
      if (options.music === null) this.ctx.audio.stopMusic(dur);
      else this.ctx.audio.playMusic(options.music, { fadeMs: dur });
    }
    if (options.ambience !== undefined)
      this.ctx.audio.setAmbience(options.ambience, { fadeMs: dur });
    if (options.fireflies !== undefined)
      this.fireflies?.setIntensity(options.fireflies, dur / 1000);
    const bd = this.backdrop as { setTimeValue?: (t: number, ms: number) => Promise<void> };
    if (options.time !== undefined && bd.setTimeValue) {
      await bd.setTimeValue.call(this.backdrop, options.time, this.reducedMotion ? 0 : dur);
    }
  }

  phase(_phase: GamePhase): void {
    // Phase-specific looks are applied by module views through `mood` (kept explicit there).
  }

  guideSpeak(ms: number): void {
    const g = this.guide;
    if (!g) return;
    if (ms <= 0) g.stopSpeaking?.();
    else void g.speakFor?.(ms);
  }

  /** Point the guide at a stage point (instructions); released by `guideIdle`. */
  guidePoint(at: Point): void {
    void this.guide?.pointAt?.(at);
  }

  guideIdle(): void {
    void this.guide?.play('idle');
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Probes (delegated)                                                                              */
  /* ---------------------------------------------------------------------------------------------- */

  enterProbes(): Promise<void> {
    this.restCamera();
    return this.probeLayer.enter(this.reducedMotion);
  }

  showProbe(s: ProbeSituation): void {
    this.probeLayer.show(s);
  }

  probeChosen(choice: ProbeChoice | null): Promise<void> {
    return this.probeLayer.chosen(choice, this.reducedMotion);
  }

  exitProbes(): Promise<void> {
    return this.probeLayer.exit(this.reducedMotion);
  }

  /* ---------------------------------------------------------------------------------------------- */

  private buildMedallion(size: number): Container {
    const c = new Container();
    const r = size / 2;
    const g = new Graphics();
    softShadow(g, 0, r * 0.95, r * 0.9, r * 0.22, 0x1a0d08, 0.35);
    // Brass rim with scalloped marigold petals.
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      g.circle(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02, r * 0.18).fill(
        i % 2 ? MELA.marigold : MELA.saffron,
      );
    }
    g.circle(0, 0, r).fill(
      rgrad(
        [
          [0, MELA.brassLight],
          [0.7, MELA.brass],
          [1, 0x9a6a1c],
        ],
        { x: 0.38, y: 0.32 },
        0.75,
      ),
    );
    g.circle(0, 0, r * 0.82).fill(
      vgrad([
        [0, lighten(MELA.cream, 0.1)],
        [1, MELA.parchment],
      ]),
    );
    g.circle(0, 0, r * 0.82).stroke({ width: Math.max(2, r * 0.05), color: 0x9a6a1c, alpha: 0.8 });
    g.circle(-r * 0.3, -r * 0.42, r * 0.18).fill({ color: 0xffffff, alpha: 0.25 });
    c.addChild(g);
    const pic = this.opts.emblem(size * 0.62);
    c.addChild(pic);
    const shine = new Graphics().circle(0, 0, r * 0.82).fill(
      rgrad([
        [0, rgba(0xffffff, 0.0)],
        [0.85, rgba(0xffffff, 0.0)],
        [1, rgba(0xffffff, 0.35)],
      ]),
    );
    c.addChild(shine);
    return c;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of [this.cover, this.world.position, this.world.scale, this.emblem]) {
      if (t) gsap.killTweensOf(t);
    }
    for (const e of this.emitters) e.destroy();
    this.emitters.clear();
    killTweensDeep(this.root);
    this.fireflies?.destroy();
    this.rays?.destroy();
    this.probeLayer.destroy();
    this.guide?.destroy();
    this.backdrop.destroy();
    this.root.destroy({ children: true });
  }
}

/* ------------------------------------------------------------------------------------------------ */

/** gsap.to as a promise (resolves on complete or interrupt). */
export function tweenP(target: object, vars: gsap.TweenVars): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(target, { ...vars, onComplete: () => resolve(), onInterrupt: () => resolve() });
  });
}

export function awaitTimeline(tl: gsap.core.Timeline): Promise<void> {
  return new Promise((resolve) => {
    if (tl.progress() >= 1) {
      resolve();
      return;
    }
    tl.eventCallback('onComplete', () => resolve());
    tl.eventCallback('onInterrupt', () => resolve());
  });
}

/** Wait on the session clock; resolves early (never rejects) when the module is aborted. */
export function waitMs(ctx: ModuleContext, ms: number): Promise<void> {
  return ctx.clock.delay(Math.max(0, ms), ctx.signal).catch(() => undefined);
}
