/**
 * Road Home presenter (Pixi): owns the two scenes (the side-view journey and the top-down village
 * map), the light of the story clock (sunset -> dusk -> night -> moonrise), the diegetic HUD, every
 * touch target, and the choreography of each beat.
 *
 * Measurement rules honoured here:
 * - `prepare` stages everything off-screen or veiled; `reveal` is synchronous and only flips
 *   visibility/registers targets, so the onset frame the director timestamps is the frame the
 *   stimulus appears (no fade-in on a stimulus, no animation in front of it);
 * - feedback runs only after the director closed the window (`conceal` first);
 * - durations come from `VIEW_BEATS` (halved under soft-cap wrap-up), identical in every language;
 * - nothing on screen is a number or a score; colour is never the only cue.
 */
import { gsap } from 'gsap';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { lighten, mixColor } from '../../../art/color.ts';
import type { IconButton } from '../../../art/ui/buttons.ts';
import { HandHint } from '../../../art/ui/buttons.ts';
import type {
  ModuleContext,
  Point,
  Rect,
  TargetHandle,
  Unsubscribe,
} from '../../../core/contracts.ts';
import type { PlayedRound } from '../../../paradigms/public-goods.ts';
import type { Branch } from '../../../paradigms/reversal.ts';
import { ROAD_HOME_LINES } from '../lines.ts';
import type { BlockedTrial, RoadHomePlan, RoadHomeTrial } from '../plan.ts';
import type { RoadHomePresenter, StepEvent } from '../types.ts';
import { EpisodeArt } from './art.ts';
import { VIEW_BEATS } from './beats.ts';
import { JourneyCart } from './cart.ts';
import { FairPiece } from './fair.ts';
import { ForkPiece } from './fork.ts';
import { createConfirmButton, createReplayButton, ErrandChit, FodderTray, RestCot } from './hud.ts';
import { JourneyLandscape } from './landscape.ts';
import { MapScene } from './MapScene.ts';
import { type RoadPalette, roadPaletteAt } from './palette.ts';
import { RoadsidePiece } from './roadside.ts';
import { SkyLayer } from './sky.ts';
import { CrossingPiece, FodderStop, HillPiece, HomePiece } from './stops.ts';

type Piece =
  | ForkPiece
  | RoadsidePiece
  | FodderStop
  | HillPiece
  | CrossingPiece
  | HomePiece
  | FairPiece;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const id = setTimeout(done, ms);
    function done(): void {
      clearTimeout(id);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Tween a plain object and await it (resolves on completion or kill). */
function tween(target: object, vars: gsap.TweenVars): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(target, { ...vars, onComplete: () => resolve(), onInterrupt: () => resolve() });
  });
}

let vignetteCache: Texture | null = null;

/** A radial darkening ramp (transparent centre, deep-night edges), drawn once and shared. */
function vignetteTexture(): Texture {
  if (vignetteCache) return vignetteCache;
  if (typeof document === 'undefined') return Texture.EMPTY;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return Texture.EMPTY;
  const r = g.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.28,
    size / 2,
    size / 2,
    size * 0.72,
  );
  r.addColorStop(0, 'rgba(11,10,30,0)');
  r.addColorStop(0.55, 'rgba(11,10,30,0.12)');
  r.addColorStop(1, 'rgba(11,10,30,0.55)');
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  vignetteCache = Texture.from(c);
  return vignetteCache;
}

export class RoadHomeView implements RoadHomePresenter {
  readonly art: EpisodeArt;
  private readonly root = new Container();
  private readonly journey = new Container();
  private readonly hudLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly veil = new Graphics();
  private readonly vignette = new Sprite(vignetteTexture());
  private readonly sky: SkyLayer;
  private readonly land: JourneyLandscape;
  private readonly cart: JourneyCart;
  private readonly map: MapScene;
  private chit: ErrandChit | null = null;
  private tray: FodderTray | null = null;
  private cot: RestCot | null = null;
  private replay: IconButton | null = null;
  private replayTarget: TargetHandle | null = null;
  private confirm: IconButton | null = null;
  private hand: HandHint | null = null;
  private mode: 'journey' | 'map' = 'journey';
  private piece: Piece | null = null;
  private pieceWorldX = 0;
  private oldPieces: { piece: Piece; x: number }[] = [];
  private readonly targets = new Map<string, TargetHandle>();
  private readonly targetRects = new Map<string, Rect>();
  private story = { t: 0 };
  private appliedT = -1;
  private hurry = false;
  private lastKind: RoadHomeTrial['kind'] | null = null;
  private practicePhase: 'map' | 'fork' = 'map';
  private cartOffset = { x: 0, y: 0, s: 1, r: 0 };
  private plan: RoadHomePlan | null = null;
  private unsubs: Unsubscribe[] = [];
  private destroyed = false;
  private readonly onTick = (): void => this.update();

  constructor(private readonly ctx: ModuleContext) {
    this.art = new EpisodeArt(ctx);
    this.root.label = 'road-home';
    this.root.eventMode = 'none';
    this.sky = new SkyLayer(this.art);
    this.land = new JourneyLandscape(this.art);
    this.cart = new JourneyCart(this.art);
    this.map = new MapScene(this.art);
    this.journey.addChild(this.sky.view, this.land.view, this.cart.view, this.land.front);
    this.map.view.visible = false;
    this.root.addChild(
      this.journey,
      this.map.view,
      this.fxLayer,
      this.vignette,
      this.hudLayer,
      this.veil,
    );
    ctx.stage.addChild(this.root);
    this.layout();
    this.unsubs.push(
      ctx.layout.onChange((l) => {
        this.art.resize(l.width, l.height);
        this.layout();
      }),
    );
    this.art.ticker.add(this.onTick);
  }

  /* --------------------------------------------------------------------------------- layout */

  private layout(): void {
    const { w, h } = this.art;
    this.sky.resize(w, h, this.land.metrics.horizonY / h || 0.57);
    this.land.build(w, h);
    this.sky.resize(w, h, this.land.metrics.horizonY / h);
    this.placeCart();
    // Soft elliptical vignette: one stretched radial-gradient quad (smooth, no banding, cheap).
    this.vignette.position.set(0, 0);
    this.vignette.width = w;
    this.vignette.height = h;
    this.veil.clear().rect(0, 0, w, h).fill(0x0b0a1e);
    this.veil.alpha = 0;
    this.layoutReplay();
    this.appliedT = -1;
  }

  private placeCart(): void {
    const m = this.land.metrics;
    const o = this.cartOffset;
    this.cart.view.position.set(m.cartX + o.x, m.roadY + o.y);
    this.cart.view.scale.set(o.s);
    this.cart.view.rotation = o.r;
  }

  private layoutReplay(): void {
    const mm = this.art.mm(22);
    // Top-left: the kiosk's persistent hand (exit) control owns the top-right corner (ONB-06).
    const x = mm / 2 + this.art.mm(6);
    const y = mm / 2 + this.art.mm(5);
    if (!this.replay) {
      this.replay = createReplayButton(this.art);
      this.hudLayer.addChild(this.replay.view);
      const id = 'road_home.replay';
      this.replayTarget = this.ctx.input.registerTarget({
        id,
        bounds: { x: x - mm / 2, y: y - mm / 2, width: mm, height: mm },
        audioKey: ROAD_HOME_LINES.replay,
        kind: 'tap',
      });
      this.unsubs.push(
        this.ctx.input.onRawTap((tap) => {
          if (tap.targetId !== id || this.destroyed) return;
          this.replay?.press();
          const voice = this.ctx.voice;
          const lines = [ROAD_HOME_LINES.replay, ROAD_HOME_LINES.intro].filter((l) => voice.has(l));
          if (lines.length > 0)
            voice.playSequence(lines, { replay: true, signal: this.ctx.signal });
        }),
      );
    }
    this.replay.view.position.set(x, y);
    this.replayTarget?.setBounds({ x: x - mm / 2, y: y - mm / 2, width: mm, height: mm });
  }

  /* ---------------------------------------------------------------------------------- light */

  private palette(): RoadPalette {
    return roadPaletteAt(this.story.t);
  }

  private update(): void {
    if (this.destroyed) return;
    const dt = Math.min(0.05, this.art.ticker.deltaMS / 1000);
    if (Math.abs(this.story.t - this.appliedT) > 0.0005) {
      this.appliedT = this.story.t;
      const p = this.palette();
      this.sky.apply(p);
      this.land.apply(p);
      this.map.apply(p);
      this.art.lighting.set(p);
      this.vignette.alpha = 0.6 + p.vignette;
      this.lightPieces(p);
    }
    this.veil.visible = this.veil.alpha > 0.001;
    this.sky.update(dt);
    this.land.update(dt);
    this.map.update(dt);
    // Old pieces scroll out with the world; drop them once off-screen.
    for (let i = this.oldPieces.length - 1; i >= 0; i -= 1) {
      const o = this.oldPieces[i];
      if (!o) continue;
      if (o.x - this.land.camera < -this.art.w * 1.6) {
        o.piece.destroy();
        this.oldPieces.splice(i, 1);
      }
    }
  }

  /** Set pieces take the scene light (glows and characters keep their own). */
  private lightPieces(p: RoadPalette): void {
    const tint = mixColor(lighten(p.lightTint, 0.12), 0xffffff, 0.08);
    const all = [...this.oldPieces.map((o) => o.piece), ...(this.piece ? [this.piece] : [])];
    for (const piece of all) {
      if (piece instanceof ForkPiece) piece.applyLight(tint);
      else piece.body.tint = tint;
    }
  }

  private toSky(t: number, ms: number): Promise<void> {
    return tween(this.story, { t, duration: ms / 1000, ease: 'sine.inOut' });
  }

  private beat(ms: number): number {
    return this.hurry ? ms * 0.5 : ms;
  }

  /* ------------------------------------------------------------------------------ lifecycle */

  async init(plan: RoadHomePlan): Promise<void> {
    this.plan = plan;
    this.story.t = 0;
    this.appliedT = -1;
    this.update();
  }

  async intro(signal: AbortSignal): Promise<void> {
    const total = this.beat(VIEW_BEATS.intro);
    const { w } = this.art;
    // The fair at sunset, the cart ready to leave.
    const fair = new FairPiece(this.art, this.land.metrics);
    this.setPiece(fair, this.land.metrics.cartX - w * 0.15);
    this.veil.alpha = 1;
    this.cart.partner.setView('three_quarter', true);
    this.cart.partner.setFacing('left');
    void tween(this.veil, { alpha: 0, duration: 0.9 });
    this.ctx.audio.playSfx('bell', { volume: 0.5 });
    await sleep(total * 0.12, signal);
    void this.cart.partner.play('wave');
    this.cart.partner.setExpression('happy');
    await sleep(total * 0.18, signal);
    this.cart.partner.setFacing('right');
    this.cart.partner.setView('side');
    // Roll out of the fair: camera glides, parallax opens the road.
    const dist = w * 1.05;
    const roll = total * 0.55;
    this.cart.roll(dist / (roll / 1000));
    this.ctx.audio.playSfx('cart_roll', { volume: 0.45 });
    await this.moveCamera(this.land.camera + dist, roll, 'sine.inOut');
    this.cart.roll(0);
    await sleep(total * 0.08, signal);
  }

  private moveCamera(to: number, ms: number, ease = 'power1.inOut'): Promise<void> {
    if (!this.art.profile.cameraMoves) {
      // Reduced motion: no pans; the new view settles in with a gentle crossfade.
      this.land.setCamera(to);
      this.journey.alpha = 0.55;
      return tween(this.journey, { alpha: 1, duration: ms / 1000, ease: 'sine.out' });
    }
    const cam = { x: this.land.camera };
    return tween(cam, {
      x: to,
      duration: ms / 1000,
      ease,
      onUpdate: () => this.land.setCamera(cam.x),
    });
  }

  private setPiece(piece: Piece, screenX: number): void {
    if (this.piece) this.oldPieces.push({ piece: this.piece, x: this.pieceWorldX });
    this.piece = piece;
    this.pieceWorldX = this.land.camera + screenX;
    piece.view.x = this.pieceWorldX;
    this.land.world.addChild(piece.view);
    this.lightPieces(this.palette());
  }

  private pieceScreenX(): number {
    return this.pieceWorldX - this.land.camera;
  }

  /** Bring a new piece in from the right and park it at `screenX`, rolling the cart. */
  private async rollTo(piece: Piece, screenX: number, ms: number): Promise<void> {
    const d = this.art.w * 1.3;
    this.setPiece(piece, screenX + d);
    this.cart.roll(d / Math.max(0.1, ms / 1000));
    if (ms > 200) this.ctx.audio.playSfx('cart_roll', { volume: 0.35 });
    await this.moveCamera(this.land.camera + d, ms, 'power1.inOut');
    this.cart.roll(0);
    // Earlier pieces are off-screen now: release them.
    for (const o of this.oldPieces.splice(0)) o.piece.destroy();
  }

  /** Return the cart to its resting road position (after a branch, a hill or a stop). */
  private resetCart(ms: number): Promise<void> {
    return tween(this.cartOffset, {
      x: 0,
      y: 0,
      s: 1,
      r: 0,
      duration: ms / 1000,
      ease: 'sine.inOut',
      onUpdate: () => this.placeCart(),
    });
  }

  /* -------------------------------------------------------------------------------- prepare */

  async prepare(trial: RoadHomeTrial, signal: AbortSignal): Promise<void> {
    const isMap =
      trial.kind === 'errand_map' || trial.kind === 'blocked_route' || trial.kind === 'practice';
    const same = trial.kind === this.lastKind && !isMap;
    this.lastKind = trial.kind;
    if (isMap) {
      const ms = this.beat(VIEW_BEATS.prepareMap);
      void this.toSky(trial.sky, ms);
      await this.enterMap(trial, ms, signal);
      return;
    }
    const ms = this.beat(same ? VIEW_BEATS.prepareNext : VIEW_BEATS.prepareJourney);
    void this.toSky(trial.sky, ms);
    if (this.mode === 'map') await this.leaveMap(ms * 0.5);
    const m = this.land.metrics;
    const { w } = this.art;
    const rest = same ? ms : ms * (this.mode === 'journey' ? 1 : 0.5);
    if (this.piece instanceof FodderStop && trial.kind !== 'fuel_round') this.cart.reclaimPartner();
    switch (trial.kind) {
      case 'fork_choice': {
        const piece = new ForkPiece(this.art, m, trial.fork.blueSide, trial.ordinal + 7);
        await Promise.all([
          this.resetCart(rest * 0.9),
          this.rollTo(piece, m.cartX + this.cart.frontX + 24 * this.art.unit, rest),
        ]);
        break;
      }
      case 'optional_opportunity': {
        const piece = new RoadsidePiece(this.art, m, trial.opportunity);
        const x = m.cartX + this.cart.frontX + w * (this.art.portrait ? 0.08 : 0.12);
        await Promise.all([this.resetCart(rest * 0.9), this.rollTo(piece, x, rest)]);
        break;
      }
      case 'fuel_round': {
        if (same && this.piece instanceof FodderStop) {
          this.piece.resetPiles();
          await sleep(rest, signal);
        } else {
          const stop = new FodderStop(this.art, m, trial.endowment);
          const x = w * (this.art.portrait ? 0.56 : 0.62);
          await Promise.all([this.resetCart(rest * 0.9), this.rollTo(stop, x, rest)]);
          this.cart.lendPartner(stop.view, stop.at.partner.x, stop.at.partner.y);
          this.cart.partner.setView('three_quarter', true);
          this.cart.partner.setFacing('left');
        }
        break;
      }
      case 'effort_hold': {
        const hill = new HillPiece(this.art, m, 1900 + trial.ordinal);
        const x = m.cartX + this.cart.frontX * 0.55;
        await Promise.all([this.resetCart(rest * 0.9), this.rollTo(hill, x, rest)]);
        break;
      }
      case 'probe': {
        const piece = new CrossingPiece(this.art, m, trial.safeSide);
        await Promise.all([
          this.resetCart(rest * 0.9),
          this.rollTo(piece, m.cartX + this.cart.frontX + 24 * this.art.unit, rest),
        ]);
        break;
      }
    }
  }

  private async enterMap(trial: RoadHomeTrial, ms: number, signal: AbortSignal): Promise<void> {
    if (trial.kind !== 'errand_map' && trial.kind !== 'blocked_route' && trial.kind !== 'practice')
      return;
    // Lift the camera: the road falls away and the village map settles in from above.
    const map = trial.map;
    this.map.build(map, trial.spec.trial_id);
    this.practicePhase = 'map';
    this.map.view.visible = true;
    this.map.view.alpha = 0;
    this.map.view.scale.set(1.12);
    this.map.view.pivot.set(this.art.w / 2, this.art.h / 2);
    this.map.view.position.set(this.art.w / 2, this.art.h / 2);
    this.setupHud(trial);
    if (trial.kind === 'blocked_route') this.map.showUsualWay(trial.solution.optimalPath);
    const sec = ms / 1000;
    void tween(this.journey.scale, { x: 1.18, y: 1.18, duration: sec, ease: 'power2.in' });
    void tween(this.journey, { alpha: 0, duration: sec * 0.8 });
    this.journey.pivot.set(this.land.metrics.cartX, this.land.metrics.roadY);
    this.journey.position.set(this.land.metrics.cartX, this.land.metrics.roadY);
    void tween(this.hudLayer, { alpha: 1, duration: sec });
    await Promise.all([
      tween(this.map.view, { alpha: 1, duration: sec, ease: 'power2.out' }),
      tween(this.map.view.scale, { x: 1, y: 1, duration: sec, ease: 'power3.out' }),
    ]);
    this.journey.visible = false;
    this.mode = 'map';
    void signal;
  }

  private async leaveMap(ms: number): Promise<void> {
    const sec = ms / 1000;
    const token = this.map.pos(this.plan?.trials[0]?.spec.trial_id ?? '');
    void token;
    this.journey.visible = true;
    this.journey.alpha = 0;
    this.journey.scale.set(1.15);
    this.teardownHud();
    await Promise.all([
      tween(this.map.view, { alpha: 0, duration: sec }),
      tween(this.map.view.scale, { x: 1.2, y: 1.2, duration: sec, ease: 'power2.in' }),
      tween(this.journey, { alpha: 1, duration: sec }),
      tween(this.journey.scale, { x: 1, y: 1, duration: sec, ease: 'power2.out' }),
    ]);
    this.map.view.visible = false;
    this.mode = 'journey';
  }

  private setupHud(trial: RoadHomeTrial): void {
    this.teardownHud();
    if (trial.kind !== 'errand_map' && trial.kind !== 'blocked_route' && trial.kind !== 'practice')
      return;
    const { w, h } = this.art;
    const errands = trial.map.errands.length;
    if (errands > 0) {
      this.chit = new ErrandChit(this.art, errands);
      const b = this.chit.view.getLocalBounds();
      this.chit.view.position.set(
        this.art.portrait ? (w - b.width) / 2 - w * 0.16 : w * 0.03,
        h * 0.012,
      );
      this.hudLayer.addChild(this.chit.view);
    }
    if (trial.kind !== 'practice') {
      this.tray = new FodderTray(this.art, trial.map.fuelBudget);
      const b = this.tray.view.getLocalBounds();
      const x = this.art.portrait ? w * 0.04 : (w - b.width) / 2;
      const y = this.art.portrait ? h - b.height - h * 0.01 : h * 0.03;
      this.tray.view.position.set(x, y);
      this.hudLayer.addChild(this.tray.view);
    }
  }

  private teardownHud(): void {
    this.chit?.destroy();
    this.chit = null;
    this.tray?.destroy();
    this.tray = null;
    this.cot?.destroy();
    this.cot = null;
  }

  /* --------------------------------------------------------------------------------- targets */

  private addTarget(key: string, raw: Rect, kind: 'tap' | 'hold' = 'tap'): string {
    const id = `road_home.${key}`;
    // Never below 22 mm on either axis, kept on screen (KSK-05), whatever the panel size.
    const min = this.art.mm(22);
    const width = Math.max(raw.width, min);
    const height = Math.max(raw.height, min);
    const rect: Rect = {
      x: Math.min(Math.max(0, raw.x - (width - raw.width) / 2), this.art.w - width),
      y: Math.min(Math.max(0, raw.y), this.art.h - height),
      width,
      height,
    };
    this.targets.get(key)?.remove();
    this.targets.set(
      key,
      this.ctx.input.registerTarget({ id, bounds: rect, audioKey: ROAD_HOME_LINES.replay, kind }),
    );
    this.targetRects.set(key, rect);
    return id;
  }

  private clearTargets(): void {
    for (const t of this.targets.values()) t.remove();
    this.targets.clear();
    this.targetRects.clear();
  }

  private mapIds = new Map<string, string>();

  offer(_trial: RoadHomeTrial, nodes: readonly string[], rest: boolean): void {
    this.mapIds = this.mapTargets(nodes, rest);
  }

  /** Target id -> key for the waypoints currently on offer. */
  currentMapIds(): ReadonlyMap<string, string> {
    return this.mapIds;
  }

  /** Register targets for the reachable waypoints (+ rest). */
  private mapTargets(nodes: readonly string[], rest: boolean): Map<string, string> {
    for (const [k, t] of [...this.targets]) {
      if (k.startsWith('node:')) {
        t.remove();
        this.targets.delete(k);
        this.targetRects.delete(k);
      }
    }
    const ids = new Map<string, string>();
    for (const n of nodes)
      ids.set(this.addTarget(`node:${n}`, this.map.targetRect(n)), `node:${n}`);
    this.map.setReachable(nodes);
    if (rest && this.cot) {
      const id = 'road_home.rest';
      if (!this.targets.has('rest')) this.addTarget('rest', this.cot.rect());
      ids.set(id, 'rest');
    }
    return ids;
  }

  /** Ids of the current trial's targets by key. */
  targetId(key: string): string {
    return `road_home.${key}`;
  }

  /** Centre of a target (hand hints, bot ripples). */
  private centreOf(key: string): Point | null {
    const r = this.targetRects.get(key);
    if (r) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    if (key.startsWith('node:')) return this.map.pos(key.slice(5));
    return null;
  }

  /* ---------------------------------------------------------------------------------- reveal */

  reveal(trial: RoadHomeTrial): void {
    const m = this.land.metrics;
    switch (trial.kind) {
      case 'practice':
        if (this.practicePhase === 'map') {
          this.mapTargets([trial.map.nodes[1] ?? trial.map.home], false);
        } else {
          this.revealFork();
        }
        break;
      case 'errand_map':
        this.mapTargets(
          trial.map.edges
            .filter((e) => e.a === trial.map.start || e.b === trial.map.start)
            .map((e) => (e.a === trial.map.start ? e.b : e.a)),
          false,
        );
        break;
      case 'blocked_route': {
        this.map.revealBlock(trial.event);
        if (trial.event.ferry) {
          this.cot = new RestCot(this.art);
          this.cot.view.position.set(
            this.art.portrait ? this.art.w * 0.2 : this.art.w * 0.1,
            this.art.h * (this.art.portrait ? 0.11 : 0.15),
          );
          this.hudLayer.addChild(this.cot.view);
        }
        this.mapIds = this.mapTargets(
          this.adjacent(trial.map, trial.map.start),
          trial.event.ferry !== null,
        );
        break;
      }
      case 'fork_choice':
        this.revealFork();
        break;
      case 'optional_opportunity': {
        const piece = this.piece;
        if (piece instanceof RoadsidePiece) {
          piece.reveal({ x: m.cartX, y: m.roadY - 120 * this.art.unit });
          this.addTarget('optional', piece.target(this.pieceScreenX()));
        }
        break;
      }
      case 'fuel_round': {
        const stop = this.piece;
        if (stop instanceof FodderStop) {
          const t = stop.targets(this.pieceScreenX());
          this.addTarget('fuel:pile', t.pile);
          this.addTarget('fuel:trough', t.trough);
          this.addTarget('fuel:confirm', t.confirm);
          this.confirm ??= createConfirmButton(this.art);
          this.confirm.view.position.set(
            t.confirm.x + t.confirm.width / 2,
            t.confirm.y + t.confirm.height / 2,
          );
          this.confirm.view.visible = true;
          this.hudLayer.addChild(this.confirm.view);
        }
        break;
      }
      case 'effort_hold': {
        const hill = this.piece;
        if (hill instanceof HillPiece) {
          const c = this.cart.view;
          const w = Math.max(this.art.mm(40), this.cart.width * 0.8);
          const hgt = Math.max(this.art.mm(30), 230 * this.art.unit);
          const rect = { x: c.x - w * 0.35, y: c.y - hgt, width: w, height: hgt };
          this.addTarget('effort', rect, 'hold');
          hill.showPushGlow(this.land.camera + c.x + w * 0.15, c.y - hgt * 0.5);
        }
        break;
      }
      case 'probe': {
        const piece = this.piece;
        if (piece instanceof CrossingPiece) {
          piece.reveal();
          const t = piece.targets(this.pieceScreenX());
          this.addTarget('branch:left', t.left);
          this.addTarget('branch:right', t.right);
        }
        break;
      }
    }
  }

  private adjacent(
    map: { readonly edges: readonly { a: string; b: string }[] },
    node: string,
  ): string[] {
    return map.edges
      .filter((e) => e.a === node || e.b === node)
      .map((e) => (e.a === node ? e.b : e.a));
  }

  private revealFork(): void {
    const piece = this.piece;
    if (!(piece instanceof ForkPiece)) return;
    piece.reveal();
    const t = piece.targets(this.pieceScreenX());
    this.addTarget('branch:left', t.left);
    this.addTarget('branch:right', t.right);
  }

  conceal(trial: RoadHomeTrial): void {
    this.clearTargets();
    this.map.clearReachable();
    if (this.confirm) this.confirm.view.visible = false;
    if (this.piece instanceof HillPiece) this.piece.hidePushGlow();
    this.hint(null);
    void trial;
  }

  hint(key: string | null): void {
    if (key === null) {
      this.hand?.stop();
      return;
    }
    const at = this.centreOf(key);
    if (!at) return;
    this.hand ??= new HandHint(this.art.mm(24), this.art.reducedMotion);
    this.fxLayer.addChild(this.hand.view);
    this.hand.show('tap', at);
  }

  /* -------------------------------------------------------------------------------- feedback */

  touched(key: string): void {
    const at = this.centreOf(key);
    if (at) this.ripple(at);
    this.ctx.audio.playSfx('tap_soft', { volume: 0.5 });
  }

  /** Touch ripple at a stage point (both scenes). */
  private ripple(p: Point): void {
    const u = this.art.unit;
    const g = new Graphics();
    g.circle(0, 0, 30 * u).stroke({ width: 4 * u, color: 0xffffff, alpha: 0.9 });
    g.position.set(p.x, p.y);
    this.fxLayer.addChild(g);
    gsap.to(g.scale, { x: 2, y: 2, duration: 0.45, ease: 'power2.out' });
    gsap.to(g, { alpha: 0, duration: 0.45, onComplete: () => g.destroy() });
  }

  async step(trial: RoadHomeTrial, step: StepEvent): Promise<void> {
    const p = step.payload;
    const ferry =
      trial.kind === 'blocked_route' &&
      !!trial.event.ferry &&
      ((p.from_node === trial.event.ferry.ghat && p.to_node === trial.event.ferry.landing) ||
        (p.from_node === trial.event.ferry.landing && p.to_node === trial.event.ferry.ghat));
    if (!step.moved) this.ctx.audio.playSfx('tap_soft', { volume: 0.6 });
    else this.ctx.audio.playSfx('cart_roll', { volume: 0.3 });
    const move = this.map.move(p.from_node, p.to_node, {
      blocked: !step.moved,
      ferry,
      durationMs: VIEW_BEATS.step,
    });
    if (trial.kind !== 'practice') {
      this.tray?.set(p.fuel_after_units, step.reserve);
    }
    if (p.errand_completed) {
      const idx = Number(p.errand_completed.replace('errand_', ''));
      const node = p.to_node;
      void move.then(() => {
        this.chit?.done(idx);
        this.map.errandDone(node);
        this.ctx.audio.playSfx('chime', { volume: 0.55 });
      });
    }
    return move;
  }

  nudge(): void {
    this.map.nudge();
  }

  async rest(trial: RoadHomeTrial, prompted: boolean): Promise<void> {
    const ms = this.beat(VIEW_BEATS.rest);
    if (prompted) this.cot?.invite();
    const t = trial as BlockedTrial;
    if (t.event?.ferry) this.map.callFerry(t.event.ferry.ghat, t.event.ferry.landing);
    this.ctx.audio.playSfx('bell', { volume: 0.45 });
    await sleep(ms);
  }

  async mapDone(trial: RoadHomeTrial): Promise<void> {
    await this.map.idle();
    if (trial.kind === 'practice' && this.practicePhase === 'map') {
      // The practice continues at the first fork, on the road.
      this.practicePhase = 'fork';
      this.clearTargets();
      this.map.clearReachable();
      await this.leaveMap(this.beat(VIEW_BEATS.prepareJourney) * 0.6);
      const m = this.land.metrics;
      const piece = new ForkPiece(this.art, m, trial.fork.blueSide, 3);
      await this.rollTo(
        piece,
        m.cartX + this.cart.frontX + 24 * this.art.unit,
        this.beat(VIEW_BEATS.prepareJourney),
      );
      this.revealFork();
      return;
    }
    if (trial.kind === 'errand_map' || trial.kind === 'blocked_route')
      this.map.arrive(trial.map.home);
    this.ctx.audio.playSfx('chime', { volume: 0.5 });
    await sleep(this.beat(VIEW_BEATS.mapDone));
  }

  async forkOutcome(trial: RoadHomeTrial, choice: Branch | null, correct: boolean): Promise<void> {
    const ms = this.beat(VIEW_BEATS.fork);
    const piece = this.piece;
    const partner = this.cart.partner;
    if (!(piece instanceof ForkPiece) || choice === null) {
      void partner.play('shrug');
      await sleep(ms);
      return;
    }
    const drive = piece.geom[choice].drive;
    if (!correct) piece.showDeadEnd(choice);
    this.cart.roll(500 * this.art.unit);
    const reach = correct ? 1 : 0.55;
    await tween(this.cartOffset, {
      x: drive.dx * reach,
      y: drive.dy * reach,
      s: 1 + (drive.scale - 1) * reach,
      duration: (ms * 0.85) / 1000,
      ease: correct ? 'sine.in' : 'power2.out',
      onUpdate: () => this.placeCart(),
    });
    this.cart.roll(0);
    if (correct) {
      const mouth = piece.mouth(choice);
      this.art.burst(piece.view, 'sparkle', mouth, 14, 1600);
      partner.react('pleased', 0.8);
      this.ctx.audio.playSfx('chime', { volume: 0.45 });
    } else {
      void this.cart.bump();
      partner.react('surprised', 0.6);
      void partner.play('shrug');
      this.ctx.audio.playSfx('tap_soft', { volume: 0.6 });
    }
    await sleep(ms * 0.15);
    if (trial.kind === 'practice' && !correct) {
      // Back to the junction and try again with the guide's hand.
      await this.resetCart(this.beat(500));
      piece.destroy();
      const fresh = new ForkPiece(this.art, this.land.metrics, trial.fork.blueSide, 4);
      this.piece = fresh;
      fresh.view.x = this.pieceWorldX;
      this.land.world.addChild(fresh.view);
      this.lightPieces(this.palette());
    }
  }

  async optionalOutcome(trial: RoadHomeTrial, taken: boolean): Promise<void> {
    const piece = this.piece;
    const ms = this.beat(taken ? VIEW_BEATS.optionalTaken : VIEW_BEATS.optionalMissed);
    if (!(piece instanceof RoadsidePiece)) {
      await sleep(ms);
      return;
    }
    if (taken) {
      this.cart.partner.react('delighted', 1.2);
      void this.cart.partner.play('namaste');
      this.ctx.audio.playSfx(
        trial.kind === 'optional_opportunity' && trial.opportunity === 'shrine_lamp'
          ? 'bell'
          : 'chime',
        { volume: 0.5 },
      );
    }
    await piece.resolve(taken, ms);
  }

  async fuelOutcome(_trial: RoadHomeTrial, played: PlayedRound): Promise<void> {
    const stop = this.piece;
    const ms = this.beat(VIEW_BEATS.fuel);
    if (!(stop instanceof FodderStop)) {
      await sleep(ms);
      return;
    }
    this.ctx.audio.playSfx('pot_place', { volume: 0.5 });
    await stop.reveal(
      played.partner.tokens,
      played.partner.isError,
      played.settlement.returnEach,
      this.cart.partner,
      ms,
    );
  }

  async effortOutcome(_trial: RoadHomeTrial, completed: boolean): Promise<void> {
    const ms = this.beat(VIEW_BEATS.effort);
    const hill = this.piece;
    if (!(hill instanceof HillPiece)) {
      await sleep(ms);
      return;
    }
    const top = hill.along(1, this.cart.frontX);
    if (!completed) {
      // The partner leans in and helps: the cart still makes it over (never a failure scene).
      void this.cart.partner.play('push_cart');
      this.cart.partner.setExpression('happy');
    }
    this.cart.roll(260 * this.art.unit);
    await tween(this.cartOffset, {
      x: top.dx,
      y: top.dy,
      r: top.rotation,
      duration: (ms * 0.6) / 1000,
      ease: 'power2.out',
      onUpdate: () => this.placeCart(),
    });
    this.cart.roll(0);
    this.cart.hop();
    if (completed) {
      this.cart.partner.react('delighted', 1);
      void this.cart.partner.play('celebrate');
      this.art.burst(
        this.fxLayer,
        'sparkle',
        { x: this.cart.view.x + 80 * this.art.unit, y: this.cart.view.y - 160 * this.art.unit },
        18,
        1600,
      );
      this.ctx.audio.playSfx('chime', { volume: 0.5 });
    }
    await sleep(ms * 0.4);
  }

  /** Live push progress while the player holds (0..1, null = released). */
  effortProgress(progress: number | null): void {
    const hill = this.piece;
    if (!(hill instanceof HillPiece)) return;
    const p = progress ?? 0;
    const at = hill.along(Math.min(1, p) * 0.92, this.cart.frontX);
    if (progress === null) {
      this.cart.roll(0);
      void tween(this.cartOffset, {
        x: 0,
        y: 0,
        r: 0,
        duration: 0.35,
        ease: 'power2.out',
        onUpdate: () => this.placeCart(),
      });
      return;
    }
    gsap.killTweensOf(this.cartOffset);
    this.cartOffset.x = at.dx;
    this.cartOffset.y = at.dy;
    this.cartOffset.r = at.rotation;
    this.cart.roll(120 * this.art.unit);
    this.placeCart();
  }

  async probeOutcome(_trial: RoadHomeTrial, choice: 'safe' | 'risky' | null): Promise<void> {
    const ms = this.beat(VIEW_BEATS.probe);
    const piece = this.piece;
    if (!(piece instanceof CrossingPiece) || choice === null) {
      await sleep(ms);
      return;
    }
    const branch: Branch =
      choice === 'safe' ? piece.safeSide : piece.safeSide === 'left' ? 'right' : 'left';
    const d = piece.drive[branch];
    this.cart.roll(500 * this.art.unit);
    await tween(this.cartOffset, {
      x: d.dx,
      y: d.dy,
      s: d.scale,
      duration: (ms * 0.9) / 1000,
      ease: 'sine.in',
      onUpdate: () => this.placeCart(),
    });
    this.cart.roll(0);
  }

  fuelChanged(tokens: number): void {
    const stop = this.piece;
    if (stop instanceof FodderStop) stop.setPlayerTokens(tokens);
    this.ctx.audio.playSfx('pop', { volume: 0.4 });
  }

  setHurry(hurry: boolean): void {
    this.hurry = hurry;
    this.map.setHurry(hurry);
  }

  async outro(signal: AbortSignal): Promise<void> {
    const total = this.beat(VIEW_BEATS.outro);
    if (this.mode === 'map') await this.leaveMap(total * 0.2);
    if (this.piece instanceof FodderStop) this.cart.reclaimPartner();
    void this.toSky(1, total * 0.5);
    const m = this.land.metrics;
    const home = new HomePiece(this.art, m);
    const resetting = this.resetCart(total * 0.3);
    await this.rollTo(home, m.cartX + this.cart.frontX + this.art.w * 0.06, total * 0.38);
    await resetting;
    home.greet();
    this.cart.partner.setView('three_quarter');
    this.cart.partner.setExpression('delighted');
    void this.cart.partner.play('wave');
    this.ctx.audio.playSfx('bell', { volume: 0.5 });
    this.art.burst(this.fxLayer, 'petals', { x: this.art.w * 0.62, y: this.art.h * 0.5 }, 30, 3000);
    await sleep(total * 0.42, signal);
    // Warm handover: the lamplight blooms into the report.
    this.veil.clear().rect(0, 0, this.art.w, this.art.h).fill(0xffe2a8);
    this.veil.alpha = 0;
    await tween(this.veil, { alpha: 0.32, duration: (total * 0.2) / 1000, ease: 'sine.in' });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.art.ticker.remove(this.onTick);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.clearTargets();
    this.replayTarget?.remove();
    this.replayTarget = null;
    gsap.killTweensOf(this.story);
    gsap.killTweensOf(this.cartOffset);
    gsap.killTweensOf(this.veil);
    gsap.killTweensOf(this.journey);
    gsap.killTweensOf(this.journey.scale);
    gsap.killTweensOf(this.map.view);
    gsap.killTweensOf(this.map.view.scale);
    this.hand?.destroy();
    this.teardownHud();
    for (const o of this.oldPieces) o.piece.destroy();
    this.oldPieces = [];
    this.piece?.destroy();
    this.piece = null;
    this.cart.destroy();
    this.map.destroy();
    this.sky.destroy();
    this.land.destroy();
    this.replay?.destroy();
    this.confirm?.destroy();
    this.root.destroy({ children: true });
    this.art.destroy();
  }
}
