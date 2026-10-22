/**
 * The Pixi presentation of The Stall: the afternoon fair seen from behind a chaat, sweets and fruit
 * counter. Implements {@link StallView}; it never times, gates or logs anything (the episode does).
 *
 * Layers (back to front): animated parallax backdrop (`stall_front`, lighting tied to the time of day)
 * -> customers (queue + the one at the counter, depth sorted) -> the counter with its goods, posts and
 * garlands -> the guide (an over-the-shoulder co-vendor at the screen edge) -> stimuli and diegetic UI
 * (thought bubble, serving plate item, tone medallions, probe offers, timer, hints) -> art-kit overlay.
 *
 * Stimulus rules: `present*` makes the stimulus fully visible in the same frame (only a small scale
 * settle follows), nothing animates over the bubble, the plate or the choice targets while they are
 * live, and every reaction is non-evaluative (no points, numbers or "wrong" sounds).
 */
import type { BlockConfig } from '@shriii/contracts';
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { createArtKit, MelaArtKit } from '../../../art/ArtKit.ts';
import type { MelaBackdrop } from '../../../art/backdrop/MelaBackdrop.ts';
import type {
  ProceduralCharacter,
  RigCharacterSpec,
} from '../../../art/characters/ProceduralCharacter.ts';
import type { RigView } from '../../../art/characters/rig/kinematics.ts';
import { glowDisc, rgba, rgrad } from '../../../art/draw.ts';
import { killTweensDeep, motionSettings } from '../../../art/motion.ts';
import { MELA } from '../../../art/palettes.ts';
import type { HandHint } from '../../../art/ui/buttons.ts';
import type {
  Backdrop,
  CharacterRole,
  ModuleContext,
  ParticleKind,
  Point,
  SfxId,
  VoicePlayback,
} from '../../../core/contracts.ts';
import { type StallGeometry, stallGeometry } from '../layout.ts';
import type {
  CustomerLook,
  ProbeCode,
  ProbeTrial,
  ServeTrial,
  StallItem,
  StallPlan,
  StallTrial,
  ToneCode,
  ToneTrial,
} from '../schedule.ts';
import type { ServeResolution, StallBeat, StallView } from '../view.ts';
import { drawStallItem, FlySwarm } from './items.ts';
import {
  DiyaTimer,
  drawCoin,
  drawCounter,
  drawGoodsDisplay,
  drawPost,
  drawReadyRing,
  drawRiskyOffer,
  drawServingPlate,
  drawSpeechBalloon,
  drawSureOffer,
  drawThoughtBubble,
  drawToneMedallion,
  propTint,
} from './props.ts';

/**
 * Continuous time of day per beat (0 morning .. 1 midday .. 2 golden hour .. 3 dusk). Pathway A is one
 * evening: the Stall opens in the warm late afternoon and closes at golden hour, the Weighing Post
 * carries golden hour on towards sunset, and the Road Home runs sunset -> dusk -> night. The Stall
 * must therefore end before the Weighing Post begins (its first value is STALL_END_TIME).
 */
const BEAT_TIME: Readonly<Record<StallBeat | 'intro' | 'outro', number>> = {
  intro: 1.5,
  practice: 1.54,
  service: 1.6,
  tone_calm: 1.68,
  timed_rush: 1.8,
  rude_run: 1.95,
  probe: 2.08,
  outro: 2.16,
};

/** Rig scale used when creating customers (display scales <= this keep the bake crisp). */
const CUSTOMER_BAKE_SCALE_LANDSCAPE = 2.2;
const CUSTOMER_BAKE_SCALE_PORTRAIT = 2.9;

/**
 * Hide the rig's rising steam puffs (labels `steam0..3` in its `symbols` layer). Against the bright
 * fair sky their light-tinted fill vanishes and only the outlines remain, reading as stray ghost rings
 * near the top of the frame. The anger mark, the face, the gesture and the storm balloon still carry
 * the tone level, so no tone cue is lost. The layer rebuilds its children on change, hence every frame.
 */
function hideSteamPuffs(root: Container): void {
  const stack: Container[] = [root];
  while (stack.length > 0) {
    const c = stack.pop() as Container;
    if (c.label === 'symbols') {
      for (const s of c.children) if (s.label.startsWith('steam')) s.visible = false;
      return;
    }
    for (const ch of c.children) stack.push(ch as Container);
  }
}

/** A villager in the queue / at the counter: a scalable wrapper around a rig character. */
class Actor {
  readonly root = new Container();
  readonly rig: ProceduralCharacter;
  constructor(
    rig: ProceduralCharacter,
    readonly trialIndex: number,
    private readonly bakeScale: number,
  ) {
    this.rig = rig;
    this.root.addChild(rig.view);
    this.root.eventMode = 'none';
  }
  /** Place at a feet position with a display scale (absolute, unit included). */
  place(x: number, feetY: number, scale: number): void {
    this.root.position.set(x, feetY);
    this.root.scale.set(scale / this.bakeScale);
    this.root.zIndex = feetY;
  }
  /** Walk to a spot over `ms` (treadmill gait while the wrapper glides). */
  walk(
    x: number,
    feetY: number,
    scale: number,
    ms: number,
    view: RigView,
    ease = 'sine.inOut',
  ): Promise<void> {
    // A walk requested after the scene tore down (module end) has nothing to move.
    if (this.root.destroyed || this.rig.view.destroyed) return Promise.resolve();
    killTweensDeep(this.root);
    const reduced = motionSettings.reducedMotion;
    const dx = x - this.root.x;
    if (Math.abs(dx) > 2 && !reduced) {
      this.rig.setFacing(dx < 0 ? 'left' : 'right');
      this.rig.setLocomotion('walk');
    }
    this.root.zIndex = feetY;
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.rig.view.destroyed) {
          resolve();
          return;
        }
        // Let the feet settle first, then turn to the resting view (the gait owns the view while walking).
        void this.rig.stopLocomotion().then(() => {
          if (this.rig.view.destroyed) return;
          this.rig.setFacing('right');
          this.rig.setView(view);
        });
        resolve();
      };
      if (reduced || ms <= 0) {
        this.place(x, feetY, scale);
        done();
        return;
      }
      const s = scale / this.bakeScale;
      gsap.to(this.root, {
        x,
        y: feetY,
        duration: ms / 1000,
        ease,
        onComplete: done,
        onInterrupt: done,
      });
      gsap.to(this.root.scale, { x: s, y: s, duration: ms / 1000, ease });
    });
  }
  /** Snap to the spot facing `view` now (the customer is part of the stimulus frame). */
  arriveNow(x: number, feetY: number, scale: number, view: RigView): void {
    killTweensDeep(this.root);
    this.place(x, feetY, scale);
    if (this.rig.activeGait) this.rig.setLocomotion(null);
    this.rig.setFacing('right');
    this.rig.setView(view, true);
  }
  destroy(): void {
    killTweensDeep(this.root);
    this.rig.destroy();
    if (!this.root.destroyed) this.root.destroy({ children: true });
  }
}

/** Create the Pixi scene for a module context (owns an art kit when the engine's is not the Mela kit). */
export function createStallScene(ctx: ModuleContext): StallScene {
  return new StallScene(ctx);
}

export class StallScene implements StallView {
  readonly geometry: StallGeometry;
  private readonly ctx: ModuleContext;
  private readonly kit: MelaArtKit;
  private readonly ownsKit: boolean;
  private readonly root: Container;
  private readonly world = new Container();
  private readonly crowd = new Container();
  private readonly counterLayer = new Container();
  private readonly guideLayer = new Container();
  private readonly ui = new Container();
  private readonly fx = new Container();
  private backdrop: (MelaBackdrop & Backdrop) | null = null;
  private plan: StallPlan | null = null;
  private guide: ProceduralCharacter | null = null;
  private guideRoot = new Container();
  private queue: Actor[] = [];
  private current: Actor | null = null;
  private readonly leaving = new Set<Actor>();
  private plateItem: Container | null = null;
  private swarm: FlySwarm | null = null;
  private readonly plate = new Container();
  private readyRing: Graphics | null = null;
  private bubble: Container | null = null;
  private balloon: Container | null = null;
  private readonly medallions = new Map<ToneCode, Container>();
  private readonly offers = new Map<ProbeCode, Container>();
  private timer: DiyaTimer | null = null;
  private timerTween: gsap.core.Timeline | null = null;
  private hint: HandHint | null = null;
  private coinBowl: Point = { x: 0, y: 0 };
  private elapsed = 0;
  private destroyed = false;
  private unsubLight: (() => void) | null = null;
  private readonly tintables: Container[] = [];
  private readonly emitters = new Set<{ destroy(): void }>();
  private readonly onTick = (t: Ticker): void => this.tick(Math.min(0.1, t.deltaMS / 1000));

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.root = ctx.stage;
    if (ctx.art instanceof MelaArtKit) {
      this.kit = ctx.art;
      this.ownsKit = false;
    } else {
      this.kit = createArtKit({ app: ctx.app, layout: ctx.layout, grain: false });
      this.ownsKit = true;
    }
    this.geometry = stallGeometry(ctx.layout);
    this.world.label = 'stall:world';
    this.crowd.sortableChildren = true;
    this.world.addChild(this.crowd, this.counterLayer, this.guideLayer, this.ui, this.fx);
    this.root.addChild(this.world);
    this.root.label = 'stall';
  }

  private get unit(): number {
    return this.geometry.unit;
  }

  private get reduced(): boolean {
    return motionSettings.reducedMotion || this.kit.quality.reducedMotion;
  }

  private sfx(id: SfxId, volume = 0.7): void {
    try {
      this.ctx.audio.playSfx(id, { volume });
    } catch {
      // audio is optional
    }
  }

  /* =========================================== build =========================================== */

  async prepare(plan: StallPlan): Promise<void> {
    this.plan = plan;
    const g = this.geometry;
    const u = this.unit;
    const bd = this.kit.createBackdrop('stall_front', 'midday');
    bd.setTimeValue(BEAT_TIME.intro, 0);
    this.backdrop = bd;
    this.world.addChildAt(bd.view, 0);

    // Counter covering the backdrop's own counter, posts and goods.
    // The counter's back rail rises above the far edge to cover the backdrop's own counter goods.
    const rail = g.height * 0.052;
    const counterH = g.height - g.counterTop + rail + 4 * u;
    const counter = this.kit.cache.bake(
      `stall:counter:${Math.round(g.width)}x${Math.round(g.height)}`,
      () => drawCounter(g.width + 4, counterH, u),
    );
    counter.position.set(-2, g.counterTop - rail);
    this.counterLayer.addChild(counter);
    this.tintables.push(counter);
    const postH = g.counterTop + 20 * u;
    for (const x of [g.width * 0.012, g.width * 0.988]) {
      const post = this.kit.cache.bake(`stall:post:${Math.round(postH)}`, () => drawPost(postH, u));
      post.position.set(x, 0);
      this.counterLayer.addChild(post);
      this.tintables.push(post);
    }
    const itemPx = (g.portrait ? 62 : 70) * u;
    // Goods sit towards the back of the counter, clear of the choice zones (thirds of the safe area).
    const surfaceY = g.counterTop + (g.height - g.counterTop) * 0.2;
    const left: [StallItem, number, number][] = g.portrait
      ? [['mango', 4, 0.25]]
      : [
          ['mango', 9, 0.05],
          ['guava', 6, 0.3],
        ];
    const right: [StallItem, number, number][] = g.portrait
      ? [['laddoo', 4, 0.75]]
      : [
          ['laddoo', 9, 0.71],
          ['jalebi', 5, 0.955],
        ];
    for (const [item, n, fx] of [...left, ...right]) {
      const d = this.kit.cache.bake(`stall:display:${item}:${n}:${Math.round(itemPx)}`, () =>
        drawGoodsDisplay(item, n, itemPx, u, `display:${item}`),
      );
      d.position.set(g.width * fx, surfaceY + itemPx * 0.4);
      this.counterLayer.addChild(d);
      this.tintables.push(d);
    }
    // Brass coin bowl beside the plate (payments land here; it never fills up: no tally).
    this.coinBowl = {
      x: g.plate.center.x + g.plate.radius * 1.75,
      y: g.plate.center.y + g.plate.radius * 0.1,
    };
    const bowl = new Container();
    const bowlArt = new Graphics();
    bowl.addChild(bowlArt);
    bowlArt.ellipse(0, 0, 52 * u, 18 * u).fill(
      rgrad([
        [0, MELA.brassLight],
        [0.7, MELA.brass],
        [1, 0x8a6a1e],
      ]),
    );
    bowlArt.ellipse(0, -3 * u, 42 * u, 13 * u).fill(0x6a4a10);
    for (let i = 0; i < 6; i++) {
      const coin = drawCoin(8 * u);
      coin.position.set((i - 2.5) * 11 * u, -6 * u - (i % 2) * 4 * u);
      coin.scale.y = 0.55;
      bowl.addChild(coin);
    }
    bowl.position.set(this.coinBowl.x, this.coinBowl.y);
    this.counterLayer.addChild(bowl);

    // Serving plate (target) with its ready ring.
    const r = g.plate.radius;
    this.readyRing = drawReadyRing(r);
    this.readyRing.alpha = 0;
    this.readyRing.blendMode = 'add';
    const plateArt = this.kit.cache.bake(`stall:plate:${Math.round(r)}`, () => drawServingPlate(r));
    this.plate.addChild(this.readyRing, plateArt);
    this.plate.position.set(g.plate.center.x, g.plate.center.y);
    this.ui.addChild(this.plate);

    // Tone medallions and probe offers (hidden until presented).
    plan.toneCodes.forEach((code, i) => {
      const f = g.toneFaces[i];
      if (!f) return;
      const m = new Container();
      m.addChild(
        this.kit.cache.bake(`stall:tone:${code}:${Math.round(f.radius)}`, () =>
          drawToneMedallion(code, f.radius),
        ),
      );
      m.position.set(f.center.x, f.center.y);
      m.visible = false;
      this.ui.addChild(m);
      this.medallions.set(code, m);
    });
    plan.probeCodes.forEach((code, i) => {
      const p = g.probes[i];
      if (!p) return;
      const o = new Container();
      o.position.set(p.center.x, p.center.y);
      o.visible = false;
      this.ui.addChild(o);
      this.offers.set(code, o);
    });

    // Rush timer.
    this.timer = new DiyaTimer(Math.max(40 * u, g.plate.radius * 0.6));
    this.timer.view.position.set(g.timer.x, g.timer.y);
    this.timer.view.visible = false;
    this.ui.addChild(this.timer.view);

    // Guide (co-vendor) waiting just off-screen right.
    const guideSpec: RigCharacterSpec = {
      id: 'stall-guide',
      role: 'guide',
      view: 'three_quarter',
      facing: 'left',
      scale: g.guideStage.scale / u,
      idleVariations: true,
    };
    const guide = this.kit.createCharacter(guideSpec);
    this.guide = guide;
    this.guideRoot.addChild(guide.view);
    this.guideRoot.position.set(g.width + 260 * u, g.guide.feetY);
    this.guideRoot.scale.set(g.guide.scale / g.guideStage.scale);
    this.guideLayer.addChild(this.guideRoot);

    // Pre-bake every look of the session now (unmeasured), so no texture is baked during a trial.
    await this.prewarmLooks(plan);
    // Queue: the next customers wait in line from the start.
    this.refillQueue(0, true);
    this.unsubLight = this.kit.lighting.subscribe((p) => {
      const tint = propTint(p.lightTint);
      for (const c of this.tintables) if (!c.destroyed) c.tint = tint;
    });
    this.ctx.app.ticker.add(this.onTick);
    this.kit.raiseOverlay();
  }

  private async prewarmLooks(plan: StallPlan): Promise<void> {
    const t0 = performance.now();
    const seen = new Set<string>();
    let n = 0;
    for (const t of plan.trials) {
      const key = `${this.roleOf(t)}:${t.customer.variant}:${t.customer.cloth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.makeActor(t);
      for (const v of ['side', 'front', 'three_quarter'] as const) {
        a.rig.setView(v, true);
        a.rig.advance(0);
      }
      a.destroy();
      n += 1;
      // Yield so the loading frame stays responsive.
      if (n % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (import.meta.env?.DEV)
      console.info(`[stall] pre-baked ${n} looks in ${Math.round(performance.now() - t0)} ms`);
  }

  private tick(dt: number): void {
    if (this.destroyed) return;
    this.elapsed += dt;
    this.timer?.flicker(this.elapsed);
    if (this.current) hideSteamPuffs(this.current.rig.view);
    // Slow ambient camera drift (parallax only; the stimulus layers never move).
    if (!this.reduced && this.backdrop)
      this.backdrop.setParallax(Math.sin(this.elapsed * 0.07) * 0.08);
  }

  /* ========================================== customers ========================================= */

  private roleOf(trial: StallTrial): CharacterRole {
    return trial.kind === 'probe' ? 'vendor' : 'customer';
  }

  private bakeScale(): number {
    return this.geometry.portrait ? CUSTOMER_BAKE_SCALE_PORTRAIT : CUSTOMER_BAKE_SCALE_LANDSCAPE;
  }

  private makeActor(trial: StallTrial): Actor {
    const look: CustomerLook = trial.customer;
    const spec: RigCharacterSpec = {
      id: `stall-c-${trial.spec.trial_index}`,
      role: this.roleOf(trial),
      variant: look.variant,
      cloth: look.cloth,
      view: 'three_quarter',
      facing: 'right',
      scale: this.bakeScale(),
      idleVariations: true,
    };
    const rig = this.kit.createCharacter(spec);
    rig.setExpression('calm');
    const a = new Actor(rig, trial.spec.trial_index, this.bakeScale() * this.unit);
    this.crowd.addChild(a.root);
    return a;
  }

  /** Make the queue show the customers of the trials after `fromIndex` (position in plan.trials). */
  private refillQueue(fromPos: number, instant: boolean): void {
    const plan = this.plan;
    if (!plan) return;
    const g = this.geometry;
    const slots = g.queue;
    const wanted = plan.trials.slice(fromPos, fromPos + slots.length);
    const kept: Actor[] = [];
    for (const a of this.queue) {
      if (wanted.some((t) => t.spec.trial_index === a.trialIndex)) kept.push(a);
      else a.destroy();
    }
    this.queue = wanted.map(
      (t) => kept.find((a) => a.trialIndex === t.spec.trial_index) ?? this.spawnAtEntry(t, instant),
    );
    this.queue.forEach((a, i) => {
      const s = slots[i];
      if (!s) return;
      if (instant) {
        a.place(s.x, s.feetY, s.scale);
        a.rig.setView('three_quarter', true);
      } else {
        void a.walk(s.x, s.feetY, s.scale, 900, 'three_quarter');
      }
    });
  }

  private spawnAtEntry(trial: StallTrial, instant: boolean): Actor {
    const a = this.makeActor(trial);
    const back = this.geometry.queue.at(-1);
    if (back) a.place(instant ? back.x : this.geometry.entryX, back.feetY, back.scale);
    return a;
  }

  customerApproach(trial: StallTrial, durationMs: number): void {
    const plan = this.plan;
    if (!plan) return;
    const g = this.geometry;
    const pos = plan.trials.indexOf(trial);
    let actor = this.queue.find((a) => a.trialIndex === trial.spec.trial_index) ?? null;
    if (actor) this.queue = this.queue.filter((a) => a !== actor);
    else {
      actor = this.makeActor(trial);
      const front = g.queue[0];
      if (front) actor.place(front.x, front.feetY, front.scale);
    }
    this.current = actor;
    // Approach with a calm face; the tone (a stimulus property) is shown from the stimulus frame on.
    actor.rig.setExpression(trial.kind === 'probe' ? 'happy' : 'calm');
    void actor.walk(
      g.customer.x,
      g.customer.feetY,
      g.customer.scale,
      Math.max(120, durationMs * 0.8),
      'front',
      'power2.out',
    );
    this.refillQueue(pos + 1, false);
  }

  /** Send the counter customer away (a quick step aside while reacting, then out to the right). */
  private dismissCurrent(react: (a: Actor) => void, linger = 380): void {
    const a = this.current;
    if (!a) return;
    this.current = null;
    this.leaving.add(a);
    const g = this.geometry;
    react(a);
    // Step clear of the counter spot before the next customer arrives (wider on narrow portrait
    // screens, where a customer is a third of the stage wide), then leave behind them to the right.
    const aside = g.portrait ? 0.36 : 0.17;
    void a
      .walk(
        g.customer.x + g.width * aside,
        g.customer.feetY - 6 * this.unit,
        g.customer.scale * 0.97,
        linger,
        'front',
        'power1.out',
      )
      .then(() =>
        a.walk(
          g.exitX,
          g.customer.feetY - 30 * this.unit,
          g.customer.scale * 0.9,
          g.portrait ? 650 : 900,
          'side',
          'sine.in',
        ),
      )
      .then(() => {
        this.leaving.delete(a);
        a.destroy();
      });
  }

  /* ========================================== serving =========================================== */

  /** The counter customer is in place and facing the player on the stimulus frame. */
  private arriveCurrent(): void {
    const g = this.geometry;
    this.current?.arriveNow(g.customer.x, g.customer.feetY, g.customer.scale, 'front');
  }

  private showPlate(on: boolean): void {
    killTweensDeep(this.plate);
    this.plate.scale.set(1);
    this.plate.visible = on;
    this.plate.alpha = 1;
  }

  presentServe(trial: ServeTrial): void {
    const g = this.geometry;
    this.clearStimulus();
    this.arriveCurrent();
    this.showPlate(true);
    // Thought bubble: what the customer asks for (always the fresh item).
    const br = g.bubble.radius;
    const bubble = new Container();
    const tail = {
      x: g.customerHead.x - g.bubble.center.x + 40 * this.unit,
      y: g.customerHead.y - g.bubble.center.y,
    };
    bubble.addChild(drawThoughtBubble(br, tail.x, tail.y));
    const want = this.kit.cache.bake(`stall:item:${trial.item}:f`, () =>
      drawStallItem(trial.item, false),
    );
    want.scale.set((br * 1.25) / 100);
    bubble.addChild(want);
    bubble.position.set(g.bubble.center.x, g.bubble.center.y);
    this.ui.addChild(bubble);
    this.bubble = bubble;
    this.settle(bubble, 0.9);

    // The item on the serving plate: fresh, or spoiled (rot, mould, flies, stink wisps).
    const r = g.plate.radius;
    const item = new Container();
    const art = this.kit.cache.bake(`stall:item:${trial.item}:${trial.spoiled ? 's' : 'f'}`, () =>
      drawStallItem(trial.item, trial.spoiled),
    );
    art.scale.set((r * 1.15) / 100);
    item.addChild(art);
    if (trial.spoiled) {
      this.swarm = new FlySwarm(
        this.ctx.app.ticker,
        r * 0.9,
        this.reduced,
        `flies:${trial.spec.trial_id}`,
      );
      item.addChild(this.swarm.view);
    }
    item.position.set(g.plate.center.x, g.plate.center.y - r * 0.28);
    this.ui.addChild(item);
    this.plateItem = item;
    this.settle(item, 0.85);
    if (this.readyRing) this.readyRing.alpha = 1;
    this.current?.rig.setTone(trial.toneLevel);
    this.current?.rig.lookAt(g.plate.center);
    this.sfx('pop', 0.45);
  }

  startTimer(windowMs: number): void {
    const t = this.timer;
    if (!t) return;
    this.timerTween?.kill();
    t.view.visible = true;
    for (const p of t.petals) {
      p.alpha = 1;
      p.scale.set(1);
    }
    t.flame.scale.set(1);
    const tl = gsap.timeline();
    const step = windowMs / 1000 / t.petals.length;
    t.petals.forEach((p, i) => {
      tl.to(p, { alpha: 0, duration: Math.min(0.12, step), ease: 'power1.in' }, i * step);
      tl.to(p.scale, { x: 0.3, y: 0.3, duration: Math.min(0.12, step) }, i * step);
    });
    tl.to(t.flame.scale, { x: 0.45, y: 0.45, duration: windowMs / 1000, ease: 'none' }, 0);
    this.timerTween = tl;
    this.sfx('timer_tick', 0.35);
  }

  serveTapped(_trial: ServeTrial): void {
    // Squash-and-stretch on the plate: immediate, satisfying, identical for every tap.
    killTweensDeep(this.plate);
    this.plate.scale.set(1);
    if (this.reduced) return;
    gsap.fromTo(
      this.plate.scale,
      { x: 1.08, y: 0.9 },
      { x: 1, y: 1, duration: 0.35, ease: 'elastic.out(1, 0.45)' },
    );
    this.sfx('tap_soft', 0.5);
  }

  resolveServe(trial: ServeTrial, resolution: ServeResolution): void {
    const g = this.geometry;
    this.timerTween?.kill();
    if (this.readyRing) this.readyRing.alpha = 0;
    this.popAway(this.bubble);
    this.bubble = null;
    const item = this.plateItem;
    this.plateItem = null;
    const swarm = this.swarm;
    this.swarm = null;
    const actor = this.current;
    const grumble = trial.feedback === 'negative';
    if (resolution === 'served' && item && actor) {
      // The item arcs into the customer's hands; a coin comes back to the bowl.
      const hand = actor.rig.handPosition('r');
      const to = this.ui.toLocal(hand);
      const reduced = this.reduced;
      gsap.to(item, { x: to.x, duration: reduced ? 0 : 0.28, ease: 'power1.out' });
      gsap.to(item, {
        y: to.y,
        duration: reduced ? 0 : 0.28,
        ease: 'back.in(1.4)',
        onComplete: () => {
          swarm?.destroy();
          item.destroy({ children: true });
        },
      });
      gsap.to(item.scale, { x: 0.55, y: 0.55, duration: reduced ? 0 : 0.28 });
      this.sfx('whoosh', 0.35);
      if (!trial.spoiled) this.payCoin(hand);
    } else if (item) {
      // Held back: spoiled food goes into the compost basket under the counter; fresh food slides aside.
      gsap.to(item, {
        y: g.height + 120 * this.unit,
        x: item.x - (trial.spoiled ? 40 : -220) * this.unit,
        rotation: trial.spoiled ? 1.2 : 0,
        alpha: 0,
        duration: this.reduced ? 0 : 0.45,
        ease: 'power2.in',
        onComplete: () => {
          swarm?.destroy();
          item.destroy({ children: true });
        },
      });
      if (trial.spoiled) this.burst('dust', { x: item.x, y: g.height - 30 * this.unit }, 8);
    }
    this.dismissCurrent((a) => {
      a.rig.clearLook();
      if (grumble) {
        a.rig.setExpression('annoyed');
        void a.rig.play('head_shake');
      } else if (resolution === 'served' && trial.spoiled) {
        a.rig.react('surprised', 0.6);
        a.rig.setExpression('thinking');
      } else if (resolution === 'served') {
        a.rig.setExpression(trial.practice ? 'delighted' : 'happy');
        void a.rig.play('nod');
      } else if (trial.spoiled) {
        a.rig.setExpression('pleased');
        void a.rig.play('nod');
      } else {
        a.rig.setExpression('thinking');
        void a.rig.play('shrug');
      }
    });
  }

  private payCoin(from: Point): void {
    const start = this.ui.toLocal(from);
    const coin = drawCoin(11 * this.unit);
    coin.position.set(start.x, start.y);
    this.fx.addChild(coin);
    const to = this.coinBowl;
    const d = this.reduced ? 0 : 0.42;
    gsap.to(coin, { x: to.x, duration: d, delay: 0.18, ease: 'none' });
    gsap.to(coin, {
      y: to.y - 8 * this.unit,
      duration: d,
      delay: 0.18,
      ease: 'back.in(2.2)',
      onComplete: () => {
        coin.destroy();
        this.sfx('coin_drop', 0.45);
        this.burst('sparkle', to, 6);
      },
    });
  }

  /* ========================================== tone choice ======================================= */

  presentTone(trial: ToneTrial, codes: readonly ToneCode[]): void {
    const g = this.geometry;
    this.clearStimulus();
    this.arriveCurrent();
    this.showPlate(false);
    const a = this.current;
    if (a) {
      a.rig.setTone(trial.toneLevel);
      a.rig.lookAt({ x: g.width / 2, y: g.height });
      const gesture =
        trial.toneLevel >= 4
          ? 'point'
          : trial.toneLevel === 3
            ? 'fold_arms'
            : trial.toneLevel === 2
              ? 'foot_tap'
              : 'namaste';
      void a.rig.play(gesture);
    }
    // Speech balloon: the tone pictured by shape, beside the customer's head (away from the targets).
    const br = 62 * this.unit;
    const balloon = drawSpeechBalloon(trial.toneLevel, br, true);
    balloon.position.set(
      g.customerHead.x + (g.portrait ? 200 : 260) * this.unit,
      g.customerHead.y - (g.portrait ? 170 : 120) * this.unit,
    );
    this.ui.addChild(balloon);
    this.balloon = balloon;
    this.settle(balloon, 0.85);
    for (const code of codes) {
      const m = this.medallions.get(code);
      if (!m) continue;
      killTweensDeep(m);
      m.visible = true;
      m.alpha = 1;
      this.settle(m, 0.9);
    }
  }

  customerSpeak(_trial: ToneTrial, speech: VoicePlayback | null): void {
    const a = this.current;
    if (!a) return;
    if (speech) void a.rig.speak(speech);
    else void a.rig.speakFor(1500);
  }

  toneChosen(_trial: ToneTrial, code: ToneCode | null): void {
    for (const [c, m] of this.medallions) {
      if (!m.visible) continue;
      killTweensDeep(m);
      if (c === code) {
        m.scale.set(1);
        if (!this.reduced)
          gsap.fromTo(
            m.scale,
            { x: 1.18, y: 0.88 },
            { x: 1, y: 1, duration: 0.45, ease: 'elastic.out(1, 0.4)' },
          );
        this.glowAt(m.position, m.width * 0.55);
        this.sendReply(c, m.position);
      } else {
        gsap.to(m, { alpha: 0.3, duration: this.reduced ? 0 : 0.2 });
      }
    }
    if (code) this.sfx('tap_soft', 0.55);
  }

  /** A small copy of the chosen face floats up to the customer (the reply being spoken). */
  private sendReply(code: ToneCode, from: Point): void {
    const g = this.geometry;
    const f = g.toneFaces[0];
    if (!f) return;
    const copy = this.kit.cache.bake(`stall:tone:${code}:${Math.round(f.radius)}`, () =>
      drawToneMedallion(code, f.radius),
    );
    copy.position.set(from.x, from.y);
    copy.alpha = 0.95;
    this.fx.addChild(copy);
    const to = { x: g.customerHead.x - 120 * this.unit, y: g.customerHead.y + 40 * this.unit };
    const d = this.reduced ? 0 : 0.6;
    gsap.to(copy, {
      x: to.x,
      y: to.y,
      alpha: 0,
      duration: d,
      ease: 'power2.out',
      onComplete: () => copy.destroy({ children: true }),
    });
    gsap.to(copy.scale, { x: 0.45, y: 0.45, duration: d, ease: 'power2.out' });
  }

  resolveTone(trial: ToneTrial): void {
    for (const m of this.medallions.values()) {
      if (!m.visible) continue;
      gsap.to(m, {
        alpha: 0,
        duration: this.reduced ? 0 : 0.22,
        onComplete: () => {
          m.visible = false;
        },
      });
    }
    this.popAway(this.balloon);
    this.balloon = null;
    const a = this.current;
    if (a) {
      // The customer collects their order (non-contingent: the same for every reply).
      const item = this.kit.cache.bake(`stall:item:${trial.item}:f`, () =>
        drawStallItem(trial.item, false),
      );
      item.scale.set(0.5 * this.unit);
      a.rig.hold(item, 'r');
    }
    this.dismissCurrent((x) => {
      x.rig.stopSpeaking();
      x.rig.clearLook();
      if (trial.toneLevel >= 3) void x.rig.play('head_shake');
      else {
        x.rig.setExpression('pleased');
        void x.rig.play('nod');
      }
    }, 300);
  }

  /* ============================================ probes ========================================== */

  presentProbe(trial: ProbeTrial, codes: readonly ProbeCode[]): void {
    const g = this.geometry;
    this.clearStimulus();
    this.arriveCurrent();
    this.showPlate(false);
    codes.forEach((code, i) => {
      const o = this.offers.get(code);
      const p = g.probes[i];
      if (!o || !p) return;
      killTweensDeep(o);
      for (const c of o.removeChildren()) c.destroy({ children: true });
      o.addChild(code === 'safe' ? drawSureOffer(p.size, trial.sureCoins) : drawRiskyOffer(p.size));
      o.position.set(p.center.x, p.center.y);
      o.visible = true;
      o.alpha = 1;
      this.settle(o, 0.9);
    });
    const a = this.current;
    if (a) {
      a.rig.setExpression('happy');
      void a.rig.play('beckon');
    }
    this.sfx('chime', 0.4);
  }

  probeChosen(_trial: ProbeTrial, code: ProbeCode | null): void {
    const g = this.geometry;
    for (const [c, o] of this.offers) {
      if (!o.visible) continue;
      killTweensDeep(o);
      const d = this.reduced ? 0 : 0.5;
      if (c === code) {
        this.glowAt(o.position, o.width * 0.55);
        gsap.to(o, {
          y: g.height + o.height,
          alpha: 0,
          duration: d,
          delay: 0.15,
          ease: 'power2.in',
          onComplete: () => {
            o.visible = false;
          },
        });
      } else {
        gsap.to(o, {
          y: o.y - 60 * this.unit,
          alpha: 0,
          duration: d * 0.8,
          ease: 'power1.out',
          onComplete: () => {
            o.visible = false;
          },
        });
      }
    }
    if (code) this.sfx('confirm', 0.4);
    this.dismissCurrent((a) => {
      a.rig.setExpression('pleased');
      void a.rig.play('namaste');
    }, 250);
  }

  /* ============================================ hints =========================================== */

  showHint(kind: 'serve' | 'hold_back' | null): void {
    if (kind === null) {
      this.hint?.stop();
      if (this.guide && this.guide.activeGesture === 'head_shake') void this.guide.stopGesture();
      return;
    }
    const g = this.geometry;
    if (!this.hint) {
      this.hint = this.kit.createHandHint(26);
      this.fx.addChild(this.hint.view);
    }
    if (kind === 'serve') this.hint.show('tap', { x: g.plate.center.x, y: g.plate.center.y });
    else {
      this.hint.stop();
      void this.guide?.play('head_shake');
    }
  }

  /* ======================================= story beats ========================================== */

  async intro(speech: VoicePlayback | null, signal: AbortSignal): Promise<void> {
    const g = this.geometry;
    const bd = this.backdrop;
    if (!bd) return;
    const reduced = this.reduced;
    this.world.alpha = 0;
    if (!reduced) {
      this.world.pivot.set(g.width / 2, g.height / 2);
      this.world.position.set(g.width / 2, g.height / 2);
      this.world.scale.set(1.08);
      bd.setParallax(-0.55);
    }
    gsap.to(this.world, { alpha: 1, duration: reduced ? 0.2 : 0.9, ease: 'power1.out' });
    const camera = reduced
      ? Promise.resolve()
      : Promise.all([
          bd.panTo(0, 2600),
          new Promise<void>((resolve) =>
            gsap.to(this.world.scale, {
              x: 1,
              y: 1,
              duration: 2.8,
              ease: 'power2.inOut',
              onComplete: resolve,
              onInterrupt: resolve,
            }),
          ),
        ]).then(() => undefined);
    this.burst('petals', { x: g.width * 0.5, y: -20 * this.unit }, 26);
    // The guide steps in from the right, waves and introduces the stall.
    const guide = this.guide;
    if (guide) {
      const st = g.guideStage;
      guide.setFacing('left');
      if (!reduced) guide.setLocomotion('walk');
      await this.move(this.guideRoot, st.x, st.feetY, 1, reduced ? 0 : 1100, signal);
      void guide.stopLocomotion();
      guide.setFacing('left');
      guide.setView('three_quarter');
      guide.setExpression('happy');
      void guide.play('wave');
      if (speech) void guide.speak(speech);
      await this.wait(1300, signal);
      void guide.pointAt(g.plate.center);
      this.glowAt(g.plate.center, g.plate.radius * 1.4);
      await this.wait(1100, signal);
      void guide.play('idle');
      guide.setExpression('calm');
    }
    await camera;
    await this.guideToStandby(signal);
  }

  private async guideToStandby(signal: AbortSignal): Promise<void> {
    const g = this.geometry;
    const guide = this.guide;
    if (!guide) return;
    await this.move(
      this.guideRoot,
      g.guide.x,
      g.guide.feetY,
      g.guide.scale / g.guideStage.scale,
      this.reduced ? 0 : 600,
      signal,
    );
    guide.setFacing('left');
    guide.setView('three_quarter');
  }

  private async guideToStage(signal: AbortSignal): Promise<void> {
    const g = this.geometry;
    await this.move(
      this.guideRoot,
      g.guideStage.x,
      g.guideStage.feetY,
      1,
      this.reduced ? 0 : 500,
      signal,
    );
  }

  async enterBlock(
    beat: StallBeat,
    _block: BlockConfig,
    speech: VoicePlayback | null,
    signal: AbortSignal,
  ): Promise<void> {
    const bd = this.backdrop;
    const guide = this.guide;
    const g = this.geometry;
    const light = bd
      ? bd.setTimeValue(BEAT_TIME[beat], this.reduced ? 0 : 1600)
      : Promise.resolve();
    switch (beat) {
      case 'practice': {
        await this.guideToStage(signal);
        if (guide) {
          guide.setExpression('happy');
          if (speech) void guide.speak(speech);
          void guide.pointAt(g.plate.center);
        }
        await this.wait(900, signal);
        void guide?.play('idle');
        await this.guideToStandby(signal);
        break;
      }
      case 'service': {
        if (guide) {
          guide.setExpression('delighted');
          void guide.play('clap');
        }
        this.burst('sparkle', { x: g.plate.center.x, y: g.plate.center.y - g.plate.radius }, 10);
        await this.wait(900, signal);
        guide?.setExpression('calm');
        break;
      }
      case 'tone_calm': {
        // Teaching beat: the three replies rise one by one while the guide mirrors each face.
        // The guide stays at the edge (clear of the medallions) and mirrors each face.
        this.showPlate(false);
        const faces: [ToneCode, 'delighted' | 'neutral' | 'annoyed'][] = [
          ['warm', 'delighted'],
          ['neutral', 'neutral'],
          ['firm', 'annoyed'],
        ];
        for (const [code, expr] of faces) {
          const m = this.medallions.get(code);
          if (!m) continue;
          m.visible = true;
          m.alpha = 0;
          gsap.to(m, { alpha: 1, duration: this.reduced ? 0 : 0.25 });
          this.settle(m, 0.6);
          guide?.setExpression(expr);
          if (guide && m) guide.lookAt(m.position);
          this.sfx('chime', 0.35);
          await this.wait(700, signal);
        }
        await this.wait(700, signal);
        guide?.clearLook();
        guide?.setExpression('calm');
        for (const m of this.medallions.values()) {
          gsap.to(m, {
            alpha: 0,
            duration: this.reduced ? 0 : 0.3,
            onComplete: () => {
              m.visible = false;
            },
          });
        }
        await this.wait(350, signal);
        break;
      }
      case 'timed_rush': {
        if (guide) {
          guide.setExpression('surprised');
          if (speech) void guide.speak(speech);
          void guide.pointAt({ x: g.queue[0]?.x ?? 0, y: g.height * 0.5 });
        }
        const t = this.timer;
        if (t) {
          t.view.visible = true;
          t.view.alpha = 0;
          gsap.to(t.view, { alpha: 1, duration: this.reduced ? 0 : 0.4 });
          this.burst('sparkle', { x: t.view.x, y: t.view.y - t.r }, 14);
        }
        await this.wait(1100, signal);
        void guide?.play('idle');
        guide?.setExpression('calm');
        break;
      }
      case 'rude_run': {
        // Unannounced: the rush simply ends (the lamp goes out) and the light turns golden.
        const t = this.timer;
        if (t?.view.visible) {
          this.burst('smoke', { x: t.view.x + t.r * 0.6, y: t.view.y - t.r }, 6);
          gsap.to(t.view, {
            alpha: 0,
            duration: this.reduced ? 0 : 0.5,
            onComplete: () => {
              t.view.visible = false;
            },
          });
        }
        guide?.setExpression('calm');
        await this.wait(700, signal);
        break;
      }
      case 'probe': {
        // Evening lull: lamps come on; a travelling merchant will offer a pick (preview with a hint).
        guide?.setExpression('happy');
        await this.wait(800, signal);
        if (!this.hint) {
          this.hint = this.kit.createHandHint(26);
          this.fx.addChild(this.hint.view);
        }
        // Preview: the two offers appear softly and a hand shows each can be picked.
        this.showPlate(false);
        const plan = this.plan;
        const preview: Container[] = [];
        if (plan) {
          plan.probeCodes.forEach((code, i) => {
            const p = g.probes[i];
            if (!p) return;
            const c = code === 'safe' ? drawSureOffer(p.size, 3) : drawRiskyOffer(p.size);
            c.position.set(p.center.x, p.center.y);
            c.alpha = 0;
            this.ui.addChild(c);
            preview.push(c);
            gsap.to(c, { alpha: 0.75, duration: this.reduced ? 0 : 0.3 });
          });
        }
        const [a, b] = g.probes;
        if (a && b) {
          this.hint.show('tap', a.center);
          await this.wait(1000, signal);
          this.hint.show('tap', b.center);
          await this.wait(1000, signal);
        }
        this.hint.stop();
        for (const c of preview) this.popAway(c);
        break;
      }
    }
    await light;
  }

  async outro(speech: VoicePlayback | null, signal: AbortSignal): Promise<void> {
    const g = this.geometry;
    const guide = this.guide;
    this.clearStimulus();
    const light =
      this.backdrop?.setTimeValue(BEAT_TIME.outro, this.reduced ? 0 : 1800) ?? Promise.resolve();
    await this.guideToStage(signal);
    if (guide) {
      guide.setExpression('delighted');
      void guide.play('namaste');
      if (speech) void guide.speak(speech);
    }
    this.burst('petals', { x: g.width * 0.5, y: -20 * this.unit }, 34);
    this.burst('sparkle', { x: g.plate.center.x, y: g.plate.center.y - g.plate.radius }, 16);
    if (!this.reduced) {
      // Slow push-in towards the guide (scaling up never reveals the world's edges).
      const fx = g.guideStage.x;
      const fy = g.height * 0.62;
      this.world.pivot.set(fx, fy);
      this.world.position.set(fx, fy);
      gsap.to(this.world.scale, { x: 1.045, y: 1.045, duration: 2.6, ease: 'sine.inOut' });
    }
    await Promise.all([light, this.wait(1600, signal)]);
  }

  /* ============================================ helpers ========================================= */

  private clearStimulus(): void {
    this.popAway(this.bubble);
    this.bubble = null;
    this.popAway(this.balloon);
    this.balloon = null;
  }

  /** Visible at full opacity in this frame, then a short scale settle (never delays the stimulus). */
  private settle(c: Container, from: number): void {
    c.visible = true;
    c.alpha = 1;
    if (this.reduced) {
      c.scale.set(1);
      return;
    }
    c.scale.set(from);
    gsap.to(c.scale, { x: 1, y: 1, duration: 0.22, ease: 'back.out(2.2)' });
  }

  private popAway(c: Container | null): void {
    if (!c || c.destroyed) return;
    killTweensDeep(c);
    if (this.reduced) {
      c.destroy({ children: true });
      return;
    }
    gsap.to(c.scale, { x: 0.6, y: 0.6, duration: 0.14, ease: 'power2.in' });
    gsap.to(c, { alpha: 0, duration: 0.14, onComplete: () => c.destroy({ children: true }) });
  }

  private glowAt(p: Point, radius: number): void {
    const g = new Graphics();
    glowDisc(g, 0, 0, radius, 0xffd27a, 0.7);
    g.blendMode = 'add';
    g.position.set(p.x, p.y);
    this.fx.addChild(g);
    gsap.fromTo(
      g,
      { alpha: 0.9 },
      {
        alpha: 0,
        duration: this.reduced ? 0.2 : 0.7,
        ease: 'power1.out',
        onComplete: () => g.destroy(),
      },
    );
    void rgba;
  }

  private burst(kind: ParticleKind, origin: Point, count: number): void {
    if (this.destroyed) return;
    const e = this.kit.createParticles({
      kind,
      origin,
      count: this.reduced ? Math.min(3, count) : count,
    });
    this.fx.addChild(e.view);
    this.emitters.add(e);
    setTimeout(() => {
      if (this.emitters.delete(e)) e.destroy();
    }, 4000);
  }

  private move(
    c: Container,
    x: number,
    y: number,
    scale: number,
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    killTweensDeep(c);
    if (ms <= 0 || signal.aborted) {
      c.position.set(x, y);
      c.scale.set(scale);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      gsap.to(c, {
        x,
        y,
        duration: ms / 1000,
        ease: 'power2.inOut',
        onComplete: resolve,
        onInterrupt: resolve,
      });
      gsap.to(c.scale, { x: scale, y: scale, duration: ms / 1000, ease: 'power2.inOut' });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** Unmeasured beat pause on the session clock (resolves early on abort). */
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return this.ctx.clock
      .delay(this.reduced ? Math.min(ms, 300) : ms, signal)
      .catch(() => undefined);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx.app.ticker?.remove(this.onTick);
    this.unsubLight?.();
    this.timerTween?.kill();
    for (const e of this.emitters) e.destroy();
    this.emitters.clear();
    this.swarm?.destroy();
    this.hint?.destroy();
    for (const a of [...this.queue, ...this.leaving]) a.destroy();
    this.current?.destroy();
    this.guide?.destroy();
    killTweensDeep(this.world);
    this.backdrop?.destroy();
    if (!this.world.destroyed) this.world.destroy({ children: true });
    if (this.ownsKit) this.kit.destroy();
  }
}
