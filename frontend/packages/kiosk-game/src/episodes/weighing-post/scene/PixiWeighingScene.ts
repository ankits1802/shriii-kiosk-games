/**
 * The rendered Weighing Post: late golden afternoon at the market fair. The player looks out from
 * behind the weighmaster's counter: a hero brass scale in the centre, the assistant beside the
 * weights, customers stepping up from the market, a rule placard hanging from the canopy and the
 * counter's carved stamps as the choices.
 *
 * Measurement integrity: every method only STARTS visuals and returns at once (the episode logic owns
 * the timeline). Stimulus-revealing methods draw synchronously so they commit on the frame the logic
 * logs. Camera moves happen only while no choice is on screen (touch rects never move under a finger).
 * Reduced motion: no camera moves or bobbing, crossfades instead of flights, fewer particles.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../../art/ArtKit.ts';
import { MelaBackdrop } from '../../../art/backdrop/MelaBackdrop.ts';
import {
  ProceduralCharacter,
  type RigCharacterSpec,
} from '../../../art/characters/ProceduralCharacter.ts';
import { mixColor } from '../../../art/color.ts';
import { rgrad } from '../../../art/draw.ts';
import { PooledEmitter } from '../../../art/fx/particles.ts';
import { Lighting } from '../../../art/lighting.ts';
import { killTweensDeep, motionSettings } from '../../../art/motion.ts';
import type { ScenePalette } from '../../../art/palettes.ts';
import { MELA } from '../../../art/palettes.ts';
import { createCoinPile, createCoinStack } from '../../../art/props/coins.ts';
import { DEFAULT_QUALITY, type QualityProfile, qualityProfile } from '../../../art/quality.ts';
import { ArtRandom } from '../../../art/rand.ts';
import { TextureCache } from '../../../art/textures.ts';
import type {
  AudioService,
  Layout,
  ModuleContext,
  ParticleKind,
  Rect,
} from '../../../core/contracts.ts';
import type { WeighDecision, WeighItem, WeighRule } from '../../../paradigms/weighing-post.ts';
import { BASE_RULE } from '../../../paradigms/weighing-post.ts';
import type { DilemmaTrial, GambleTrial, ProbeTrial, WeighTrial } from '../schedule.ts';
import { discrepancyTicks } from '../schedule.ts';
import {
  createGarland,
  createGoods,
  createStone,
  createWeightStack,
  drawBrassWeight,
} from './goods.ts';
import { HeroScale } from './HeroScale.ts';
import { choiceSlots, confirmAbove, controlRects, geometry, type SceneGeometry } from './layout.ts';
import { LuckStation } from './luck.ts';
import type { PictogramData } from './pictograms.ts';
import { RulePlacard } from './placard.ts';
import { WeighingSet } from './set.ts';
import { ChoiceToken, RoundControl } from './tokens.ts';
import type {
  ChoiceKind,
  ChoiceSlot,
  ChoiceState,
  ControlRects,
  SpeakerRole,
  WeighingScene,
} from './types.ts';

/** Customer looks: (customer variant -> villager index, cloth colourway). Never the assistant's look. */
const CUSTOMERS: readonly (readonly [number, number])[] = [
  [1, 0],
  [4, 0],
  [0, 0],
  [2, 0],
  [5, 0],
  [9, 0],
  [8, 3],
  [1, 6],
  [6, 2],
  [4, 4],
];

interface ArtDeps {
  readonly ticker: Ticker;
  readonly lighting: Lighting;
  readonly quality: QualityProfile;
  readonly cache: TextureCache;
  readonly owned: boolean;
}

function artDeps(ctx: ModuleContext): ArtDeps {
  const art = ctx.art;
  if (art instanceof MelaArtKit) {
    return {
      ticker: ctx.app.ticker,
      lighting: art.lighting,
      quality: art.profile,
      cache: art.cache,
      owned: false,
    };
  }
  const quality = qualityProfile(DEFAULT_QUALITY);
  return {
    ticker: ctx.app.ticker,
    lighting: new Lighting(),
    quality,
    cache: new TextureCache(ctx.app.renderer ?? null, quality.bakeResolution),
    owned: true,
  };
}

/** Optional overrides (dev harness / screenshots). */
export interface PixiSceneOptions {
  /** Force a reduced-motion run (a11y profile). */
  readonly reducedMotion?: boolean;
}

export class PixiWeighingScene implements WeighingScene {
  readonly renders = true;
  private readonly ctx: ModuleContext;
  private readonly deps: ArtDeps;
  private readonly audio: AudioService;
  private geo: SceneGeometry;
  private readonly root = new Container();
  private readonly world = new Container();
  private readonly bgLayer = new Container();
  private readonly charLayer = new Container();
  private readonly scaleLayer = new Container();
  private readonly propLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly uiLayer = new Container();
  private readonly overlay = new Graphics();
  private backdrop: MelaBackdrop | null = null;
  private set: WeighingSet | null = null;
  private scale: HeroScale | null = null;
  private placard: RulePlacard | null = null;
  private luck: LuckStation | null = null;
  private assistant: ProceduralCharacter | null = null;
  private guide: ProceduralCharacter | null = null;
  private inspector: ProceduralCharacter | null = null;
  private readonly customers = new Map<number, ProceduralCharacter>();
  private atCounter: ProceduralCharacter | null = null;
  private readonly onLookers: ProceduralCharacter[] = [];
  private tokens: ChoiceToken[] = [];
  private tokenKind: ChoiceKind | null = null;
  private confirm: RoundControl | null = null;
  private inspect: RoundControl | null = null;
  private replay: RoundControl | null = null;
  private petals: PooledEmitter | null = null;
  private readonly bursts = new Set<PooledEmitter>();
  private handHint: Graphics | null = null;
  private goods: Container | null = null;
  private weights: Container | null = null;
  private dilemmaProps: Container[] = [];
  private speaking: ProceduralCharacter | null = null;
  private readonly rnd = new ArtRandom(2026);
  private unsubLight: (() => void) | null = null;
  private unsubLayout: (() => void) | null = null;
  private readonly tick = (t: Ticker): void => this.update(Math.min(0.05, t.deltaMS / 1000));
  private destroyed = false;
  private timeValue = 2.16;
  /** Pictured amounts for the next token row (coins, items). */
  private pictogramData: PictogramData = {};

  constructor(ctx: ModuleContext, options: PixiSceneOptions = {}) {
    this.ctx = ctx;
    this.deps = artDeps(ctx);
    this.audio = ctx.audio;
    this.geo = geometry(ctx.layout);
    if (options.reducedMotion) motionSettings.reducedMotion = true;
    this.root.label = 'weighing-post';
    this.root.sortableChildren = false;
  }

  /* ========================================== lifecycle ========================================== */

  async mount(): Promise<void> {
    this.ctx.stage.addChild(this.root);
    this.root.addChild(this.bgLayer, this.world, this.fxLayer, this.uiLayer, this.overlay);
    this.build();
    this.unsubLight = this.deps.lighting.subscribe((p) => this.applyPalette(p));
    this.unsubLayout = this.ctx.layout.onChange((l) => this.relayout(l));
    this.deps.ticker.add(this.tick);
  }

  private build(): void {
    const SKIP = new Set((globalThis as { __wpSkip?: string[] }).__wpSkip ?? []);
    const g = this.geo;
    const u = g.u;
    const d = this.deps;
    // Backdrop: the fair at late golden afternoon.
    this.backdrop = new MelaBackdrop('market_square', 'golden_hour', g.width, g.height, {
      cache: d.cache,
      quality: d.quality,
      lighting: d.lighting,
      ticker: d.ticker,
    });
    void this.backdrop.setTimeValue(this.timeValue, 0);
    if (!SKIP.has('bg')) this.bgLayer.addChild(this.backdrop.view);

    this.set = new WeighingSet(g);
    // Light shafts sit over the backdrop, behind the people.
    this.world.addChild(
      this.set.shafts,
      this.set.back,
      this.charLayer,
      this.scaleLayer,
      this.set.counter,
      this.propLayer,
      this.set.canopy,
    );

    // Hero scale on the counter.
    this.scale = new HeroScale();
    const sc = g.scaleHeight / 700;
    this.scale.view.scale.set(sc);
    this.scale.view.position.set(g.scaleBase.x, g.scaleBase.y);
    this.scale.attach(d.ticker);
    this.scale.setSwingListener((speed) => {
      if (speed > 0.5) this.audio.playSfx('scale_creak', { volume: Math.min(0.7, speed * 0.6) });
    });
    this.scaleLayer.addChild(this.scale.view);

    // Rule placard hanging from the canopy.
    this.placard = new RulePlacard(BASE_RULE);
    this.placard.view.scale.set(g.placardScale);
    const placardX = g.portrait ? g.width * 0.19 : g.placard.x;
    const placardY = g.portrait ? g.height * 0.22 : g.placard.y + 0.06 * g.height;
    this.placard.view.position.set(placardX, placardY);
    this.world.addChildAt(this.placard.view, this.world.getChildIndex(this.set.canopy));

    // People.
    const cs = g.characterScale;
    this.assistant = this.character(
      { id: 'assistant', role: 'assistant', variant: 6, view: 'three_quarter', facing: 'left' },
      cs,
    );
    this.assistant.view.position.set(g.assistant.x, g.assistant.y);
    this.charLayer.addChild(this.assistant.view);
    this.guide = this.character(
      { id: 'guide', role: 'guide', view: 'three_quarter', facing: 'right' },
      cs,
    );
    this.guide.view.visible = false;
    this.charLayer.addChild(this.guide.view);
    // Luck corner (hidden until the luck tokens).
    this.luck = new LuckStation(
      { x: g.width / 2, y: g.counterTop + (g.portrait ? 30 : 34) * u },
      (g.portrait ? 520 : 600) * u,
      (g.portrait ? 300 : 330) * u,
      u,
      this.set.bowl,
    );
    this.propLayer.addChild(this.luck.view, this.luck.tokenLayer);

    // Persistent controls.
    const rects = controlRects(g);
    this.replay = new RoundControl('replay', rects.replay.width);
    this.place(this.replay.view, rects.replay);
    this.uiLayer.addChild(this.replay.view);
    this.inspect = new RoundControl('inspect', rects.inspect.width);
    this.place(this.inspect.view, rects.inspect);
    this.inspect.view.visible = false;
    this.confirm = new RoundControl('confirm', rects.confirm.width);
    this.place(this.confirm.view, rects.confirm);
    this.confirm.view.visible = false;
    this.uiLayer.addChild(this.inspect.view, this.confirm.view);

    // Ambient petals drifting through the light.
    this.petals = new PooledEmitter(
      { kind: 'petals', origin: { x: g.width * 0.5, y: -20 * u }, count: 26, durationMs: 600_000 },
      d.cache,
      d.ticker,
      d.quality,
      u,
    );
    this.fxLayer.addChild(this.petals.view);

    // Warm vignette and grade over everything but the UI.
    this.drawOverlay();
  }

  private character(spec: RigCharacterSpec, scale: number): ProceduralCharacter {
    return new ProceduralCharacter(
      { ...spec, scale },
      {
        ticker: this.deps.ticker,
        lighting: this.deps.lighting,
        quality: this.deps.quality,
        cache: this.deps.cache,
      },
    );
  }

  private place(view: Container, r: Rect): void {
    view.position.set(r.x + r.width / 2, r.y + r.height / 2);
  }

  private drawOverlay(): void {
    const { width: W, height: H } = this.geo;
    const o = this.overlay;
    o.clear();
    o.rect(0, 0, W, H).fill(
      rgrad(
        [
          [0, '#00000000'],
          [0.62, '#00000000'],
          [1, '#2b1b1740'],
        ],
        { x: 0.5, y: 0.42 },
        0.75,
      ),
    );
    o.eventMode = 'none';
    // The overlay is below the UI so tokens stay crisp.
    this.root.addChildAt(o, this.root.getChildIndex(this.uiLayer));
  }

  private relayout(layout: Layout): void {
    if (this.destroyed) return;
    const g = geometry(layout);
    if (g.width === this.geo.width && g.height === this.geo.height) return;
    // Rebuild everything for the new size (orientation changes are rare on a kiosk).
    this.teardown();
    this.geo = g;
    this.build();
  }

  private teardown(): void {
    for (const t of this.tokens) t.destroy();
    this.tokens = [];
    this.clearDilemmaProps();
    for (const c of [...this.customers.values(), ...this.onLookers]) c.destroy();
    this.customers.clear();
    this.onLookers.length = 0;
    this.atCounter = null;
    for (const c of [this.assistant, this.guide, this.inspector]) c?.destroy();
    this.assistant = this.guide = this.inspector = null;
    this.scale?.destroy();
    this.scale = null;
    this.placard?.destroy();
    this.placard = null;
    this.luck?.destroy();
    this.luck = null;
    this.set?.destroy();
    this.set = null;
    this.backdrop?.destroy();
    this.backdrop = null;
    for (const c of [this.confirm, this.inspect, this.replay]) c?.destroy();
    this.confirm = this.inspect = this.replay = null;
    this.petals?.destroy();
    this.petals = null;
    for (const b of this.bursts) b.destroy();
    this.bursts.clear();
    this.handHint?.destroy();
    this.handHint = null;
    this.goods = null;
    this.weights = null;
    for (const l of [
      this.bgLayer,
      this.world,
      this.charLayer,
      this.scaleLayer,
      this.propLayer,
      this.fxLayer,
      this.uiLayer,
    ]) {
      for (const ch of l.removeChildren()) if (!ch.destroyed) ch.destroy({ children: true });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.deps.ticker.remove(this.tick);
    this.unsubLight?.();
    this.unsubLayout?.();
    gsap.killTweensOf(this.world);
    gsap.killTweensOf(this.world.scale);
    gsap.killTweensOf(this.world.pivot);
    this.teardown();
    this.root.destroy({ children: true });
    if (this.deps.owned) this.deps.cache.destroy();
  }

  /* =========================================== frame ============================================ */

  private update(dt: number): void {
    this.set?.update(dt);
  }

  private applyPalette(p: ScenePalette): void {
    this.set?.applyPalette(p);
    const tint = mixColor(p.lightTint, 0xffffff, 0.3);
    if (this.scale) this.scale.view.tint = tint;
    if (this.placard) this.placard.view.tint = tint;
    if (this.luck) this.luck.view.tint = tint;
    this.propLayer.tint = tint;
  }

  setProgress(fraction: number): void {
    // Golden hour sliding towards sunset as the work goes on: it picks up where the Stall's outro
    // left the light (2.16) and hands over to the Road Home's sunset.
    const target = 2.18 + Math.max(0, Math.min(1, fraction)) * 0.47;
    if (Math.abs(target - this.timeValue) < 0.004) return;
    this.timeValue = target;
    void this.backdrop?.setTimeValue(target, 2400);
  }

  /* ========================================= geometry =========================================== */

  controls(): ControlRects {
    return controlRects(this.geo);
  }

  confirmFor(token: Rect): Rect {
    return confirmAbove(this.geo, token);
  }

  layoutChoices(kind: ChoiceKind, codes: readonly string[]): readonly ChoiceSlot[] {
    return choiceSlots(this.geo, kind, codes);
  }

  /* ========================================== choices =========================================== */

  showChoices(
    kind: ChoiceKind,
    codes: readonly string[],
    options: { readonly enabled: boolean },
  ): void {
    for (const t of this.tokens) t.destroy();
    this.tokens = [];
    this.tokenKind = kind;
    const slots = choiceSlots(this.geo, kind, codes);
    slots.forEach((slot, i) => {
      const t = new ChoiceToken(kind, slot.code, slot.rect.width, this.pictogramData);
      this.place(t.view, slot.rect);
      t.setEnabled(options.enabled);
      t.show(i * 0.04);
      this.uiLayer.addChild(t.view);
      this.tokens.push(t);
    });
    if (this.confirm) this.uiLayer.addChild(this.confirm.view);
  }

  setChoiceState(state: ChoiceState): void {
    for (const t of this.tokens) {
      t.setEnabled(state.enabled || t.code === state.selected);
      t.setSelected(t.code === state.selected);
    }
    if (state.selected !== null) this.audio.playSfx('tap_soft', { volume: 0.6 });
    const c = this.confirm;
    if (!c) return;
    if (state.confirmVisible && state.selected !== null) {
      const token = this.tokens.find((t) => t.code === state.selected);
      const slot = token
        ? choiceSlots(
            this.geo,
            this.tokenKind ?? 'weigh',
            this.tokens.map((x) => x.code),
          ).find((s) => s.code === token.code)
        : null;
      if (slot) this.place(c.view, confirmAbove(this.geo, slot.rect));
      if (!c.view.visible) c.show();
    } else if (!state.confirmVisible) {
      c.hide();
    }
  }

  commitChoice(code: string | null): void {
    this.confirm?.hide();
    const token = code === null ? null : this.tokens.find((t) => t.code === code);
    if (token) {
      token.press();
      this.audio.playSfx('confirm', { volume: 0.8 });
      this.burst('dust', { x: token.view.x, y: token.view.y + 30 * this.geo.u }, 10);
    }
    const leaving = this.tokens;
    this.tokens = [];
    leaving.forEach((t, i) => {
      void t.hide(t === token ? 0.32 : 0.05 + i * 0.02).then(() => t.destroy());
    });
  }

  hideChoices(): void {
    this.confirm?.hide();
    for (const t of this.tokens) void t.hide().then(() => t.destroy());
    this.tokens = [];
  }

  setInspectVisible(visible: boolean, enabled: boolean): void {
    const c = this.inspect;
    if (!c) return;
    if (!visible) {
      c.hide();
      return;
    }
    c.setEnabled(enabled);
    if (!c.view.visible) c.show();
  }

  /* ============================================ fx ============================================== */

  private burst(kind: ParticleKind, at: { x: number; y: number }, count: number): void {
    const e = new PooledEmitter(
      { kind, origin: at, count },
      this.deps.cache,
      this.deps.ticker,
      this.deps.quality,
      this.geo.u,
    );
    this.fxLayer.addChild(e.view);
    this.bursts.add(e);
    gsap.delayedCall(3.2, () => {
      this.bursts.delete(e);
      e.destroy();
    });
  }

  /** A diagonal glint sweeping across the brass (cinematic highlight). */
  private brassGlint(delayS = 0): void {
    if (motionSettings.reducedMotion || !this.scale) return;
    const g = new Graphics();
    const h = this.geo.scaleHeight;
    g.moveTo(-40, -h)
      .lineTo(30, -h)
      .lineTo(-10, 0)
      .lineTo(-80, 0)
      .closePath()
      .fill({ color: 0xfff6d0, alpha: 0.3 });
    g.blendMode = 'add';
    // The sweep stays over the beam and pans (about +-200 u): wider, it crossed the guide and the
    // customer as a pale vertical bar.
    const sx = this.geo.scaleBase.x;
    g.position.set(sx - 200 * this.geo.u, this.geo.scaleBase.y);
    g.alpha = 0;
    this.fxLayer.addChild(g);
    const tl = gsap.timeline({ delay: delayS, onComplete: () => g.destroy() });
    tl.to(g, { alpha: 1, duration: 0.15 })
      .to(g, { x: sx + 220 * this.geo.u, duration: 0.9, ease: 'power2.inOut' }, '<')
      .to(g, { alpha: 0, duration: 0.25 }, '-=0.25');
  }

  /** Camera move (world only; never while choices are on screen). */
  private camera(
    zoom: number,
    focusX: number,
    focusY: number,
    durationS: number,
    ease = 'power2.inOut',
  ): void {
    const w = this.world;
    gsap.killTweensOf(w.scale);
    gsap.killTweensOf(w.pivot);
    gsap.killTweensOf(w);
    if (!this.deps.quality.cameraMoves || motionSettings.reducedMotion || durationS <= 0) {
      w.pivot.set(focusX, focusY);
      w.position.set(focusX, focusY);
      w.scale.set(zoom);
      return;
    }
    gsap.to(w.scale, { x: zoom, y: zoom, duration: durationS, ease });
    gsap.to(w.pivot, { x: focusX, y: focusY, duration: durationS, ease });
    gsap.to(w, { x: focusX, y: focusY, duration: durationS, ease });
    const parallax = (focusX / this.geo.width - 0.5) * 0.6;
    void this.backdrop?.panTo(parallax, durationS * 1000);
  }

  private cameraHome(durationS: number): void {
    this.camera(1, this.geo.width / 2, this.geo.height / 2, durationS);
  }

  /* ========================================== people ============================================ */

  private customerFor(variant: number): ProceduralCharacter {
    const idx = variant % CUSTOMERS.length;
    const existing = this.customers.get(idx);
    if (existing) return existing;
    const [look, cloth] = CUSTOMERS[idx] ?? [0, 0];
    const c = this.character(
      {
        id: `customer-${idx}`,
        role: 'customer',
        variant: look,
        view: 'three_quarter',
        facing: 'right',
        cloth,
      },
      this.geo.characterScale,
    );
    c.view.visible = false;
    this.charLayer.addChild(c.view);
    this.customers.set(idx, c);
    return c;
  }

  /** Walk a character to the counter spot from the market (left). */
  private stepUp(c: ProceduralCharacter, durationS: number): void {
    const g = this.geo;
    if (this.atCounter && this.atCounter !== c) this.stepAway(this.atCounter);
    this.atCounter = c;
    gsap.killTweensOf(c.view);
    c.view.visible = true;
    c.view.alpha = 1;
    c.clearLook();
    c.setExpression('neutral');
    const targetX = g.customer.x;
    if (motionSettings.reducedMotion) {
      c.view.position.set(targetX, g.customer.y);
      c.setView('three_quarter', true);
      return;
    }
    if (Math.abs(c.view.x - targetX) < 2 && c.view.y === g.customer.y) return;
    c.view.position.set(-g.width * 0.08, g.customer.y);
    c.setFacing('right');
    c.setLocomotion('walk');
    gsap.to(c.view, {
      x: targetX,
      duration: durationS,
      ease: 'power1.out',
      onComplete: () => {
        void c.stopLocomotion().then(() => c.setView('three_quarter'));
      },
    });
  }

  /** Send a character back into the market (walks left and fades into the crowd). */
  private stepAway(c: ProceduralCharacter): void {
    if (this.atCounter === c) this.atCounter = null;
    gsap.killTweensOf(c.view);
    if (motionSettings.reducedMotion) {
      gsap.to(c.view, {
        alpha: 0,
        duration: 0.25,
        onComplete: () => {
          c.view.visible = false;
        },
      });
      return;
    }
    c.setFacing('left');
    c.setLocomotion('walk');
    gsap.to(c.view, {
      x: c.view.x - this.geo.width * 0.32,
      alpha: 0,
      duration: 1.1,
      ease: 'power1.in',
      onComplete: () => {
        c.view.visible = false;
        void c.stopLocomotion();
        c.setFacing('right');
      },
    });
  }

  speaker(role: SpeakerRole | null): void {
    this.speaking?.stopSpeaking();
    this.speaking = null;
    if (role === null) return;
    const c =
      role === 'guide'
        ? this.guide
        : role === 'inspector'
          ? this.inspector
          : role === 'assistant'
            ? this.assistant
            : this.atCounter;
    if (!c?.view.visible) return;
    this.speaking = c;
    void c.speakFor(12_000);
  }

  /* ========================================= set pieces ========================================== */

  intro(): void {
    const g = this.geo;
    const u = g.u;
    // Open on the sky and the swaying lanterns, then tilt down onto the weighing post.
    this.camera(1.32, g.width * 0.5, g.height * 0.2, 0);
    // Picks up the light where the Stall's outro left it (2.16), see setProgress.
    void this.backdrop?.setTimeValue(2.08, 0);
    void this.backdrop?.setTimeValue(2.16, 3000);
    gsap.delayedCall(0.15, () => this.camera(1, g.width / 2, g.height / 2, 2.6, 'power3.inOut'));
    this.audio.playSfx('transition', { volume: 0.5 });
    this.burst('petals', { x: g.width * 0.3, y: -10 * u }, 18);
    this.brassGlint(2.3);
    this.scale?.setDialGlow(0.5);
    gsap.to(
      { v: 0 },
      { v: 1, duration: 2.5, delay: 2.4, onUpdate: () => this.scale?.setDialGlow(0) },
    );
    // The guide walks up to the counter, greets and introduces the work.
    const guide = this.guide;
    if (guide) {
      gsap.delayedCall(1.2, () => {
        this.stepUp(guide, 1.1);
        gsap.delayedCall(1.3, () => {
          guide.setExpression('happy');
          void guide.play('namaste');
        });
      });
    }
    const a = this.assistant;
    if (a) {
      gsap.delayedCall(2.9, () => {
        a.setExpression('happy');
        void a.play('wave');
      });
    }
    this.scale?.snap(0);
  }

  outro(): void {
    const g = this.geo;
    this.hideChoices();
    this.setInspectVisible(false, false);
    this.timeValue = 2.72;
    void this.backdrop?.setTimeValue(2.72, 2600);
    const guide = this.guide;
    if (guide) {
      if (this.atCounter !== guide) this.stepUp(guide, 0.7);
      guide.setExpression('delighted');
      gsap.delayedCall(0.5, () => void guide.play('namaste'));
    }
    this.assistant?.setExpression('happy');
    gsap.delayedCall(0.9, () => void this.assistant?.play('wave'));
    this.burst('petals', { x: g.width * 0.5, y: -10 * g.u }, 30);
    this.burst('sparkle', { x: g.scaleBase.x, y: g.scaleBase.y - g.scaleHeight * 0.7 }, 16);
    this.brassGlint(0.3);
    // The evening lamps come up: a warm bloom over the post and drifting sparks like fireflies.
    const bloom = new Graphics();
    bloom.circle(g.width / 2, g.height * 0.45, g.width * 0.42).fill(
      rgrad([
        [0, '#ffd27a55'],
        [0.5, '#ffb84d22'],
        [1, '#ffb84d00'],
      ]),
    );
    bloom.blendMode = 'add';
    bloom.alpha = 0;
    this.fxLayer.addChild(bloom);
    gsap.to(bloom, { alpha: 1, duration: 1.6, ease: 'sine.inOut' });
    for (let i = 0; i < 5; i++) {
      gsap.delayedCall(0.3 + i * 0.4, () => {
        if (this.destroyed) return;
        this.burst(
          'sparkle',
          {
            x: g.width * (0.15 + this.rnd.next() * 0.7),
            y: g.height * (0.25 + this.rnd.next() * 0.4),
          },
          6,
        );
      });
    }
    gsap.delayedCall(0.4, () => this.camera(1.06, g.width / 2, g.height * 0.47, 2.4, 'sine.inOut'));
  }

  practiceHint(expected: WeighDecision): void {
    const g = this.geo;
    this.placard?.highlight(true);
    const guide = this.guide;
    if (guide && this.placard) {
      void guide.pointAt(this.placard.view.getGlobalPosition());
    }
    // A soft hand hint above the matching stamp.
    const slot = choiceSlots(g, 'weigh', ['approve', 'warn', 'fine']).find(
      (s) => s.code === expected,
    );
    if (!slot) return;
    this.handHint?.destroy();
    const h = new Graphics();
    const s = g.u * 1.2;
    h.circle(0, 0, 46 * s).stroke({ width: 5 * s, color: 0xfff2b0, alpha: 0.9 });
    h.moveTo(-10 * s, 60 * s)
      .lineTo(-10 * s, 18 * s)
      .quadraticCurveTo(0, 8 * s, 10 * s, 18 * s)
      .lineTo(10 * s, 60 * s)
      .closePath()
      .fill(0xb57a50)
      .stroke({ width: 3 * s, color: 0x8d5a3b });
    h.position.set(slot.rect.x + slot.rect.width / 2, slot.rect.y - 20 * g.u);
    h.alpha = 0;
    this.uiLayer.addChild(h);
    this.handHint = h;
    gsap.to(h, { alpha: 1, duration: 0.3, delay: 0.6 });
    if (!motionSettings.reducedMotion)
      gsap.to(h, {
        y: h.y + 14 * g.u,
        duration: 0.55,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
        delay: 0.6,
      });
  }

  clearHints(): void {
    this.placard?.highlight(false);
    if (this.handHint) {
      gsap.killTweensOf(this.handHint);
      this.handHint.destroy();
      this.handHint = null;
    }
    void this.guide?.play('idle');
  }

  /* ========================================== weighing ========================================== */

  private stagedGoods(item: WeighItem): Container {
    const c = createGoods(item.good);
    c.label = `goods:${item.good}`;
    return c;
  }

  weighPrepare(trial: WeighTrial): void {
    const g = this.geo;
    this.pictogramData = {};
    this.clearPans();
    const person = trial.practice && this.guide ? this.guide : this.customerFor(trial.variant);
    this.stepUp(person, 0.62);
    // Declared quantity: brass weights stacked on the right pan by the assistant.
    const scale = this.scale;
    if (!scale) return;
    scale.level(400);
    const w = createWeightStack(trial.item.declaredWeight);
    this.weights = w;
    scale.rightLoad.addChild(w);
    w.alpha = motionSettings.reducedMotion ? 1 : 0;
    w.y = motionSettings.reducedMotion ? 0 : -60;
    gsap.to(w, { alpha: 1, y: 0, duration: 0.3, ease: 'back.out(2)' });
    this.audio.playSfx('pot_place', { volume: 0.35 });
    void this.assistant?.play('place_on_scale');
    // The goods arc from the market side towards the left pan.
    const goods = this.stagedGoods(trial.item);
    this.goods = goods;
    const local = scale.panPosition('l');
    const sc = scale.view.scale.x;
    const panGlobal = { x: g.scaleBase.x + local.x * sc, y: g.scaleBase.y + local.y * sc };
    goods.scale.set(sc);
    this.propLayer.addChild(goods);
    if (motionSettings.reducedMotion) {
      goods.position.set(panGlobal.x, panGlobal.y);
      goods.alpha = 0;
      return;
    }
    goods.position.set(g.customer.x + 40 * g.u, g.counterTop - 40 * g.u);
    goods.alpha = 1;
    gsap.to(goods, { x: panGlobal.x, duration: 0.5, delay: 0.18, ease: 'power1.inOut' });
    gsap.to(goods, { y: panGlobal.y - 160 * g.u, duration: 0.3, delay: 0.18, ease: 'power2.out' });
    gsap.to(goods, { y: panGlobal.y - 30 * g.u, duration: 0.2, delay: 0.48, ease: 'power2.in' });
  }

  weighReveal(trial: WeighTrial, settleMs: number): void {
    const scale = this.scale;
    const goods = this.goods;
    if (!scale || !goods) return;
    // Land the goods in the pan on this frame and start the beam swing.
    gsap.killTweensOf(goods);
    goods.removeFromParent();
    goods.position.set(0, 0);
    goods.scale.set(1);
    goods.alpha = 1;
    scale.leftLoad.addChild(goods);
    if (!motionSettings.reducedMotion) {
      goods.scale.set(1.12, 0.84);
      gsap.to(goods.scale, { x: 1, y: 1, duration: 0.35, ease: 'elastic.out(1, 0.45)' });
    }
    scale.weigh(
      discrepancyTicks(trial.item),
      settleMs,
      trial.item.ambiguous,
      motionSettings.reducedMotion ? 0 : -0.6,
    );
    this.audio.playSfx('pot_place', { volume: 0.7 });
    const p = scale.panPosition('l');
    const sc = scale.view.scale.x;
    this.burst(
      'dust',
      { x: this.geo.scaleBase.x + p.x * sc, y: this.geo.scaleBase.y + p.y * sc },
      12,
    );
    scale.setDialGlow(0.35);
    const person = this.atCounter;
    person?.lookAt({
      x: this.geo.scaleBase.x,
      y: this.geo.scaleBase.y - this.geo.scaleHeight * 0.6,
    });
    this.assistant?.lookAt({
      x: this.geo.scaleBase.x,
      y: this.geo.scaleBase.y - this.geo.scaleHeight * 0.6,
    });
  }

  reweigh(item: WeighItem, settleMs: number, steady: boolean): void {
    const scale = this.scale;
    const goods = this.goods;
    if (!scale) return;
    scale.level(260);
    this.audio.playSfx('whoosh', { volume: 0.3 });
    void this.assistant?.play('place_on_scale');
    if (goods && !motionSettings.reducedMotion) {
      gsap.killTweensOf(goods);
      gsap.to(goods, { y: -46, duration: 0.16, ease: 'power2.out', yoyo: true, repeat: 1 });
    }
    gsap.delayedCall(0.32, () => {
      if (this.destroyed) return;
      scale.weigh(
        discrepancyTicks(item),
        settleMs,
        item.ambiguous && !steady,
        motionSettings.reducedMotion ? 0 : -0.4,
      );
      if (steady) scale.steady(settleMs);
      this.audio.playSfx('pot_place', { volume: 0.5 });
    });
  }

  weighOutcome(_trial: WeighTrial, decision: WeighDecision | null): void {
    const person = this.atCounter;
    this.scale?.setDialGlow(0);
    if (person) {
      person.clearLook();
      // Reactions depend only on the stamp chosen, never on whether it matched the rule.
      if (decision === 'approve') {
        person.setExpression('happy');
        void person.play('namaste');
      } else if (decision === 'warn') {
        person.react('surprised', 0.5);
        void person.play('nod');
      } else if (decision === 'fine') {
        person.react('annoyed', 0.7);
        void person.play('shrug');
        this.coinsTo(person, 1, this.set?.cashBox ?? { x: 0, y: 0 }, 0.25);
      } else {
        person.setExpression('thinking');
        void person.play('shrug');
      }
    }
    this.assistant?.clearLook();
    // Hand the goods back and clear the pans.
    const goods = this.goods;
    const weights = this.weights;
    this.goods = null;
    this.weights = null;
    gsap.delayedCall(0.28, () => {
      if (this.destroyed) return;
      this.scale?.level(500);
      for (const o of [goods, weights]) {
        if (!o || o.destroyed) continue;
        gsap.to(o, {
          alpha: 0,
          y: o.y - 40,
          duration: 0.25,
          onComplete: () => {
            if (!o.destroyed) o.destroy({ children: true });
          },
        });
      }
      if (person && person !== this.guide) gsap.delayedCall(0.35, () => this.stepAway(person));
    });
  }

  private clearPans(): void {
    for (const o of [this.goods, this.weights]) {
      if (o && !o.destroyed) {
        killTweensDeep(o);
        o.destroy({ children: true });
      }
    }
    this.goods = null;
    this.weights = null;
    if (this.scale) {
      for (const ch of [
        ...this.scale.leftLoad.removeChildren(),
        ...this.scale.rightLoad.removeChildren(),
      ]) {
        killTweensDeep(ch);
        ch.destroy({ children: true });
      }
    }
  }

  /** Coins fly from a character (or point) to a target (cash box, back to them). */
  private coinsTo(
    from: ProceduralCharacter | { x: number; y: number },
    n: number,
    to: { x: number; y: number },
    delayS = 0,
  ): void {
    const g = this.geo;
    const start = 'view' in from ? { x: from.view.x + 30 * g.u, y: g.counterTop - 60 * g.u } : from;
    for (let i = 0; i < n; i++) {
      const c = createCoinStack(1, 2.2 * g.u);
      c.position.set(start.x, start.y);
      this.propLayer.addChild(c);
      if (motionSettings.reducedMotion) {
        c.destroy();
        continue;
      }
      const d = delayS + i * 0.07;
      gsap.to(c, { x: to.x, duration: 0.55, delay: d, ease: 'power1.inOut' });
      gsap.to(c, {
        y: Math.min(start.y, to.y) - 90 * g.u,
        duration: 0.27,
        delay: d,
        ease: 'power2.out',
      });
      gsap.to(c, {
        y: to.y,
        duration: 0.28,
        delay: d + 0.27,
        ease: 'power2.in',
        onComplete: () => {
          this.audio.playSfx('coin_drop', { volume: 0.5 });
          c.destroy();
        },
      });
    }
  }

  /* ========================================== dilemmas ========================================== */

  private clearDilemmaProps(): void {
    for (const p of this.dilemmaProps) {
      if (p.destroyed) continue;
      killTweensDeep(p);
      p.destroy({ children: true });
    }
    this.dilemmaProps = [];
  }

  private prop(c: Container): Container {
    this.propLayer.addChild(c);
    this.dilemmaProps.push(c);
    return c;
  }

  dilemmaPrepare(trial: DilemmaTrial): void {
    const g = this.geo;
    const u = g.u;
    this.clearDilemmaProps();
    this.clearPans();
    this.pictogramData = { coins: trial.coins ?? 1 };
    const scale = this.scale;
    switch (trial.kind) {
      case 'bribe': {
        // A trader in a fine vest sets down a sack that sits light on the scale.
        const trader = this.customerFor(6 + (trial.variant % 2) * 2);
        this.stepUp(trader, 0.6);
        if (scale) {
          const w = createWeightStack(6);
          this.weights = w;
          scale.rightLoad.addChild(w);
          const sack = createGoods('rice_sack');
          this.goods = sack;
          scale.leftLoad.addChild(sack);
          scale.weigh(2, 900, false, -0.4);
        }
        gsap.delayedCall(0.4, () => {
          trader.setExpression('pleased');
          void trader.play('hand_over');
        });
        // The coins slide across the counter towards the weighmaster (they come to rest at the reveal).
        const stack = this.prop(createCoinStack(trial.coins ?? 1, 4.2 * u));
        stack.label = 'bribe-coins';
        stack.position.set(g.customer.x + 70 * u, g.counterTop + 18 * u);
        stack.alpha = 0;
        if (!motionSettings.reducedMotion) {
          gsap.to(stack, { alpha: 1, duration: 0.15, delay: 0.55 });
          gsap.to(stack, { x: g.width * 0.37, duration: 0.55, delay: 0.6, ease: 'power2.out' });
        }
        break;
      }
      case 'overpayment': {
        const elder = this.customerFor(5);
        this.stepUp(elder, 0.6);
        gsap.delayedCall(0.6, () => {
          elder.setExpression('calm');
          void elder.play('hand_over');
        });
        break;
      }
      case 'assistant_mistake': {
        // The farmer returns: the sack the assistant weighed earlier was short.
        const farmer = this.customerFor(trial.variant + 1);
        this.stepUp(farmer, 0.6);
        gsap.delayedCall(0.6, () => {
          farmer.react('annoyed', 1.4);
        });
        break;
      }
      case 'fraud_found': {
        const trader = this.customerFor(6);
        this.stepUp(trader, 0.6);
        if (scale) {
          const sack = createGoods('potato_sack');
          this.goods = sack;
          scale.leftLoad.addChild(sack);
          const w = createWeightStack(7);
          this.weights = w;
          scale.rightLoad.addChild(w);
          scale.weigh(0, 800, false, -0.3);
        }
        gsap.delayedCall(0.4, () => {
          this.assistant?.lookAt({
            x: g.scaleBase.x - 200 * u,
            y: g.scaleBase.y - g.scaleHeight * 0.35,
          });
          void this.assistant?.play('receive');
        });
        break;
      }
      default:
        break;
    }
  }

  dilemmaReveal(trial: DilemmaTrial): void {
    const g = this.geo;
    const u = g.u;
    const ledge = { x: g.width * 0.5, y: g.counterTop - 8 * u };
    switch (trial.kind) {
      case 'bribe': {
        // Coins slid across the counter: the offer, pictured (size = number of coins).
        const stack =
          this.dilemmaProps.find((p) => p.label === 'bribe-coins') ??
          this.prop(createCoinStack(trial.coins ?? 1, 4.2 * u));
        gsap.killTweensOf(stack);
        stack.alpha = 1;
        stack.position.set(g.width * 0.37, g.counterTop + 18 * u);
        this.burst('sparkle', { x: stack.x, y: stack.y - 20 * u }, 8);
        this.audio.playSfx('coin_drop', { volume: 0.6 });
        break;
      }
      case 'overpayment': {
        // A brass plate: the due coins fill the outlines; the extra coins lie beside them, gleaming.
        const plate = this.prop(new Container());
        const p = new Graphics();
        p.ellipse(0, 0, 165 * u, 34 * u)
          .fill(0x6e3f22)
          .stroke({ width: 4 * u, color: MELA.brass });
        const due = 2;
        for (let i = 0; i < due; i++)
          p.circle((i - 1.5) * 40 * u, -4 * u, 15 * u).stroke({
            width: 2.5 * u,
            color: MELA.ink,
            alpha: 0.5,
          });
        plate.addChild(p);
        const dueCoins = createCoinStack(1, 3.8 * u);
        dueCoins.position.set(-84 * u, 6 * u);
        const due2 = createCoinStack(1, 3.8 * u);
        due2.position.set(-28 * u, 6 * u);
        const glow = new Graphics();
        glow.ellipse(0, -8 * u, 62 * u, 26 * u).fill({ color: 0xfff2b0, alpha: 0.45 });
        glow.position.set(84 * u, 4 * u);
        glow.blendMode = 'add';
        const extra = createCoinPile(trial.coins ?? 1, 3.8 * u, 5);
        extra.position.set(84 * u, 8 * u);
        plate.addChild(dueCoins, due2, glow, extra);
        plate.position.set(g.width * 0.36, ledge.y + 18 * u);
        this.burst('sparkle', { x: plate.x + 70 * u, y: plate.y - 16 * u }, 10);
        this.audio.playSfx('coin_drop', { volume: 0.6 });
        break;
      }
      case 'assistant_mistake': {
        // A brass weight toppled off the pan: the assistant's slip, pictured.
        const w = this.prop(new Container());
        const gg = new Graphics();
        drawBrassWeight(gg, 0, 0, 3.4 * u);
        w.addChild(gg);
        w.rotation = Math.PI / 2;
        w.position.set(g.scaleBase.x + 130 * u, g.counterTop + 6 * u);
        this.burst('dust', { x: w.x, y: w.y }, 10);
        this.assistant?.react('surprised', 1.2);
        void this.atCounter?.play('point');
        this.audio.playSfx('pot_place', { volume: 0.6 });
        break;
      }
      case 'fraud_found': {
        // The assistant pulls a stone out of the sack: the hidden fraud.
        const stone = this.prop(createStone(2.4 * u));
        stone.position.set(g.scaleBase.x - 120 * u, g.counterTop - 30 * u);
        this.burst('sparkle', { x: stone.x, y: stone.y - 30 * u }, 12);
        this.assistant?.setExpression('delighted');
        void this.assistant?.play('celebrate');
        this.atCounter?.react('surprised', 1.4);
        // The reward garland the elders offer.
        const garland = this.prop(createGarland(1.6 * u));
        garland.position.set(
          g.width * (g.portrait ? 0.72 : 0.64),
          g.height * (g.portrait ? 0.43 : 0.5),
        );
        if (!motionSettings.reducedMotion)
          gsap.to(garland, {
            y: garland.y + 10 * u,
            duration: 1.2,
            yoyo: true,
            repeat: -1,
            ease: 'sine.inOut',
          });
        this.audio.playSfx('chime', { volume: 0.5 });
        break;
      }
      default:
        break;
    }
  }

  dilemmaOutcome(trial: DilemmaTrial, code: string | null): void {
    const g = this.geo;
    const person = this.atCounter;
    const cash = this.set?.cashBox ?? { x: g.width * 0.9, y: g.counterTop };
    const props = [...this.dilemmaProps];
    switch (trial.kind) {
      case 'bribe': {
        const stack = props[0];
        if (stack && code === 'accept') {
          this.fly(stack, cash, 0.5);
          person?.setExpression('pleased');
          void person?.play('nod');
        } else if (stack && code === 'decline') {
          this.fly(stack, { x: g.customer.x, y: g.counterTop - 40 * g.u }, 0.45);
          person?.react('surprised', 0.6);
          void person?.play('shrug');
        }
        break;
      }
      case 'overpayment': {
        const plate = props[0];
        if (plate && code === 'return') {
          const extra = plate.children[plate.children.length - 1];
          if (extra)
            this.fly(extra as Container, { x: g.customer.x - plate.x, y: -30 * g.u }, 0.45);
          person?.setExpression('happy');
          void person?.play('namaste');
        } else if (plate && code === 'keep') {
          this.fly(plate, cash, 0.5);
          void person?.play('wave');
        }
        break;
      }
      case 'assistant_mistake': {
        const a = this.assistant;
        if (code === 'self') {
          a?.setExpression('pleased');
          void a?.play('nod');
        } else if (code === 'assistant') {
          a?.react('surprised', 0.5);
          void a?.play('nod');
        } else if (code === 'shared') {
          a?.setExpression('happy');
          void a?.play('nod');
        } else if (code === 'chance') {
          this.burst('leaves', { x: g.width * 0.2, y: g.height * 0.4 }, 16);
          void a?.play('shrug');
        }
        person?.setExpression('calm');
        void person?.play('nod');
        break;
      }
      case 'fraud_found': {
        const garland = props.find((p) => p.label !== 'stone') ?? props[1];
        const a = this.assistant;
        if (garland && code === 'assistant' && a) {
          gsap.killTweensOf(garland);
          this.fly(garland, { x: a.view.x, y: a.view.y - 300 * this.geo.characterScale }, 0.55);
          a.setExpression('delighted');
          void a.play('namaste');
        } else if (garland && code === 'self') {
          gsap.killTweensOf(garland);
          this.fly(garland, { x: g.width * 0.5, y: g.height * 0.95 }, 0.55);
          void a?.play('clap');
        } else if (garland && code === 'shared' && a) {
          gsap.killTweensOf(garland);
          const half = this.prop(createGarland(1.6 * g.u, true));
          half.position.set(garland.x, garland.y);
          this.fly(garland, { x: g.width * 0.5, y: g.height * 0.95 }, 0.55);
          this.fly(half, { x: a.view.x, y: a.view.y - 300 * this.geo.characterScale }, 0.55);
          a.setExpression('happy');
          void a.play('nod');
        }
        person?.setExpression('neutral');
        if (code !== null) this.audio.playSfx('whoosh', { volume: 0.4 });
        break;
      }
      default:
        break;
    }
    gsap.delayedCall(0.55, () => {
      if (this.destroyed) return;
      this.scale?.level(500);
      for (const o of [this.goods, this.weights])
        if (o && !o.destroyed) gsap.to(o, { alpha: 0, duration: 0.25 });
      gsap.delayedCall(0.3, () => {
        this.clearPans();
        this.clearDilemmaProps();
      });
      if (person && person !== this.guide) this.stepAway(person);
    });
  }

  /** Move a display object to a stage point with a little arc, then fade. */
  private fly(o: Container, to: { x: number; y: number }, durationS: number): void {
    gsap.killTweensOf(o);
    if (motionSettings.reducedMotion) {
      gsap.to(o, { alpha: 0, duration: 0.2 });
      return;
    }
    const parent = o.parent;
    const target = parent ? parent.toLocal(to) : to;
    gsap.to(o, { x: target.x, duration: durationS, ease: 'power1.inOut' });
    gsap.to(o, {
      y: Math.min(o.y, target.y) - 70 * this.geo.u,
      duration: durationS * 0.45,
      ease: 'power2.out',
    });
    gsap.to(o, {
      y: target.y,
      duration: durationS * 0.55,
      delay: durationS * 0.45,
      ease: 'power2.in',
    });
    gsap.to(o, { alpha: 0, duration: 0.2, delay: durationS + 0.1 });
    this.audio.playSfx('coin_drop', { volume: 0.45 });
  }

  /* =========================================== gamble =========================================== */

  gamblePrepare(trial: GambleTrial): void {
    this.clearDilemmaProps();
    this.clearPans();
    this.pictogramData = { safeCoins: trial.safeCoins, winCoins: trial.winCoins };
    const trader = this.customerFor(trial.variant + 3);
    this.stepUp(trader, 0.6);
    gsap.delayedCall(0.6, () => void trader.play('beckon'));
  }

  gambleReveal(trial: GambleTrial): void {
    const g = this.geo;
    const u = g.u;
    // Three tied sacks wait on the counter's back edge.
    for (let i = 0; i < 3; i++) {
      const s = this.prop(createGoods(i === 1 ? 'potato_sack' : 'rice_sack'));
      s.scale.set((0.78 * g.scaleHeight) / 620);
      s.position.set(g.width * (g.portrait ? 0.3 : 0.33) + i * 70 * u, g.counterTop + 4 * u);
      s.label = `gamble-sack-${i}`;
    }
    void trial;
    this.audio.playSfx('pot_place', { volume: 0.5 });
  }

  gambleOutcome(trial: GambleTrial, code: 'gamble' | 'inspect' | null, caught: boolean): void {
    const g = this.geo;
    const u = g.u;
    const sacks = [...this.dilemmaProps];
    const cash = this.set?.cashBox ?? { x: g.width * 0.9, y: g.counterTop };
    const person = this.atCounter;
    if (code === 'inspect') {
      void this.assistant?.play('receive');
      sacks.forEach((s, i) => {
        if (!motionSettings.reducedMotion)
          gsap.to(s, { y: s.y - 20 * u, duration: 0.12, delay: i * 0.18, yoyo: true, repeat: 1 });
      });
      this.coinsTo({ x: g.width * 0.38, y: g.counterTop - 30 * u }, trial.safeCoins, cash, 0.55);
      person?.setExpression('calm');
      void person?.play('nod');
    } else if (code === 'gamble') {
      const pick = sacks[this.rnd.int(0, Math.max(0, sacks.length - 1))];
      if (pick && !motionSettings.reducedMotion)
        gsap.to(pick, { y: pick.y - 36 * u, duration: 0.2, yoyo: true, repeat: 1 });
      if (caught) {
        const stone = this.prop(createStone(2 * u));
        stone.position.set((pick?.x ?? g.width * 0.4) + 10 * u, g.counterTop - 50 * u);
        this.burst('dust', { x: stone.x, y: stone.y }, 10);
        person?.react('surprised', 0.8);
        void person?.play('shrug');
      } else {
        this.burst('sparkle', { x: pick?.x ?? g.width * 0.4, y: g.counterTop - 60 * u }, 14);
        this.coinsTo(
          { x: pick?.x ?? g.width * 0.4, y: g.counterTop - 40 * u },
          trial.winCoins,
          cash,
          0.35,
        );
        person?.setExpression('happy');
        void person?.play('nod');
      }
    }
    gsap.delayedCall(0.75, () => {
      if (this.destroyed) return;
      this.clearDilemmaProps();
      if (person && person !== this.guide) this.stepAway(person);
    });
  }

  /* ============================================ luck ============================================ */

  luckBegin(): void {
    this.clearPans();
    this.scale?.level(300);
    const guide = this.guide;
    if (guide) {
      this.stepUp(guide, 0.6);
      gsap.delayedCall(0.55, () => {
        guide.setExpression('pleased');
        void guide.play('hand_over');
      });
    }
    // The scale steps back into soft focus while the screen rises.
    if (this.scale) gsap.to(this.scale.view, { alpha: 0.35, duration: 0.5 });
    this.luck?.raise();
    this.audio.playSfx('whoosh', { volume: 0.35 });
  }

  luckRoll(): void {
    this.pictogramData = {};
    this.luck?.roll(700);
    this.audio.playSfx('dice_shake', { volume: 0.7 });
  }

  luckShowFace(face: number): void {
    this.luck?.showFace(face);
  }

  luckOutcome(reported: number | null): void {
    if (reported !== null) {
      this.luck?.award(reported);
      this.audio.playSfx('chime', { volume: 0.35 });
    }
  }

  luckClear(): void {
    this.luck?.clear();
  }

  luckEnd(): void {
    this.luck?.lower();
    if (this.scale) gsap.to(this.scale.view, { alpha: 1, duration: 0.5, delay: 0.2 });
    const guide = this.guide;
    if (guide) {
      void guide.play('namaste');
      gsap.delayedCall(0.4, () => this.stepAway(guide));
    }
  }

  /* ========================================== new rule ========================================== */

  newRuleAnnounce(rule: WeighRule): void {
    const g = this.geo;
    this.clearPans();
    if (!this.inspector) {
      this.inspector = this.character(
        { id: 'inspector', role: 'inspector', variant: 0, view: 'three_quarter', facing: 'right' },
        g.characterScale,
      );
      this.inspector.view.visible = false;
      this.charLayer.addChild(this.inspector.view);
    }
    const insp = this.inspector;
    this.stepUp(insp, 0.75);
    // Bell, then the announcement; the camera leans towards the placard as it turns over.
    this.audio.playSfx('bell', { volume: 0.8 });
    gsap.delayedCall(0.5, () => this.audio.playSfx('bell', { volume: 0.6 }));
    gsap.delayedCall(0.8, () => {
      insp.setExpression('calm');
      void insp.play('wave');
    });
    const p = this.placard;
    if (p) {
      const pos = p.view.position;
      gsap.delayedCall(0.6, () =>
        this.camera(1.12, (pos.x + g.width / 2) / 2, (pos.y + g.height / 2) / 2, 1.2),
      );
      gsap.delayedCall(1.4, () => {
        if (p.view.destroyed) return;
        p.turnTo(rule);
        this.audio.playSfx('card_flip', { volume: 0.7 });
        this.burst('sparkle', { x: pos.x, y: pos.y }, 18);
        void insp.pointAt(p.view.getGlobalPosition());
      });
    }
    this.assistant?.setExpression('thinking');
  }

  newRuleDone(): void {
    this.cameraHome(0.45);
    const insp = this.inspector;
    if (insp) {
      void insp.play('idle');
      insp.setExpression('pleased');
      gsap.delayedCall(0.2, () => this.stepAway(insp));
    }
    this.assistant?.setExpression('neutral');
  }

  /* ============================================ probe =========================================== */

  probeBegin(): void {
    this.clearPans();
    const guide = this.guide;
    if (guide) {
      this.stepUp(guide, 0.6);
      gsap.delayedCall(0.5, () => {
        guide.setExpression('happy');
        void guide.play('beckon');
      });
    }
  }

  probePrepare(trial: ProbeTrial): void {
    this.pictogramData = {
      safeItems: trial.situation.safeItems,
      riskyItems: trial.situation.riskyItems,
    };
  }

  probeReveal(): void {
    this.audio.playSfx('pop', { volume: 0.4 });
  }

  probeOutcome(): void {
    void this.guide?.play('nod');
  }

  probeEnd(): void {
    this.guide?.setExpression('pleased');
  }
}

/** Scene factory for the episode (renders when the app has a renderer, else headless). */
export function pixiSceneFactory(options: PixiSceneOptions = {}) {
  return (ctx: ModuleContext): WeighingScene => new PixiWeighingScene(ctx, options);
}
