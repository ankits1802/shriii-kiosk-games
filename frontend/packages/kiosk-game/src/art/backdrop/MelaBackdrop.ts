/**
 * The animated, layered parallax backdrop of the golden-hour mela.
 *
 * Layers (far -> near): sky gradient, stars, sun halo + disc, sun rays, drifting clouds, three hill ridges
 * with atmospheric haze, temple and distant props, ground and path, mid props (trees, stalls), bunting and
 * string lights, near props, foreground framing (toran, diyas). Every depth layer has an `art` container
 * (tinted by the time-of-day light) and an additive `glow` container (lamps, bulbs, windows) whose
 * intensity follows the palette's `lights` value, so string lights and diyas switch on as the day ends.
 *
 * Time of day is continuous (0 morning .. 3 dusk) and tweened; the palette drives sky, hills, ground,
 * tints, glows, godrays, dust, stars and fireflies. Ambient life: cloud drift, canopy sway, bunting
 * flutter, flag wave, flame flicker, giant-wheel rotation, dust motes, drifting petals, fireflies, birds.
 */
import { gsap } from 'gsap';
import { Container, Graphics, Sprite, type Ticker } from 'pixi.js';
import type { Backdrop, SceneId, TimeOfDay } from '../../core/contracts.ts';
import { clamp, lighten, mixColor } from '../color.ts';
import { rgba, rgrad, vgrad } from '../draw.ts';
import { FX_RADIUS, fxTexture } from '../fx/textures.ts';
import type { Lighting } from '../lighting.ts';
import { type ScenePalette, scenePaletteAt, timeValueOf } from '../palettes.ts';
import type { QualityProfile } from '../quality.ts';
import { ArtRandom } from '../rand.ts';
import type { TextureCache } from '../textures.ts';
import { drawBird, drawCloud, drawStar, fillRidge, ridgePoints } from './nature.ts';
import { buildScene, SCENE_RECIPES, type SceneBuildContext } from './scenes.ts';

/** Services the backdrop needs from the art kit. */
export interface BackdropDeps {
  readonly cache: TextureCache;
  readonly quality: QualityProfile;
  readonly lighting: Lighting;
  readonly ticker: Ticker;
}

/** A depth layer with its parallax factor. */
export interface DepthLayer {
  readonly root: Container;
  readonly art: Container;
  readonly glow: Container;
  readonly factor: number;
  /** 0 = at the horizon (hazy), 1 = foreground (no haze). */
  readonly depth: number;
}

/** A light glow sprite with its switch-on threshold (0..1 of the palette lights value). */
export interface GlowLight {
  readonly sprite: Sprite;
  readonly threshold: number;
  readonly baseAlpha: number;
  readonly flicker: number;
  readonly phase: number;
}

/** Per-frame animators registered by scene recipes. */
export type Animator = (timeS: number, dtS: number, palette: ScenePalette) => void;

interface Mote {
  sprite: Sprite;
  kind: 'dust' | 'petal' | 'firefly';
  vx: number;
  vy: number;
  phase: number;
  spin: number;
  life: number;
}

interface Bird {
  view: Container;
  up: Sprite;
  down: Sprite;
  vx: number;
  phase: number;
}

const DEFAULT_TRANSITION_MS = 2400;

export class MelaBackdrop implements Backdrop {
  readonly view = new Container();
  readonly sceneId: SceneId;

  private readonly deps: BackdropDeps;
  private width: number;
  private height: number;
  private time: number;
  private palette: ScenePalette;
  private parallax = 0;
  private parallaxTarget = 0;
  private elapsed = 0;
  private destroyed = false;
  private timeTween: gsap.core.Tween | null = null;
  private panTween: gsap.core.Tween | null = null;

  // Layers.
  private readonly world = new Container();
  private readonly sky = new Graphics();
  private readonly stars = new Container();
  private readonly sunLayer = new Container();
  private readonly rays = new Container();
  private readonly clouds = new Container();
  private readonly hillFar = new Graphics();
  private readonly hillMid = new Graphics();
  private readonly hillNear = new Graphics();
  private readonly ground = new Graphics();
  private readonly particleLayer = new Container();
  private readonly birdLayer = new Container();
  private readonly vignette = new Graphics();
  private readonly sunWash = new Graphics();
  private readonly groundDetail = new Container();
  private readonly layers = new Map<string, DepthLayer>();
  private readonly glows: GlowLight[] = [];
  private readonly animators: Animator[] = [];
  private readonly tintTargets: { container: Container; depth: number }[] = [];
  private cloudSprites: { body: Container; lit: Container; speed: number; root: Container }[] = [];
  private starSprites: { sprite: Container; phase: number }[] = [];
  private sunHalo: Sprite | null = null;
  private sunDisc: Sprite | null = null;
  private sunCore: Sprite | null = null;
  private motes: Mote[] = [];
  private birds: Bird[] = [];
  private nextBirdAt = 4;
  private horizonY = 0;
  private margin = 0;
  private ridgeCache: {
    far: { x: number; y: number }[];
    mid: { x: number; y: number }[];
    near: { x: number; y: number }[];
  } | null = null;
  private readonly onTick = (ticker: Ticker): void => this.update(ticker.deltaMS / 1000);

  constructor(
    sceneId: SceneId,
    timeOfDay: TimeOfDay,
    width: number,
    height: number,
    deps: BackdropDeps,
  ) {
    this.sceneId = sceneId;
    this.deps = deps;
    this.width = width;
    this.height = height;
    this.time = timeValueOf(timeOfDay);
    this.palette = scenePaletteAt(this.time);
    this.view.label = `backdrop:${sceneId}`;
    this.view.eventMode = 'none';
    this.sunWash.blendMode = 'add';
    this.view.addChild(this.world, this.sunWash, this.vignette);
    this.build();
    this.applyPalette(this.palette);
    deps.ticker.add(this.onTick);
  }

  /** Current continuous time value (0 morning .. 3 dusk). */
  get timeValue(): number {
    return this.time;
  }

  /** Current interpolated palette. */
  get currentPalette(): ScenePalette {
    return this.palette;
  }

  setTimeOfDay(
    timeOfDay: TimeOfDay,
    options: { readonly durationMs?: number } = {},
  ): Promise<void> {
    return this.setTimeValue(timeValueOf(timeOfDay), options.durationMs ?? DEFAULT_TRANSITION_MS);
  }

  /** Animate to an arbitrary continuous time value (e.g. 2.5 = sunset). */
  setTimeValue(target: number, durationMs = DEFAULT_TRANSITION_MS): Promise<void> {
    this.timeTween?.kill();
    const to = clamp(target, 0, 3);
    if (durationMs <= 0 || this.destroyed) {
      this.time = to;
      this.applyPalette(scenePaletteAt(to));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const state = { t: this.time };
      this.timeTween = gsap.to(state, {
        t: to,
        duration: durationMs / 1000,
        ease: 'sine.inOut',
        onUpdate: () => {
          this.time = state.t;
          if (!this.destroyed) this.applyPalette(scenePaletteAt(state.t));
        },
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
    });
  }

  setParallax(offset: number): void {
    this.parallaxTarget = clamp(offset, -1, 1);
    if (!this.deps.quality.cameraMoves) this.parallax = this.parallaxTarget;
  }

  /** Cinematic camera pan across the fair (GSAP, eased); instant under reduced motion. */
  panTo(offset: number, durationMs = 1800): Promise<void> {
    const to = clamp(offset, -1, 1);
    if (!this.deps.quality.cameraMoves || durationMs <= 0) {
      this.parallax = this.parallaxTarget = to;
      this.layoutParallax();
      return Promise.resolve();
    }
    this.panTween?.kill();
    return new Promise((resolve) => {
      const s = { p: this.parallax };
      this.panTween = gsap.to(s, {
        p: to,
        duration: durationMs / 1000,
        ease: 'power2.inOut',
        onUpdate: () => {
          if (this.destroyed) return;
          this.parallax = this.parallaxTarget = s.p;
          this.layoutParallax();
        },
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
    });
  }

  /** Rebuild for a new stage size. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.teardownContent();
    this.build();
    this.applyPalette(this.palette);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.timeTween?.kill();
    this.panTween?.kill();
    this.deps.ticker.remove(this.onTick);
    gsap.killTweensOf(this);
    this.view.destroy({ children: true });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private teardownContent(): void {
    for (const l of this.layers.values()) l.root.destroy({ children: true });
    this.layers.clear();
    this.glows.length = 0;
    this.animators.length = 0;
    this.tintTargets.length = 0;
    this.cloudSprites = [];
    this.starSprites = [];
    this.motes = [];
    this.birds = [];
    this.ridgeCache = null;
    for (const c of [
      this.stars,
      this.sunLayer,
      this.rays,
      this.clouds,
      this.particleLayer,
      this.birdLayer,
      this.groundDetail,
    ]) {
      for (const child of c.removeChildren()) child.destroy({ children: true });
    }
    this.world.removeChildren();
  }

  private build(): void {
    const W = this.width;
    const H = this.height;
    const recipe = SCENE_RECIPES[this.sceneId];
    const portrait = H > W;
    this.horizonY = Math.round(H * (portrait ? recipe.horizonPortrait : recipe.horizon));
    this.margin = Math.round(W * 0.09);
    const u = Math.min(W, H) / 1080;
    const q = this.deps.quality;

    this.world.addChild(this.sky, this.stars, this.sunLayer, this.rays, this.clouds);

    // Stars.
    const rnd = new ArtRandom(`stars:${this.sceneId}`);
    const starTex = this.deps.cache.bake('star', () => drawStar(2));
    starTex.destroy();
    for (let i = 0; i < 70; i++) {
      const s = this.deps.cache.bake('star', () => drawStar(2));
      s.position.set(
        rnd.range(-this.margin, W + this.margin),
        rnd.range(0, this.horizonY * 0.8) ** 1 * rnd.range(0.4, 1),
      );
      s.scale.set(rnd.range(0.4, 1.2) * u);
      this.stars.addChild(s);
      this.starSprites.push({ sprite: s, phase: rnd.range(0, Math.PI * 2) });
    }

    // Sun: halo, disc and a hot core, all baked once and tinted.
    const glowTex = fxTexture(this.deps.cache, 'glow');
    this.sunHalo = new Sprite(glowTex);
    this.sunHalo.anchor.set(0.5);
    this.sunHalo.blendMode = 'add';
    this.sunDisc = new Sprite(fxTexture(this.deps.cache, 'disc'));
    this.sunDisc.anchor.set(0.5);
    this.sunCore = new Sprite(glowTex);
    this.sunCore.anchor.set(0.5);
    this.sunCore.blendMode = 'add';
    this.sunLayer.addChild(this.sunHalo, this.sunDisc, this.sunCore);

    // Sun rays: a soft fan of beams (medium+ tiers).
    if (q.softShadows) {
      const fan = this.deps.cache.bake(
        `rays:${Math.round(H)}`,
        () => {
          // Each beam is stacked from nested triangles so brightness falls off with distance.
          const g = new Graphics();
          const len = H * 1.1;
          const beams = 11;
          for (let i = 0; i < beams; i++) {
            const a = (i / beams) * Math.PI * 2 + (i % 2) * 0.05;
            const w = 0.06 + (i % 3) * 0.03;
            for (let k = 1; k <= 6; k++) {
              const l = len * (k / 6);
              g.moveTo(0, 0)
                .lineTo(Math.cos(a - w) * l, Math.sin(a - w) * l)
                .lineTo(Math.cos(a + w) * l, Math.sin(a + w) * l)
                .closePath()
                .fill({ color: 0xffffff, alpha: 0.11 });
            }
          }
          return g;
        },
        { blur: 18 * u },
      );
      fan.alpha = 0.3;
      this.rays.addChild(fan);
      this.rays.blendMode = 'add';
    }

    // Clouds.
    const cr = new ArtRandom(`clouds:${this.sceneId}`);
    const cloudCount = portrait ? 7 : 6;
    for (let i = 0; i < cloudCount; i++) {
      const cw = cr.range(260, 520) * u;
      const seed = cr.int(1, 1e6);
      const parts = drawCloud(cw, seed);
      const body = this.deps.cache.bake(`cloud:${seed}:${Math.round(cw)}:b`, () => parts.body, {
        blur: 3 * u,
      });
      const lit = this.deps.cache.bake(`cloud:${seed}:${Math.round(cw)}:l`, () => parts.lit, {
        blur: 4 * u,
      });
      const root = new Container();
      lit.alpha = 0.72;
      root.addChild(body, lit);
      root.position.set(
        cr.range(-this.margin, W + this.margin),
        cr.range(H * 0.05, this.horizonY * 0.62),
      );
      root.alpha = cr.range(0.75, 0.95);
      this.clouds.addChild(root);
      this.cloudSprites.push({ body, lit, root, speed: cr.range(4, 11) * u });
    }

    // Hills (redrawn on palette change).
    this.world.addChild(this.hillFar);
    const worldW = W + this.margin * 2;
    const hz = this.horizonY;
    this.ridgeCache = {
      far: ridgePoints(
        worldW,
        hz - H * 0.015,
        H * recipe.hillScale * 0.2,
        1.3 + recipe.hillSeed,
        worldW * 0.55,
      ).map((p) => ({ x: p.x - this.margin, y: p.y })),
      mid: ridgePoints(
        worldW,
        hz + H * 0.005,
        H * recipe.hillScale * 0.13,
        4.1 + recipe.hillSeed,
        worldW * 0.4,
      ).map((p) => ({ x: p.x - this.margin, y: p.y })),
      near: ridgePoints(
        worldW,
        hz + H * 0.02,
        H * recipe.hillScale * 0.07,
        7.7 + recipe.hillSeed,
        worldW * 0.3,
      ).map((p) => ({ x: p.x - this.margin, y: p.y })),
    };

    // Depth layers.
    const mk = (name: string, factor: number, depth: number): DepthLayer => {
      const root = new Container();
      const art = new Container();
      const glow = new Container();
      glow.blendMode = 'add';
      root.addChild(art, glow);
      root.label = `layer:${name}`;
      const layer: DepthLayer = { root, art, glow, factor, depth };
      this.layers.set(name, layer);
      this.tintTargets.push({ container: art, depth });
      return layer;
    };
    const far = mk('far', 0.12, 0.05);
    this.world.addChild(far.root, this.hillMid);
    const farMid = mk('farMid', 0.2, 0.12);
    this.world.addChild(farMid.root, this.hillNear, this.ground, this.groundDetail);
    this.buildGroundDetail(u);
    const mid = mk('mid', 0.4, 0.4);
    this.world.addChild(mid.root);
    const strings = mk('strings', 0.55, 0.7);
    this.world.addChild(strings.root);
    const near = mk('near', 0.75, 0.9);
    this.world.addChild(near.root, this.particleLayer, this.birdLayer);
    const front = mk('front', 1.05, 1);
    this.world.addChild(front.root);
    // Birds fly in the sky but must render behind the near props: reorder.
    this.world.setChildIndex(this.birdLayer, this.world.getChildIndex(this.hillFar));

    const ctx: SceneBuildContext = {
      sceneId: this.sceneId,
      width: W,
      height: H,
      horizonY: this.horizonY,
      margin: this.margin,
      u,
      portrait,
      cache: this.deps.cache,
      quality: q,
      layers: { far, farMid, mid, strings, near, front },
      addGlow: (layer, x, y, radius, color, options) =>
        this.addGlow(layer, x, y, radius, color, options),
      addAnimator: (a) => this.animators.push(a),
      ridgeY: (which, x) => this.ridgeY(which, x),
    };
    buildScene(ctx, recipe);

    // Ambient motes.
    this.spawnMotes(u);
    this.layoutParallax();
  }

  /** Baked ground texture: worn earth patches, pebbles, grass at the edges, cart ruts. */
  private buildGroundDetail(u: number): void {
    const W = this.width;
    const H = this.height;
    const hz = this.horizonY;
    const tex = this.deps.cache.bake(
      `ground:${this.sceneId}:${Math.round(W)}x${Math.round(H)}`,
      () => {
        const g = new Graphics();
        const rnd = new ArtRandom(`ground:${this.sceneId}`);
        const m = this.margin;
        for (let i = 0; i < 70; i++) {
          const d = rnd.next() ** 0.7;
          const y = hz + H * 0.03 + d * (H - hz);
          const x = rnd.range(-m, W + m);
          const r = (20 + 140 * d) * u * rnd.range(0.5, 1.2);
          g.ellipse(x, y, r, r * (0.12 + 0.12 * d)).fill({
            color: rnd.chance(0.5) ? 0x000000 : 0xffffff,
            alpha: rnd.range(0.03, 0.07),
          });
        }
        for (let i = 0; i < 260; i++) {
          const d = rnd.next() ** 0.6;
          const y = hz + H * 0.04 + d * (H - hz);
          const x = rnd.range(-m, W + m);
          const r = (0.8 + 3.2 * d) * u;
          g.ellipse(x, y, r * 1.4, r).fill({
            color: rnd.chance(0.6) ? 0x5a3a24 : 0xf6e3bf,
            alpha: rnd.range(0.25, 0.5),
          });
        }
        // Grass at the far left/right edges of the ground.
        for (let i = 0; i < 160; i++) {
          const side = rnd.chance(0.5) ? rnd.range(-m, W * 0.18) : rnd.range(W * 0.82, W + m);
          const d = rnd.next() ** 0.8;
          const y = hz + H * 0.03 + d * (H - hz);
          const h = (4 + 16 * d) * u;
          g.moveTo(side, y)
            .quadraticCurveTo(
              side + rnd.range(-3, 3) * u,
              y - h * 0.6,
              side + rnd.range(-5, 5) * u,
              y - h,
            )
            .stroke({
              width: Math.max(1, 1.6 * d * u),
              color: rnd.chance(0.5) ? 0x5f7f34 : 0x7a8f3a,
              alpha: 0.6,
            });
        }
        return g;
      },
      { blur: 0.6 * u },
    );
    this.groundDetail.addChild(tex);
  }

  private ridgeY(which: 'far' | 'mid' | 'near', x: number): number {
    const pts = this.ridgeCache?.[which];
    if (!pts || pts.length < 2) return this.horizonY;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return this.horizonY;
    const t = clamp((x - first.x) / (last.x - first.x), 0, 1) * (pts.length - 1);
    const i = Math.min(Math.floor(t), pts.length - 2);
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) return this.horizonY;
    return a.y + (b.y - a.y) * (t - i);
  }

  private addGlow(
    layer: DepthLayer,
    x: number,
    y: number,
    radius: number,
    color: number,
    options: { threshold?: number; flicker?: number; alpha?: number } = {},
  ): Sprite {
    const s = new Sprite(fxTexture(this.deps.cache, 'glow'));
    s.anchor.set(0.5);
    s.position.set(x, y);
    s.scale.set(radius / FX_RADIUS.glow);
    s.tint = color;
    s.alpha = 0;
    layer.glow.addChild(s);
    this.glows.push({
      sprite: s,
      threshold: options.threshold ?? 0.15,
      baseAlpha: options.alpha ?? 0.9,
      flicker: options.flicker ?? 0,
      phase: (x * 0.013 + y * 0.007) % (Math.PI * 2),
    });
    return s;
  }

  private spawnMotes(u: number): void {
    const q = this.deps.quality;
    const W = this.width;
    const H = this.height;
    const rnd = new ArtRandom(`motes:${this.sceneId}`);
    const dot = fxTexture(this.deps.cache, 'soft_dot');
    const petal = fxTexture(this.deps.cache, 'petal');
    const dustN = Math.round(60 * q.particleScale);
    const petalN = Math.round(14 * q.particleScale);
    const flyN = Math.round(46 * q.particleScale);
    for (let i = 0; i < dustN; i++) {
      const s = new Sprite(dot);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = 0xffe2a0;
      s.scale.set(rnd.range(0.12, 0.32) * u);
      s.position.set(rnd.range(0, W), rnd.range(H * 0.15, H * 0.95));
      this.particleLayer.addChild(s);
      this.motes.push({
        sprite: s,
        kind: 'dust',
        vx: rnd.range(-6, 6) * u,
        vy: rnd.range(-9, -2) * u,
        phase: rnd.range(0, 6.28),
        spin: 0,
        life: rnd.range(0, 1),
      });
    }
    const petalCols = [0xf6b11f, 0xf28c28, 0xe56b7f, 0xd9402b, 0xfff4de];
    for (let i = 0; i < petalN; i++) {
      const s = new Sprite(petal);
      s.anchor.set(0.5);
      s.tint = rnd.pick(petalCols);
      s.scale.set(rnd.range(0.5, 0.9) * u);
      s.position.set(rnd.range(0, W), rnd.range(-H * 0.2, H));
      this.particleLayer.addChild(s);
      this.motes.push({
        sprite: s,
        kind: 'petal',
        vx: rnd.range(8, 22) * u,
        vy: rnd.range(18, 34) * u,
        phase: rnd.range(0, 6.28),
        spin: rnd.range(-1.5, 1.5),
        life: 0,
      });
    }
    for (let i = 0; i < flyN; i++) {
      const s = new Sprite(dot);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = 0xd8ff7a;
      s.scale.set(rnd.range(0.25, 0.5) * u);
      s.position.set(rnd.range(0, W), rnd.range(this.horizonY - H * 0.12, H * 0.92));
      this.particleLayer.addChild(s);
      this.motes.push({
        sprite: s,
        kind: 'firefly',
        vx: rnd.range(-12, 12) * u,
        vy: rnd.range(-8, 8) * u,
        phase: rnd.range(0, 6.28),
        spin: rnd.range(0.25, 0.55),
        life: 0,
      });
    }
  }

  private spawnBirds(): void {
    if (!this.deps.quality.birds) return;
    const W = this.width;
    const u = Math.min(W, this.height) / 1080;
    const rnd = new ArtRandom(Math.floor(this.elapsed * 1000));
    const count = rnd.int(3, 6);
    const fromLeft = rnd.chance(0.5);
    const baseY = rnd.range(this.height * 0.08, this.horizonY * 0.55);
    const upTex = this.deps.cache.bake('bird:0', () => drawBird(14, 0));
    const downTex = this.deps.cache.bake('bird:1', () => drawBird(14, 1));
    upTex.destroy();
    downTex.destroy();
    for (let i = 0; i < count; i++) {
      const view = new Container();
      const up = new Sprite(this.deps.cache.texture('bird:0', () => drawBird(14, 0)) ?? undefined);
      const down = new Sprite(
        this.deps.cache.texture('bird:1', () => drawBird(14, 1)) ?? undefined,
      );
      up.anchor.set(0.5);
      down.anchor.set(0.5);
      view.addChild(up, down);
      const sc = rnd.range(0.6, 1.1) * u;
      view.scale.set(fromLeft ? sc : -sc, sc);
      const lead = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 === 0 ? 1 : -1);
      view.position.set(
        fromLeft ? -60 * u - Math.abs(lead) * 34 * u : W + 60 * u + Math.abs(lead) * 34 * u,
        baseY + lead * 18 * u,
      );
      this.birdLayer.addChild(view);
      this.birds.push({
        view,
        up,
        down,
        vx: (fromLeft ? 1 : -1) * rnd.range(70, 95) * u,
        phase: rnd.range(0, 6.28),
      });
    }
  }

  private layoutParallax(): void {
    if (this.destroyed) return;
    const shift = this.margin * 0.9;
    for (const l of this.layers.values()) l.root.x = -this.parallax * l.factor * shift;
    this.clouds.x = -this.parallax * 0.06 * shift;
    this.sunLayer.x = this.rays.x = -this.parallax * 0.03 * shift;
    this.hillFar.x = -this.parallax * 0.1 * shift;
    this.hillMid.x = -this.parallax * 0.16 * shift;
    this.hillNear.x = -this.parallax * 0.26 * shift;
    this.ground.x = -this.parallax * 0.5 * shift;
  }

  /** Apply a palette to every palette-driven element. */
  private applyPalette(p: ScenePalette): void {
    this.palette = p;
    this.deps.lighting.set(p);
    const W = this.width;
    const H = this.height;
    const hz = this.horizonY;
    const m = this.margin;

    // Sky.
    this.sky.clear();
    this.sky.rect(-m * 2, 0, W + m * 4, hz + H * 0.08).fill(
      vgrad([
        [0, p.skyTop],
        [0.42, p.skyMid],
        [0.78, p.skyLow],
        [1, p.skyHorizon],
      ]),
    );
    // Horizon bloom band.
    this.sky.ellipse(p.sunX * W, hz, W * 0.9, H * 0.16).fill(
      rgrad([
        [0, rgba(lighten(p.skyHorizon, 0.25), 0.55)],
        [1, rgba(p.skyHorizon, 0)],
      ]),
    );

    // Stars.
    this.stars.alpha = p.stars;
    this.stars.visible = p.stars > 0.01;

    // Sun.
    const sx = p.sunX * W;
    const sy = p.sunY * H;
    const sr = p.sunRadius * Math.min(W, H) * 1.5;
    if (this.sunHalo && this.sunDisc && this.sunCore) {
      this.sunHalo.position.set(sx, sy);
      this.sunHalo.scale.set((sr * 11) / FX_RADIUS.glow);
      this.sunHalo.tint = p.sunHalo;
      this.sunHalo.alpha = 0.95;
      this.sunDisc.position.set(sx, sy);
      this.sunDisc.scale.set(sr / FX_RADIUS.disc);
      this.sunDisc.tint = p.sun;
      this.sunCore.position.set(sx, sy);
      this.sunCore.scale.set((sr * 3.4) / FX_RADIUS.glow);
      this.sunCore.tint = lighten(p.sun, 0.6);
      this.sunCore.alpha = 1;
    }
    this.rays.position.set(sx, sy);
    this.rays.alpha = this.deps.quality.godrays ? p.godrays : p.godrays * 0.6;
    this.rays.tint = p.sunHalo;

    // Clouds.
    for (const c of this.cloudSprites) {
      c.body.tint = p.cloud;
      c.lit.tint = p.cloudLit;
    }

    // Hills with atmospheric perspective.
    const r = this.ridgeCache;
    const bottom = hz + H * 0.12;
    if (r) {
      this.hillFar.clear();
      fillRidge(
        this.hillFar,
        r.far,
        bottom,
        mixColor(p.hillFar, p.haze, 0.15),
        mixColor(p.hillFar, p.haze, 0.7),
      );
      this.hillMid.clear();
      fillRidge(
        this.hillMid,
        r.mid,
        bottom,
        mixColor(p.hillMid, p.haze, 0.08),
        mixColor(p.hillMid, p.haze, 0.45),
      );
      this.hillNear.clear();
      fillRidge(
        this.hillNear,
        r.near,
        bottom,
        p.hillNear,
        mixColor(p.hillNear, p.groundShade, 0.4),
      );
    }

    // Ground with a path into the distance and a sun-side warm wash.
    this.ground.clear();
    this.ground.rect(-m * 2, hz + H * 0.02, W + m * 4, H - hz).fill(
      vgrad([
        [0, mixColor(p.ground, p.haze, 0.35)],
        [0.35, p.ground],
        [1, p.groundShade],
      ]),
    );
    const recipe = SCENE_RECIPES[this.sceneId];
    if (recipe.path !== 'none') {
      const top = hz + H * 0.03;
      const cx = W * recipe.pathX;
      const topW = W * 0.03;
      const botW = W * (recipe.path === 'road' ? 0.55 : 0.5);
      if (recipe.path === 'road') {
        this.ground
          .moveTo(cx - topW, top)
          .bezierCurveTo(
            cx - W * 0.12,
            top + (H - top) * 0.3,
            cx + W * 0.2,
            top + (H - top) * 0.55,
            cx - botW / 2,
            H,
          )
          .lineTo(cx + botW / 2, H)
          .bezierCurveTo(
            cx + W * 0.45,
            top + (H - top) * 0.55,
            cx - W * 0.02,
            top + (H - top) * 0.3,
            cx + topW,
            top,
          )
          .closePath();
      } else {
        const lane = (spread: number): void => {
          this.ground
            .moveTo(cx - topW * 2 * spread, top)
            .bezierCurveTo(
              cx - W * 0.05 * spread,
              top + (H - top) * 0.35,
              cx - botW * 0.32 * spread,
              top + (H - top) * 0.7,
              cx - (botW / 2) * spread,
              H,
            )
            .lineTo(cx + (botW / 2) * spread, H)
            .bezierCurveTo(
              cx + botW * 0.36 * spread,
              top + (H - top) * 0.7,
              cx + W * 0.07 * spread,
              top + (H - top) * 0.35,
              cx + topW * 2 * spread,
              top,
            )
            .closePath();
        };
        lane(1.18);
        this.ground.fill({ color: p.path, alpha: 0.35 });
        lane(1);
      }
      this.ground.fill(
        vgrad([
          [0, mixColor(p.path, p.haze, 0.4)],
          [1, p.path],
        ]),
      );
    }
    this.ground.ellipse(sx, hz + H * 0.08, W * 0.45, H * 0.07).fill(
      rgrad([
        [0, rgba(p.sunHalo, 0.28)],
        [1, rgba(p.sunHalo, 0)],
      ]),
    );

    // Tints by depth (haze for far layers).
    for (const t of this.tintTargets) {
      const haze = (1 - t.depth) ** 1.6 * 0.42;
      t.container.tint = mixColor(p.lightTint, p.haze, haze);
    }

    this.groundDetail.tint = p.lightTint;

    // Warm sunlight wash over the whole frame (additive), strongest towards the sun.
    this.sunWash.clear();
    this.sunWash.rect(0, 0, W, H).fill(
      rgrad(
        [
          [0, rgba(p.sunHalo, 0.34 * p.godrays + 0.06)],
          [0.5, rgba(p.sunHalo, 0.1 * p.godrays)],
          [1, rgba(p.sunHalo, 0)],
        ],
        { x: p.sunX, y: Math.min(p.sunY, 0.6) },
        0.85,
      ),
    );

    // Vignette.
    this.vignette.clear();
    this.vignette.rect(0, 0, W, H).fill(
      rgrad(
        [
          [0, rgba(p.shadow, 0)],
          [0.7, rgba(p.shadow, 0)],
          [1, rgba(p.shadow, p.vignette * 0.75)],
        ],
        { x: 0.5, y: 0.48 },
        0.72,
      ),
    );
  }

  private update(dt: number): void {
    if (this.destroyed) return;
    const step = Math.min(dt, 0.1);
    this.elapsed += step;
    const t = this.elapsed;
    const p = this.palette;
    const q = this.deps.quality;
    const motion = q.motionScale;
    const W = this.width;
    const H = this.height;

    if (q.cameraMoves && Math.abs(this.parallaxTarget - this.parallax) > 1e-4) {
      this.parallax += (this.parallaxTarget - this.parallax) * Math.min(1, step * 4);
      this.layoutParallax();
    }

    // Clouds drift and wrap.
    for (const c of this.cloudSprites) {
      c.root.x += c.speed * step * motion;
      if (c.root.x > W + this.margin * 2 + 300) c.root.x = -this.margin * 2 - 300;
    }
    // Stars twinkle slowly (< 1 Hz, never flashing).
    if (this.stars.visible) {
      for (const s of this.starSprites) s.sprite.alpha = 0.55 + 0.45 * Math.sin(t * 0.9 + s.phase);
    }
    // Rays breathe and turn slowly.
    this.rays.rotation = t * 0.01 * motion;
    // Glows: switch on progressively as lights rise; gentle flicker for flames.
    for (const g of this.glows) {
      const on = clamp((p.lights - g.threshold) / 0.18, 0, 1);
      const flick =
        g.flicker > 0
          ? 1 -
            g.flicker * (0.5 + 0.5 * Math.sin(t * 7.1 + g.phase) * Math.sin(t * 3.3 + g.phase * 2))
          : 1;
      g.sprite.alpha = on * g.baseAlpha * flick;
      g.sprite.visible = g.sprite.alpha > 0.005;
    }
    // Ambient motes.
    for (const m of this.motes) {
      const s = m.sprite;
      if (m.kind === 'dust') {
        s.visible = p.dust > 0.05;
        if (!s.visible) continue;
        s.x += (m.vx + Math.sin(t * 0.7 + m.phase) * 6) * step * motion;
        s.y += m.vy * step * motion;
        s.alpha = p.dust * (0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.8 + m.phase)));
        if (s.y < H * 0.1) s.y = H * 0.95;
        if (s.x < -20) s.x = W + 20;
        if (s.x > W + 20) s.x = -20;
      } else if (m.kind === 'petal') {
        s.x += (m.vx + Math.sin(t * 1.2 + m.phase) * 20) * step * motion;
        s.y += m.vy * step * motion;
        s.rotation += m.spin * step * motion;
        s.scale.y = Math.abs(Math.cos(t * 1.6 + m.phase)) * s.scale.x * 0.9 + s.scale.x * 0.1;
        s.alpha = 0.9 * (1 - p.stars * 0.5);
        if (s.y > H + 30) {
          s.y = -30;
          s.x = ((s.x * 7.13 + 97) % (W + 200)) - 100;
        }
        if (s.x > W + 40) s.x = -40;
      } else {
        s.visible = p.fireflies > 0.05;
        if (!s.visible) continue;
        s.x += m.vx * Math.sin(t * 0.3 + m.phase) * step * motion;
        s.y += m.vy * Math.cos(t * 0.37 + m.phase) * step * motion;
        // Slow blink: ~0.25-0.55 Hz, far below the 3 Hz flashing limit (KSK-05).
        const blink = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * m.spin + m.phase);
        s.alpha = p.fireflies * blink * blink;
      }
    }
    // Birds.
    if (t > this.nextBirdAt && p.stars < 0.6) {
      this.spawnBirds();
      this.nextBirdAt = t + 14 + ((t * 7.7) % 12);
    }
    for (let i = this.birds.length - 1; i >= 0; i--) {
      const b = this.birds[i];
      if (!b) continue;
      b.view.x += b.vx * step;
      b.view.y += Math.sin(t * 1.3 + b.phase) * 6 * step;
      const flap = Math.sin(t * Math.PI * 2 * 2.6 + b.phase) > 0;
      b.up.visible = flap;
      b.down.visible = !flap;
      b.view.tint = mixColor(0x2b2233, p.shadow, 0.4);
      if (b.view.x < -200 || b.view.x > W + 200) {
        b.view.destroy({ children: true });
        this.birds.splice(i, 1);
      }
    }
    for (const a of this.animators) a(t, step, p);
  }
}
