/**
 * Scene recipes: how each {@link SceneId} composes the mela from props, at every orientation.
 * Layout uses world coordinates in [-margin, width + margin] so parallax and camera pans reveal more of
 * the fair. Depth `d` places props on the ground plane (0 = horizon, 1 = bottom edge) with perspective
 * scale; far props receive atmospheric haze through their layer tint.
 */
import { Container, Graphics, type Sprite } from 'pixi.js';
import type { SceneId } from '../../core/contracts.ts';
import { darken, lighten, mixColor } from '../color.ts';
import { catenary, polyline, softShadow, vgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';
import type { QualityProfile } from '../quality.ts';
import { ArtRandom } from '../rand.ts';
import type { TextureCache } from '../textures.ts';
import type { Animator, DepthLayer } from './MelaBackdrop.ts';
import {
  drawBanyan,
  drawFairGoer,
  drawField,
  drawNeem,
  drawPalm,
  drawTuft,
  drawTulsi,
  type TreeArt,
} from './nature.ts';
import {
  AWNING_COLOURWAYS,
  drawBalloonBunch,
  drawBulb,
  drawDiya,
  drawFlag,
  drawGoodsRow,
  drawStall,
  type StallGoods,
} from './props.ts';
import {
  drawCart,
  drawChabutra,
  drawCounter,
  drawFerrisWheel,
  drawHouse,
  drawLampPost,
  drawRangoli,
  drawSkyLantern,
  drawTemple,
  drawTentDrape,
  drawToran,
  drawWeighingPost,
} from './structures.ts';

/** Context handed to scene builders by the backdrop. */
export interface SceneBuildContext {
  readonly sceneId: SceneId;
  readonly width: number;
  readonly height: number;
  readonly horizonY: number;
  readonly margin: number;
  /** Scale unit: short edge / 1080. */
  readonly u: number;
  readonly portrait: boolean;
  readonly cache: TextureCache;
  readonly quality: QualityProfile;
  readonly layers: {
    readonly far: DepthLayer;
    readonly farMid: DepthLayer;
    readonly mid: DepthLayer;
    readonly strings: DepthLayer;
    readonly near: DepthLayer;
    readonly front: DepthLayer;
  };
  addGlow(
    layer: DepthLayer,
    x: number,
    y: number,
    radius: number,
    color: number,
    options?: { threshold?: number; flicker?: number; alpha?: number },
  ): Sprite;
  addAnimator(a: Animator): void;
  ridgeY(which: 'far' | 'mid' | 'near', x: number): number;
}

/** Static description of a scene. */
export interface SceneRecipe {
  readonly horizon: number;
  readonly horizonPortrait: number;
  readonly hillScale: number;
  readonly hillSeed: number;
  readonly path: 'none' | 'lane' | 'road';
  readonly pathX: number;
  readonly build: (ctx: SceneBuildContext, kit: SceneKit) => void;
}

/** Destroy eagerly built drawings that a texture-cache hit left unused. */
function dispose(...items: Container[]): void {
  for (const c of items) if (!c.destroyed) c.destroy({ children: true });
}

/* ================================================================================================
 * Placement kit
 * ============================================================================================== */

/** Helpers that place baked props with their glows and animators. */
export class SceneKit {
  constructor(private readonly ctx: SceneBuildContext) {}

  /** Ground y at depth d (0 horizon .. 1 bottom). */
  groundY(d: number): number {
    return this.ctx.horizonY + d * (this.ctx.height - this.ctx.horizonY);
  }

  /** Perspective scale at depth d. */
  scaleAt(d: number): number {
    return this.ctx.u * (0.28 + 0.95 * d);
  }

  /** World x from a 0..1 fraction of the visible width. */
  x(f: number): number {
    return f * this.ctx.width;
  }

  /** Long soft ground shadow that follows the sun (direction and length from the live palette). */
  groundShadow(layer: DepthLayer, x: number, y: number, w: number, h: number): void {
    const s = this.ctx.cache.bake(
      'shadow:ellipse',
      () => softShadow(new Graphics(), 0, 0, 100, 20, 0xffffff, 1),
      { blur: 6 },
    );
    const holder = new Container();
    holder.addChild(s);
    holder.position.set(x, y);
    layer.art.addChild(holder);
    let last = Number.NaN;
    this.ctx.addAnimator((_t, _dt, p) => {
      const key = p.shadowDir * 10 + p.shadowLength + p.shadowAlpha;
      if (key === last) return;
      last = key;
      const len = 1 + p.shadowLength * 0.9;
      holder.scale.set((w / 200) * len, h / 40);
      holder.x = x + p.shadowDir * w * p.shadowLength * 0.28;
      holder.skew.x = -p.shadowDir * 0.25 * p.shadowLength;
      s.tint = p.shadow;
      holder.alpha = Math.min(0.85, p.shadowAlpha * 1.9);
    });
  }

  tree(
    layer: DepthLayer,
    kind: 'banyan' | 'neem' | 'palm',
    x: number,
    y: number,
    size: number,
    seed: number,
  ): void {
    const key = `tree:${kind}:${seed}:${Math.round(size)}`;
    const art: TreeArt =
      kind === 'banyan'
        ? drawBanyan(size, seed)
        : kind === 'neem'
          ? drawNeem(size, seed)
          : drawPalm(size, seed);
    const trunk = this.ctx.cache.bake(`${key}:t`, () => art.trunk);
    const canopyBaked = this.ctx.cache.bake(`${key}:c`, () => art.canopy);
    this.groundShadow(
      layer,
      x,
      y,
      size * (kind === 'banyan' ? 2.2 : 0.9),
      size * (kind === 'banyan' ? 0.16 : 0.08),
    );
    const root = new Container();
    root.position.set(x, y);
    const can = new Container();
    can.pivot.set(art.pivot.x, art.pivot.y);
    can.position.set(art.pivot.x, art.pivot.y);
    can.addChild(canopyBaked);
    root.addChild(trunk, can);
    layer.art.addChild(root);
    dispose(art.trunk, art.canopy);
    const phase = (seed % 100) / 15.9;
    const amp = (kind === 'banyan' ? 0.006 : 0.014) * this.ctx.quality.motionScale;
    this.ctx.addAnimator((t) => {
      can.rotation = Math.sin(t * 0.55 + phase) * amp + Math.sin(t * 1.37 + phase * 2) * amp * 0.35;
      can.skew.x = Math.sin(t * 0.55 + phase + 0.6) * amp * 0.6;
    });
  }

  stall(
    layer: DepthLayer,
    x: number,
    y: number,
    scale: number,
    goods: StallGoods,
    seed: number,
    colourway?: number,
  ): void {
    const rnd = new ArtRandom(seed);
    const [a, b] = AWNING_COLOURWAYS[
      (colourway ?? rnd.int(0, AWNING_COLOURWAYS.length - 1)) % AWNING_COLOURWAYS.length
    ] ?? [MELA.saffron, MELA.cream];
    const cloth = rnd.pick([MELA.kumkum, MELA.indigo, MELA.peacockDeep, 0x6a2c4a, MELA.terracotta]);
    const style = { goods, stripeA: a, stripeB: b, cloth, seed };
    const built = drawStall(style, 1);
    const key = `stall:${goods}:${seed}:${a}:${b}`;
    this.groundShadow(layer, x, y + 4 * scale, 300 * scale, 30 * scale);
    const sprite = this.ctx.cache.bake(key, () => built.view, {
      resolution: Math.max(1, scale * 1.25),
    });
    sprite.scale.set(scale);
    sprite.position.set(x, y);
    layer.art.addChild(sprite);
    for (const l of built.lights)
      this.ctx.addGlow(layer, x + l.x * scale, y + l.y * scale, l.r * scale * 1.3, l.color, {
        threshold: rnd.range(0.05, 0.35),
        flicker: 0.08,
      });
    if (!built.view.destroyed) built.view.destroy({ children: true });
  }

  bunting(
    layer: DepthLayer,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    sag: number,
    flagSize: number,
    seed: number,
  ): void {
    const rnd = new ArtRandom(seed);
    const rope = new Graphics();
    const segs = 40;
    const pts = catenary(x1, y1, x2, y2, sag, segs);
    polyline(rope, pts, Math.max(1.5, flagSize * 0.06), 0x5a3a24);
    layer.art.addChild(rope);
    const cols = [
      MELA.vermilion,
      MELA.marigold,
      MELA.peacock,
      MELA.rose,
      MELA.saffron,
      MELA.indigo,
      MELA.mango,
      MELA.cream,
    ];
    const kind = rnd.pick(['triangle', 'triangle', 'pennant', 'square'] as const);
    const count = Math.max(6, Math.round(Math.hypot(x2 - x1, y2 - y1) / (flagSize * 1.25)));
    const flags: { s: Container; phase: number }[] = [];
    for (let i = 1; i < count; i++) {
      const t = i / count;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t + sag * 4 * t * (1 - t);
      const col = cols[(i + seed) % cols.length] ?? MELA.rose;
      const s = this.ctx.cache.bake(`flag:${kind}:${col}:${Math.round(flagSize)}`, () =>
        drawFlag(kind, col, flagSize),
      );
      s.position.set(px, py);
      // Align to the rope slope.
      const slope = (y2 - y1) / (x2 - x1) + (sag * 4 * (1 - 2 * t)) / (x2 - x1);
      s.rotation = Math.atan(slope) * 0.5;
      layer.art.addChild(s);
      flags.push({ s, phase: i * 0.55 + rnd.range(0, 0.4) });
    }
    const amp = 0.12 * this.ctx.quality.motionScale;
    this.ctx.addAnimator((t) => {
      for (const f of flags) {
        f.s.skew.x = Math.sin(t * 2.6 + f.phase) * amp;
        f.s.scale.x = 1 - Math.abs(Math.sin(t * 2.6 + f.phase)) * amp * 0.6;
      }
    });
  }

  stringLights(
    layer: DepthLayer,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    sag: number,
    bulbSize: number,
    seed: number,
  ): void {
    const rnd = new ArtRandom(seed);
    const wire = new Graphics();
    polyline(wire, catenary(x1, y1, x2, y2, sag, 40), Math.max(1, bulbSize * 0.25), 0x2b2025);
    layer.art.addChild(wire);
    const n = Math.max(8, Math.round(Math.hypot(x2 - x1, y2 - y1) / (bulbSize * 6)));
    const cols = [0xffd27a, 0xffb36b, 0xfff0c4, 0xff8f6b, 0xb8f0ff];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t + sag * 4 * t * (1 - t) + bulbSize * 0.8;
      const c = cols[i % cols.length] ?? 0xffd27a;
      const bulb = this.ctx.cache.bake(`bulb:${c}:${Math.round(bulbSize)}`, () =>
        drawBulb(bulbSize, c),
      );
      bulb.position.set(px, py);
      layer.art.addChild(bulb);
      // Bulbs switch on in a travelling ripple along the strand as dusk deepens.
      this.ctx.addGlow(layer, px, py, bulbSize * 7, c, {
        threshold: 0.08 + 0.3 * t + rnd.range(-0.04, 0.04),
        alpha: 0.85,
      });
      this.ctx.addGlow(layer, px, py, bulbSize * 2, 0xffffff, {
        threshold: 0.08 + 0.3 * t,
        alpha: 0.7,
      });
    }
  }

  diya(layer: DepthLayer, x: number, y: number, scale: number): void {
    const d = drawDiya(1);
    const flameAt = { x: d.flame.x, y: d.flame.y };
    const bowl = this.ctx.cache.bake('diya:bowl', () => d.bowl);
    bowl.scale.set(scale);
    bowl.position.set(x, y);
    layer.art.addChild(bowl);
    const flameBaked = this.ctx.cache.bake('diya:flame', () => d.flame);
    const flame = new Container();
    flame.addChild(flameBaked);
    flame.position.set(x + flameAt.x * scale, y + flameAt.y * scale);
    flame.scale.set(scale);
    flameBaked.position.set(-flameAt.x, -flameAt.y);
    dispose(d.bowl, d.flame);
    layer.glow.addChild(flame);
    this.ctx.addGlow(
      layer,
      x + d.light.x * scale,
      y + d.light.y * scale,
      d.light.r * scale * 1.4,
      d.light.color,
      { threshold: 0.0, flicker: 0.15 },
    );
    const phase = x * 0.031;
    this.ctx.addAnimator((t, _dt, p) => {
      const on = Math.min(1, p.lights * 3);
      flame.alpha = on;
      flame.visible = on > 0.01;
      flame.scale.y = scale * (1 + 0.1 * Math.sin(t * 9.3 + phase) * Math.sin(t * 4.1 + phase));
      flame.skew.x = 0.08 * Math.sin(t * 5.7 + phase);
    });
  }

  temple(layer: DepthLayer, x: number, y: number, size: number): void {
    const tpl = drawTemple(size);
    tpl.view.removeChild(tpl.flag);
    const body = this.ctx.cache.bake(`temple:${Math.round(size)}`, () => tpl.view);
    body.position.set(x, y);
    layer.art.addChild(body);
    dispose(tpl.view);
    const flag = tpl.flag;
    flag.position.set(x + tpl.flagAnchor.x, y + tpl.flagAnchor.y);
    layer.art.addChild(flag);
    this.ctx.addAnimator((t) => {
      flag.scale.x = 0.85 + 0.15 * Math.sin(t * 3.1);
      flag.skew.y = 0.08 * Math.sin(t * 3.1 + 1);
    });
    this.ctx.addGlow(layer, x + size * 0.12, y - size * 0.26, size * 0.3, 0xffb04a, {
      threshold: 0.25,
      flicker: 0.05,
    });
    for (let k = 0; k < 5; k++)
      this.ctx.addGlow(
        layer,
        x - size * 0.5 + k * size * 0.25,
        y - size * 0.06,
        size * 0.12,
        0xffa347,
        { threshold: 0.4 + k * 0.05, flicker: 0.12 },
      );
  }

  ferrisWheel(layer: DepthLayer, x: number, y: number, r: number): void {
    const fw = drawFerrisWheel(r);
    const frame = this.ctx.cache.bake(`fw:frame:${Math.round(r)}`, () => fw.frame);
    frame.position.set(x, y);
    const wheel = new Container();
    wheel.position.set(x + fw.hub.x, y + fw.hub.y);
    const baked = this.ctx.cache.bake(`fw:wheel:${Math.round(r)}`, () => {
      fw.wheel.position.set(0, 0);
      return fw.wheel;
    });
    wheel.addChild(baked);
    layer.art.addChild(frame, wheel);
    const gondolas = fw.gondolas.map((g, i) => {
      const s = this.ctx.cache.bake(`fw:gondola:${i}:${Math.round(r)}`, () => g);
      layer.art.addChild(s);
      return s;
    });
    dispose(fw.frame, fw.wheel, ...fw.gondolas);
    const bulbGlows = fw.bulbs.map((b, i) =>
      this.ctx.addGlow(layer, 0, 0, b.r * 2.4, b.color, {
        threshold: 0.12 + (i % 8) * 0.03,
        alpha: 0.8,
      }),
    );
    const speed = 0.06 * this.ctx.quality.motionScale;
    this.ctx.addAnimator((t) => {
      const rot = t * speed;
      wheel.rotation = rot;
      gondolas.forEach((g, i) => {
        const a = rot + (i / gondolas.length) * Math.PI * 2;
        g.position.set(wheel.x + Math.cos(a) * r, wheel.y + Math.sin(a) * r);
      });
      bulbGlows.forEach((s, i) => {
        const b = fw.bulbs[i];
        if (!b) return;
        const a = Math.atan2(b.y, b.x) + rot;
        s.position.set(wheel.x + Math.cos(a) * r, wheel.y + Math.sin(a) * r);
      });
    });
  }

  house(layer: DepthLayer, x: number, y: number, size: number, seed: number): void {
    const h = drawHouse(size, seed);
    const s = this.ctx.cache.bake(`house:${seed}:${Math.round(size)}`, () => h.view);
    s.position.set(x, y);
    layer.art.addChild(s);
    dispose(h.view);
    const rnd = new ArtRandom(seed);
    for (const l of h.lights)
      this.ctx.addGlow(layer, x + l.x, y + l.y, l.r, l.color, {
        threshold: rnd.range(0.3, 0.75),
        flicker: 0.04,
      });
  }

  lampPost(layer: DepthLayer, x: number, y: number, size: number, color: number): void {
    const lp = drawLampPost(size, color);
    const s = this.ctx.cache.bake(`lamppost:${Math.round(size)}:${color}`, () => lp.view);
    s.position.set(x, y);
    layer.art.addChild(s);
    dispose(lp.view);
    for (const l of lp.lights)
      this.ctx.addGlow(layer, x + l.x, y + l.y, l.r * 1.6, l.color, {
        threshold: 0.2,
        flicker: 0.08,
      });
  }

  /**
   * A crowd of small fair-goers between depths d0..d1, kept off the central lane. Most idle with a
   * gentle sway; some stroll slowly across and wrap around.
   */
  crowd(
    layer: DepthLayer,
    d0: number,
    d1: number,
    count: number,
    seed: number,
    options: { blur?: number; laneHalf?: number } = {},
  ): void {
    const rnd = new ArtRandom(seed);
    const span = this.ctx.width + this.ctx.margin * 2;
    const people: { c: Container; d: number; vx: number; phase: number; x0: number }[] = [];
    const laneHalf = (options.laneHalf ?? 0.07) * this.ctx.width;
    for (let i = 0; i < Math.round(count * Math.max(0.4, this.ctx.quality.particleScale)); i++) {
      const d = rnd.range(d0, d1);
      let x = -this.ctx.margin + rnd.range(0, span);
      if (Math.abs(x - this.ctx.width / 2) < laneHalf + d * this.ctx.width * 0.12)
        x += (x < this.ctx.width / 2 ? -1 : 1) * (laneHalf + d * this.ctx.width * 0.15);
      const variant = rnd.int(0, 23);
      const sprite = this.ctx.cache.bake(
        `fairgoer:${variant}:${options.blur ?? 0}`,
        () => drawFairGoer(120, variant * 97 + 13),
        options.blur ? { blur: options.blur } : {},
      );
      const c = new Container();
      c.addChild(sprite);
      const sc = this.scaleAt(d) * 0.62;
      c.scale.set(rnd.chance(0.5) ? sc : -sc, sc);
      c.position.set(x, this.groundY(d));
      people.push({
        c,
        d,
        vx: rnd.chance(0.3)
          ? rnd.range(6, 16) * (rnd.chance(0.5) ? 1 : -1) * this.ctx.u * (0.4 + d)
          : 0,
        phase: rnd.range(0, 6.28),
        x0: x,
      });
    }
    people.sort((a, b) => a.d - b.d);
    for (const p of people) layer.art.addChild(p.c);
    const ms = this.ctx.quality.motionScale;
    const W = this.ctx.width;
    const m = this.ctx.margin;
    this.ctx.addAnimator((t, dt) => {
      for (const p of people) {
        if (p.vx !== 0) {
          p.c.x += p.vx * dt * ms;
          if (p.c.x > W + m) p.c.x = -m;
          if (p.c.x < -m) p.c.x = W + m;
          p.c.y = this.groundY(p.d) - Math.abs(Math.sin(t * 5 + p.phase)) * 2 * this.ctx.u * ms;
        } else {
          p.c.skew.x = Math.sin(t * 0.8 + p.phase) * 0.03 * ms;
        }
      }
    });
  }

  tufts(layer: DepthLayer, x: number, y: number, size: number, seed: number, blur = 0): void {
    const s = this.ctx.cache.bake(
      `tuft:${seed}:${Math.round(size)}:${blur}`,
      () => drawTuft(size, seed),
      blur > 0 ? { blur } : {},
    );
    s.position.set(x, y);
    layer.art.addChild(s);
  }

  rangoli(layer: DepthLayer, x: number, y: number, r: number): void {
    const s = this.ctx.cache.bake(`rangoli:${Math.round(r)}`, () => drawRangoli(r));
    s.position.set(x, y);
    s.scale.y = 0.34;
    layer.art.addChild(s);
  }

  toran(layer: DepthLayer): void {
    const w = this.ctx.width + this.ctx.margin * 2;
    const s = this.ctx.cache.bake(`toran:${Math.round(w)}`, () => drawToran(w, this.ctx.u, 7));
    const holder = new Container();
    holder.position.set(-this.ctx.margin, -4 * this.ctx.u);
    holder.addChild(s);
    layer.art.addChild(holder);
    const amp = 0.004 * this.ctx.quality.motionScale;
    this.ctx.addAnimator((t) => {
      holder.skew.x = Math.sin(t * 0.8) * amp;
      holder.y =
        -4 * this.ctx.u + Math.sin(t * 0.8 + 1) * 2 * this.ctx.u * this.ctx.quality.motionScale;
    });
  }

  /** Distant tree line along a ridge. */
  treeLine(
    layer: DepthLayer,
    count: number,
    ridge: 'far' | 'mid' | 'near',
    size: number,
    seed: number,
  ): void {
    const rnd = new ArtRandom(seed);
    const span = this.ctx.width + this.ctx.margin * 2;
    for (let i = 0; i < count; i++) {
      const x = -this.ctx.margin + rnd.range(0, span);
      const y = this.ctx.ridgeY(ridge, x) + size * rnd.range(0.15, 0.6);
      const kind = rnd.chance(0.88) ? 'neem' : 'palm';
      const sz = size * rnd.range(0.7, 1.2);
      const art = kind === 'neem' ? drawNeem(sz, i + seed) : drawPalm(sz, i + seed);
      const holder = new Container();
      holder.addChild(art.trunk, art.canopy);
      const s = this.ctx.cache.bake(
        `treeline:${kind}:${seed}:${i}:${Math.round(sz)}`,
        () => holder,
        { blur: 0.8 },
      );
      s.position.set(x, y);
      layer.art.addChild(s);
      dispose(holder);
    }
  }

  /** A row of back stalls across the world width. */
  stallRow(layer: DepthLayer, d: number, count: number, seed: number, gapCentre = 0): void {
    const rnd = new ArtRandom(seed);
    const goods: StallGoods[] = [
      'spice',
      'fruit',
      'pots',
      'bangles',
      'fabric',
      'sweets',
      'flowers',
      'toys',
    ];
    const span = this.ctx.width + this.ctx.margin * 2;
    const y = this.groundY(d);
    const sc = this.scaleAt(d);
    for (let i = 0; i < count; i++) {
      const x = -this.ctx.margin + (span / count) * (i + 0.5) + rnd.range(-20, 20) * this.ctx.u;
      if (gapCentre > 0 && Math.abs(x - this.ctx.width / 2) < (gapCentre * this.ctx.width) / 2)
        continue;
      this.stall(
        layer,
        x,
        y + rnd.range(-4, 4) * this.ctx.u,
        sc * rnd.range(0.92, 1.05),
        goods[(i + seed) % goods.length] ?? 'spice',
        seed * 31 + i,
        i,
      );
    }
  }

  /** Diyas in a gentle arc. */
  diyaArc(
    layer: DepthLayer,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    count: number,
    scale: number,
    from = 0,
    to = Math.PI,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = from + ((to - from) * i) / Math.max(1, count - 1);
      this.diya(layer, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, scale);
    }
  }
}

/* ================================================================================================
 * Recipes
 * ============================================================================================== */

function fair(
  ctx: SceneBuildContext,
  k: SceneKit,
  opts: { wheel: boolean; rangoli: boolean; seed: number },
): void {
  const { width: W, height: H, u, layers: L, portrait } = ctx;
  // Far: temple on the ridge, tree line, giant wheel.
  const tx = k.x(portrait ? 0.74 : 0.8);
  k.temple(L.far, tx, ctx.ridgeY('far', tx) + H * 0.02, H * (portrait ? 0.14 : 0.2));
  k.treeLine(L.far, portrait ? 14 : 26, 'mid', H * 0.045, opts.seed + 3);
  if (opts.wheel)
    k.ferrisWheel(
      L.farMid,
      k.x(portrait ? 0.22 : 0.24),
      k.groundY(0.05),
      H * (portrait ? 0.1 : 0.15),
    );
  k.treeLine(L.farMid, portrait ? 6 : 10, 'near', H * 0.07, opts.seed + 9);
  // Back stalls row.
  k.stallRow(L.mid, 0.14, portrait ? 6 : 10, opts.seed + 1, portrait ? 0 : 0.2);
  k.crowd(L.mid, 0.15, 0.34, portrait ? 14 : 26, opts.seed + 61);
  // Great trees framing.
  k.tree(
    L.mid,
    'banyan',
    k.x(portrait ? 0.02 : 0.08),
    k.groundY(0.3),
    H * (portrait ? 0.17 : 0.28),
    opts.seed + 11,
  );
  k.tree(
    L.mid,
    'neem',
    k.x(portrait ? 0.98 : 0.94),
    k.groundY(0.28),
    H * (portrait ? 0.26 : 0.42),
    opts.seed + 13,
  );
  // Bunting and string lights across the upper third.
  k.bunting(L.strings, -ctx.margin, H * 0.16, W * 0.52, H * 0.12, H * 0.07, 30 * u, opts.seed + 21);
  k.bunting(
    L.strings,
    W * 0.48,
    H * 0.12,
    W + ctx.margin,
    H * 0.17,
    H * 0.07,
    30 * u,
    opts.seed + 22,
  );
  k.stringLights(
    L.strings,
    -ctx.margin,
    H * 0.24,
    W + ctx.margin,
    H * 0.22,
    H * 0.09,
    5 * u,
    opts.seed + 23,
  );
  if (!portrait)
    k.bunting(L.strings, W * 0.12, H * 0.3, W * 0.88, H * 0.3, H * 0.06, 22 * u, opts.seed + 24);
  // Near stalls at the edges frame the centre stage.
  k.stall(
    L.near,
    k.x(portrait ? -0.06 : 0.0),
    k.groundY(0.62),
    k.scaleAt(0.62),
    'spice',
    opts.seed + 41,
    0,
  );
  k.stall(
    L.near,
    k.x(portrait ? 1.06 : 1.0),
    k.groundY(0.6),
    k.scaleAt(0.6),
    'flowers',
    opts.seed + 42,
    1,
  );
  // Lamp posts line the lane (their lanterns glow as the day ends).
  for (const [f, d] of [
    [0.4, 0.22],
    [0.6, 0.22],
    [0.33, 0.42],
    [0.67, 0.42],
  ] as const) {
    k.lampPost(
      d < 0.3 ? L.mid : L.near,
      k.x(f),
      k.groundY(d),
      H * 0.34 * (0.35 + d),
      f < 0.5 ? MELA.marigold : MELA.vermilion,
    );
  }
  if (opts.rangoli) k.rangoli(L.near, W / 2, k.groundY(0.72), Math.min(W, H) * 0.2);
  // Foreground: diyas, tufts, toran.
  k.diyaArc(L.front, W * 0.08, H * 0.95, W * 0.05, H * 0.015, 3, u * 1.1, 0, Math.PI);
  k.diyaArc(L.front, W * 0.92, H * 0.95, W * 0.05, H * 0.015, 3, u * 1.1, 0, Math.PI);
  k.tufts(L.front, W * 0.02, H * 1.0, 90 * u, opts.seed + 51, 2 * u);
  k.tufts(L.front, W * 0.98, H * 1.0, 100 * u, opts.seed + 52, 2 * u);
  k.toran(L.front);
}

export const SCENE_RECIPES: Readonly<Record<SceneId, SceneRecipe>> = {
  attract: {
    horizon: 0.56,
    horizonPortrait: 0.5,
    hillScale: 1,
    hillSeed: 0,
    path: 'lane',
    pathX: 0.5,
    build: (ctx, k) => fair(ctx, k, { wheel: true, rangoli: true, seed: 100 }),
  },
  market_square: {
    horizon: 0.56,
    horizonPortrait: 0.5,
    hillScale: 1,
    hillSeed: 0.4,
    path: 'lane',
    pathX: 0.5,
    build: (ctx, k) => fair(ctx, k, { wheel: true, rangoli: false, seed: 200 }),
  },
  hub: {
    horizon: 0.55,
    horizonPortrait: 0.5,
    hillScale: 0.9,
    hillSeed: 0.8,
    path: 'lane',
    pathX: 0.5,
    build: (ctx, k) => fair(ctx, k, { wheel: true, rangoli: false, seed: 300 }),
  },
  stall_front: {
    horizon: 0.5,
    horizonPortrait: 0.46,
    hillScale: 0.8,
    hillSeed: 1.3,
    path: 'none',
    pathX: 0.5,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L } = ctx;
      k.temple(L.far, k.x(0.72), ctx.ridgeY('far', k.x(0.72)) + H * 0.02, H * 0.16);
      k.treeLine(L.far, 9, 'far', H * 0.07, 403);
      k.ferrisWheel(L.farMid, k.x(0.2), k.groundY(0.03), H * 0.12);
      // Out-of-focus fair behind (depth of field: back row baked blurred).
      const goods: StallGoods[] = ['fruit', 'pots', 'bangles', 'fabric', 'sweets', 'toys'];
      const span = W + ctx.margin * 2;
      for (let i = 0; i < 7; i++) {
        const x = -ctx.margin + (span / 7) * (i + 0.5);
        const built = drawStall(
          {
            goods: goods[i % goods.length] ?? 'fruit',
            stripeA: AWNING_COLOURWAYS[i % 7]?.[0] ?? MELA.saffron,
            stripeB: AWNING_COLOURWAYS[i % 7]?.[1] ?? MELA.cream,
            cloth: MELA.kumkum,
            seed: 410 + i,
          },
          1,
        );
        const s = ctx.cache.bake(`dofstall:${i}`, () => built.view, { blur: 5 });
        const sc = k.scaleAt(0.16);
        s.scale.set(sc);
        s.position.set(x, k.groundY(0.16));
        L.mid.art.addChild(s);
        for (const l of built.lights)
          ctx.addGlow(L.mid, x + l.x * sc, k.groundY(0.16) + l.y * sc, l.r * sc * 1.6, l.color, {
            threshold: 0.1,
          });
      }
      k.tree(L.mid, 'neem', k.x(0.06), k.groundY(0.2), H * 0.36, 421);
      k.crowd(L.mid, 0.18, 0.4, 18, 461, { blur: 3, laneHalf: 0 });
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.3,
        W + ctx.margin,
        H * 0.28,
        H * 0.06,
        5 * u,
        431,
      );
      // Our own stall: big awning across the top and a carved counter across the bottom.
      const awn = new Graphics();
      const aH = H * 0.17;
      const stripes = Math.round(W / (90 * u));
      const sw = (W + ctx.margin * 2) / stripes;
      for (let i = 0; i < stripes; i++)
        awn.rect(-ctx.margin + i * sw, 0, sw, aH).fill(i % 2 === 0 ? MELA.peacock : MELA.cream);
      awn
        .rect(-ctx.margin, 0, W + ctx.margin * 2, aH * 0.35)
        .fill({ color: 0x000000, alpha: 0.18 });
      const scall = Math.round(W / (120 * u));
      const scw = (W + ctx.margin * 2) / scall;
      for (let i = 0; i < scall; i++) {
        const x0 = -ctx.margin + i * scw;
        awn
          .moveTo(x0, aH)
          .quadraticCurveTo(x0 + scw / 2, aH + 46 * u, x0 + scw, aH)
          .closePath()
          .fill(i % 2 === 0 ? MELA.marigold : MELA.vermilion);
        awn
          .moveTo(x0, aH)
          .quadraticCurveTo(x0 + scw / 2, aH + 46 * u, x0 + scw, aH)
          .stroke({ width: 4 * u, color: MELA.brass });
        awn
          .moveTo(x0 + scw, aH)
          .lineTo(x0 + scw, aH + 30 * u)
          .stroke({ width: 2.5 * u, color: MELA.brass });
        awn.circle(x0 + scw, aH + 36 * u, 7 * u).fill(MELA.vermilion);
      }
      awn.rect(-ctx.margin, aH - 4 * u, W + ctx.margin * 2, 8 * u).fill(MELA.brass);
      const awnS = ctx.cache.bake(`stallfront:awning:${Math.round(W)}x${Math.round(H)}`, () => awn);
      L.front.art.addChild(awnS);
      // Garland swag under the awning.
      const gar = new Graphics();
      const swag = catenary(-ctx.margin, aH + 12 * u, W + ctx.margin, aH + 12 * u, 50 * u, 60);
      for (let i = 0; i < swag.length; i++) {
        const p = swag[i];
        if (p)
          gar
            .circle(p.x, p.y, 9 * u)
            .fill(i % 3 === 0 ? MELA.vermilion : i % 2 === 0 ? MELA.marigold : MELA.saffron);
      }
      L.front.art.addChild(ctx.cache.bake(`stallfront:garland:${Math.round(W)}`, () => gar));
      for (const fx of [0.18, 0.82]) {
        ctx.addGlow(L.front, W * fx, aH + 70 * u, 120 * u, 0xffb347, {
          threshold: 0.1,
          flicker: 0.08,
        });
      }
      const cTop = H * (ctx.portrait ? 0.8 : 0.76);
      const counter = ctx.cache.bake(`stallfront:counter:${Math.round(W)}x${Math.round(H)}`, () =>
        drawCounter(W + ctx.margin * 2, H - cTop + 10 * u, u),
      );
      counter.position.set(-ctx.margin, cTop);
      L.front.art.addChild(counter);
      // Goods only at the sides, the centre stays clear for play.
      const gl = ctx.cache.bake(`stallfront:goodsL:${Math.round(W)}`, () =>
        drawGoodsRow('spice', W * 0.26, u * 1.2, 441),
      );
      gl.position.set(W * 0.0, cTop + 4 * u);
      const gr = ctx.cache.bake(`stallfront:goodsR:${Math.round(W)}`, () =>
        drawGoodsRow('sweets', W * 0.24, u * 1.2, 442),
      );
      gr.position.set(W * 0.76, cTop + 4 * u);
      L.front.art.addChild(gl, gr);
    },
  },
  weighing_post: {
    horizon: 0.58,
    horizonPortrait: 0.52,
    hillScale: 1.1,
    hillSeed: 2.1,
    path: 'lane',
    pathX: 0.62,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L, portrait } = ctx;
      k.temple(L.far, k.x(0.3), ctx.ridgeY('far', k.x(0.3)) + H * 0.02, H * 0.15);
      k.treeLine(L.far, 12, 'far', H * 0.07, 503);
      // Golden fields on the slopes.
      const fields = new Graphics();
      const span = W + ctx.margin * 2;
      const fr = new ArtRandom(505);
      for (let i = 0; i < 10; i++) {
        const fx = -ctx.margin + fr.range(0, span);
        const fy = k.groundY(fr.range(0.02, 0.12));
        drawField(
          fields,
          fx,
          fy,
          fr.range(120, 260) * u,
          fr.range(14, 30) * u,
          fr.pick([0xd9b04a, 0xb8c25a, 0xe6c46a, 0x9fb04e]),
          4,
        );
      }
      L.farMid.art.addChild(
        ctx.cache.bake(`wp:fields:${Math.round(W)}x${Math.round(H)}`, () => fields),
      );
      k.stallRow(L.mid, 0.09, portrait ? 6 : 10, 507, 0.3);
      k.crowd(L.mid, 0.1, 0.3, portrait ? 10 : 18, 561);
      // The weighing post itself, left of centre.
      const wp = drawWeighingPost(H * (portrait ? 0.2 : 0.3), 509);
      const wpx = k.x(portrait ? 0.24 : 0.2);
      const wpy = k.groundY(0.38);
      const base = ctx.cache.bake(`wp:post:${Math.round(H)}`, () => {
        wp.view.removeChild(wp.balance);
        return wp.view;
      });
      base.position.set(wpx, wpy);
      L.mid.art.addChild(base);
      const bal = ctx.cache.bake(`wp:balance:${Math.round(H)}`, () => {
        wp.balance.position.set(0, 0);
        return wp.balance;
      });
      const balHolder = new Container();
      balHolder.position.set(wpx + wp.balancePivot.x, wpy + wp.balancePivot.y);
      balHolder.addChild(bal);
      L.mid.art.addChild(balHolder);
      ctx.addAnimator((t) => {
        balHolder.rotation = Math.sin(t * 0.7) * 0.02 * ctx.quality.motionScale;
      });
      for (const l of wp.lights)
        ctx.addGlow(L.mid, wpx + l.x, wpy + l.y, l.r * 1.4, l.color, {
          threshold: 0.1,
          flicker: 0.08,
        });
      k.tree(
        L.mid,
        'banyan',
        k.x(portrait ? 0.95 : 0.9),
        k.groundY(0.33),
        H * (portrait ? 0.17 : 0.27),
        511,
      );
      k.bunting(L.strings, -ctx.margin, H * 0.14, W + ctx.margin, H * 0.13, H * 0.08, 28 * u, 521);
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.22,
        W + ctx.margin,
        H * 0.2,
        H * 0.08,
        5 * u,
        522,
      );
      k.diyaArc(L.front, W * 0.9, H * 0.95, W * 0.05, H * 0.012, 3, u * 1.1);
      k.tufts(L.front, W * 0.03, H, 100 * u, 531, 2 * u);
      k.tufts(L.front, W * 0.97, H, 90 * u, 532, 2 * u);
      k.toran(L.front);
    },
  },
  road_home: {
    horizon: 0.55,
    horizonPortrait: 0.5,
    hillScale: 1.25,
    hillSeed: 3.3,
    path: 'road',
    pathX: 0.48,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L, portrait } = ctx;
      // Size reference: portrait screens are tall, so props scale with the width there.
      const S = portrait ? W * 1.05 : H;
      k.temple(L.far, k.x(0.82), ctx.ridgeY('far', k.x(0.82)) + H * 0.02, H * 0.14);
      // Village on the far slope with windows that light up.
      const vr = new ArtRandom(603);
      for (let i = 0; i < (portrait ? 6 : 10); i++) {
        const hx = k.x(0.1 + vr.range(0, 0.55));
        k.house(L.far, hx, ctx.ridgeY('mid', hx) + H * 0.03, H * vr.range(0.05, 0.075), 610 + i);
      }
      k.treeLine(L.far, 10, 'far', H * 0.07, 605);
      // Fields either side of the road.
      const fields = new Graphics();
      const fr = new ArtRandom(607);
      for (let i = 0; i < 14; i++) {
        const d = fr.range(0.04, 0.3);
        const side = fr.chance(0.5) ? -1 : 1;
        const fx = W * 0.5 + side * fr.range(0.12, 0.55) * W - 120 * u;
        drawField(
          fields,
          fx,
          k.groundY(d),
          fr.range(160, 320) * u * (0.4 + d),
          fr.range(18, 40) * u * (0.4 + d * 2),
          fr.pick([0xc9b45a, 0x8fae4e, 0xd8a85a, 0x7fa04a]),
          5,
        );
      }
      L.farMid.art.addChild(
        ctx.cache.bake(`road:fields:${Math.round(W)}x${Math.round(H)}`, () => fields),
      );
      k.treeLine(L.farMid, 6, 'near', H * 0.12, 609);
      k.tree(L.mid, 'palm', k.x(0.12), k.groundY(0.3), S * 0.42, 621);
      k.tree(L.mid, 'neem', k.x(0.86), k.groundY(0.34), S * 0.44, 623);
      k.tree(L.mid, 'banyan', k.x(portrait ? 1.02 : 0.98), k.groundY(0.5), S * 0.24, 625);
      // Lamp posts along the road.
      const posts = [
        { f: 0.4, d: 0.1 },
        { f: 0.62, d: 0.22 },
        { f: 0.3, d: 0.42 },
        { f: 0.78, d: 0.6 },
      ];
      posts.forEach((p, i) => {
        k.lampPost(
          i < 2 ? L.mid : L.near,
          k.x(p.f),
          k.groundY(p.d),
          S * 0.36 * (0.35 + p.d),
          i % 2 === 0 ? MELA.marigold : MELA.vermilion,
        );
      });
      const cart = ctx.cache.bake(`road:cart`, () => drawCart(300));
      cart.scale.set(k.scaleAt(0.5));
      cart.position.set(k.x(0.18), k.groundY(0.5));
      L.near.art.addChild(cart);
      k.bunting(L.strings, k.x(0.12), H * 0.3, k.x(0.86), H * 0.34, H * 0.06, 22 * u, 641);
      k.diyaArc(L.front, W * 0.1, H * 0.96, W * 0.06, H * 0.01, 3, u * 1.1);
      k.diyaArc(L.front, W * 0.9, H * 0.96, W * 0.06, H * 0.01, 3, u * 1.1);
      k.tufts(L.front, W * 0.02, H, 110 * u, 651, 2 * u);
      k.tufts(L.front, W * 0.98, H, 110 * u, 652, 2 * u);
    },
  },
  tower_courtyard: {
    horizon: 0.5,
    horizonPortrait: 0.46,
    hillScale: 0.8,
    hillSeed: 4.4,
    path: 'none',
    pathX: 0.5,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L } = ctx;
      k.treeLine(L.far, 10, 'far', H * 0.07, 703);
      k.temple(L.farMid, k.x(0.66), k.groundY(0.08), H * 0.34);
      // Stone paving in perspective.
      const pave = new Graphics();
      const top = k.groundY(0.12);
      pave.rect(-ctx.margin, top, W + ctx.margin * 2, H - top).fill(
        vgrad([
          [0, 0xd9c4a0],
          [1, 0xb89a74],
        ]),
      );
      const vpX = W / 2;
      for (let i = -12; i <= 12; i++) {
        pave
          .moveTo(vpX + i * W * 0.012, top)
          .lineTo(vpX + i * W * 0.16, H)
          .stroke({ width: 2 * u, color: 0x9a7f5c, alpha: 0.55 });
      }
      for (let j = 1; j < 10; j++) {
        const y = top + (H - top) * (j / 10) ** 1.6;
        pave
          .moveTo(-ctx.margin, y)
          .lineTo(W + ctx.margin, y)
          .stroke({ width: 2 * u, color: 0x9a7f5c, alpha: 0.5 });
      }
      L.mid.art.addChild(
        ctx.cache.bake(`court:pave:${Math.round(W)}x${Math.round(H)}`, () => pave),
      );
      k.tree(L.mid, 'neem', k.x(0.1), k.groundY(0.3), H * 0.44, 711);
      const tul = ctx.cache.bake('court:tulsi', () => drawTulsi(120, 713));
      tul.scale.set(u);
      tul.position.set(k.x(0.86), k.groundY(0.42));
      L.near.art.addChild(tul);
      k.bunting(L.strings, -ctx.margin, H * 0.14, W + ctx.margin, H * 0.15, H * 0.07, 26 * u, 721);
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.22,
        W + ctx.margin,
        H * 0.22,
        H * 0.07,
        5 * u,
        722,
      );
      k.diyaArc(L.front, W * 0.5, H * 0.97, W * 0.42, H * 0.02, 7, u);
      k.toran(L.front);
    },
  },
  balloon_fair: {
    horizon: 0.56,
    horizonPortrait: 0.5,
    hillScale: 1,
    hillSeed: 5.5,
    path: 'lane',
    pathX: 0.55,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L, portrait } = ctx;
      k.temple(L.far, k.x(0.84), ctx.ridgeY('far', k.x(0.84)) + H * 0.02, H * 0.15);
      k.treeLine(L.far, 11, 'far', H * 0.07, 803);
      k.ferrisWheel(
        L.farMid,
        k.x(portrait ? 0.3 : 0.3),
        k.groundY(0.06),
        H * (portrait ? 0.16 : 0.24),
      );
      k.stallRow(L.mid, 0.1, portrait ? 6 : 11, 805, 0.2);
      k.crowd(L.mid, 0.11, 0.32, portrait ? 12 : 22, 861);
      k.tree(L.mid, 'neem', k.x(0.95), k.groundY(0.3), H * 0.4, 811);
      const bunch = ctx.cache.bake('balloon:bunch', () => drawBalloonBunch(1, 813));
      const holder = new Container();
      holder.addChild(bunch);
      holder.position.set(k.x(portrait ? 0.86 : 0.84), k.groundY(0.42));
      holder.scale.set(k.scaleAt(0.42) * 1.1);
      L.mid.art.addChild(holder);
      const pole = new Graphics();
      pole.rect(-3 * u, 0, 6 * u, k.groundY(0.5) - k.groundY(0.42)).fill(MELA.woodDark);
      pole.position.set(holder.x, holder.y);
      L.mid.art.addChild(pole);
      ctx.addAnimator((t) => {
        holder.rotation = Math.sin(t * 0.9) * 0.03 * ctx.quality.motionScale;
      });
      k.bunting(L.strings, -ctx.margin, H * 0.15, W + ctx.margin, H * 0.12, H * 0.08, 30 * u, 821);
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.24,
        W + ctx.margin,
        H * 0.25,
        H * 0.08,
        5 * u,
        822,
      );
      k.diyaArc(L.front, W * 0.08, H * 0.95, W * 0.05, H * 0.015, 3, u * 1.1);
      k.tufts(L.front, W * 0.02, H, 90 * u, 831, 2 * u);
      k.tufts(L.front, W * 0.98, H, 100 * u, 832, 2 * u);
      k.toran(L.front);
    },
  },
  card_tent: {
    horizon: 0.55,
    horizonPortrait: 0.5,
    hillScale: 0.9,
    hillSeed: 6.6,
    path: 'none',
    pathX: 0.5,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L } = ctx;
      k.treeLine(L.far, 10, 'far', H * 0.07, 903);
      k.stallRow(L.mid, 0.1, 10, 905);
      k.crowd(L.mid, 0.11, 0.3, 14, 961, { blur: 1.5 });
      // Rug on the ground in perspective.
      const rug = new Graphics();
      const rt = k.groundY(0.35);
      rug
        .poly([W * 0.24, rt, W * 0.76, rt, W * 0.96, H * 1.02, W * 0.04, H * 1.02])
        .fill(MELA.kumkum);
      rug
        .poly([
          W * 0.26,
          rt + 10 * u,
          W * 0.74,
          rt + 10 * u,
          W * 0.92,
          H * 0.99,
          W * 0.08,
          H * 0.99,
        ])
        .stroke({ width: 8 * u, color: MELA.marigold });
      rug
        .poly([W * 0.3, rt + 26 * u, W * 0.7, rt + 26 * u, W * 0.85, H * 0.96, W * 0.15, H * 0.96])
        .fill(darken(MELA.kumkum, 0.2));
      rug
        .ellipse(W / 2, (rt + H) / 2, W * 0.16, (H - rt) * 0.2)
        .stroke({ width: 6 * u, color: MELA.marigold });
      L.near.art.addChild(ctx.cache.bake(`tent:rug:${Math.round(W)}x${Math.round(H)}`, () => rug));
      L.front.art.addChild(
        ctx.cache.bake(`tent:drape:${Math.round(W)}x${Math.round(H)}`, () =>
          drawTentDrape(W, H, u),
        ),
      );
      for (const fx of [0.25, 0.5, 0.75])
        ctx.addGlow(L.front, W * fx, H * 0.22, 140 * u, 0xffb347, {
          threshold: 0,
          flicker: 0.06,
          alpha: 0.55,
        });
    },
  },
  share_circle: {
    horizon: 0.56,
    horizonPortrait: 0.5,
    hillScale: 1,
    hillSeed: 7.7,
    path: 'none',
    pathX: 0.5,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L, portrait } = ctx;
      k.temple(L.far, k.x(0.15), ctx.ridgeY('far', k.x(0.15)) + H * 0.02, H * 0.14);
      k.treeLine(L.far, 12, 'far', H * 0.07, 1003);
      k.stallRow(L.farMid, 0.06, portrait ? 7 : 12, 1005);
      k.crowd(L.farMid, 0.07, 0.2, portrait ? 8 : 14, 1061);
      const cx = W / 2;
      const cy = k.groundY(0.38);
      const ch = ctx.cache.bake(`share:chabutra:${Math.round(H)}`, () => drawChabutra(H * 0.26));
      ch.position.set(cx, cy);
      k.tree(L.mid, 'banyan', cx, cy - H * 0.06, H * (portrait ? 0.2 : 0.3), 1011);
      L.mid.art.addChild(ch);
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.2,
        W + ctx.margin,
        H * 0.22,
        H * 0.08,
        5 * u,
        1022,
      );
      k.diyaArc(L.near, cx, cy + H * 0.01, H * 0.26, H * 0.07, 9, u * 0.9, 0.1, Math.PI - 0.1);
      k.toran(L.front);
    },
  },
  report: {
    horizon: 0.56,
    horizonPortrait: 0.5,
    hillScale: 1,
    hillSeed: 8.8,
    path: 'none',
    pathX: 0.5,
    build: (ctx, k) => {
      const { width: W, height: H, u, layers: L, portrait } = ctx;
      const tx = k.x(0.5);
      k.temple(L.far, tx, ctx.ridgeY('far', tx) + H * 0.02, H * 0.2);
      k.treeLine(L.far, 12, 'far', H * 0.07, 1103);
      k.ferrisWheel(L.farMid, k.x(0.86), k.groundY(0.05), H * 0.13);
      k.stallRow(L.mid, 0.1, portrait ? 7 : 12, 1105, 0.25);
      k.crowd(L.mid, 0.11, 0.28, portrait ? 8 : 14, 1161);
      k.tree(L.mid, 'banyan', k.x(0.06), k.groundY(0.3), H * 0.26, 1111);
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.18,
        W + ctx.margin,
        H * 0.16,
        H * 0.08,
        5 * u,
        1121,
      );
      k.stringLights(
        L.strings,
        -ctx.margin,
        H * 0.27,
        W + ctx.margin,
        H * 0.28,
        H * 0.07,
        5 * u,
        1122,
      );
      k.rangoli(L.near, W / 2, k.groundY(0.7), Math.min(W, H) * 0.22);
      k.diyaArc(
        L.near,
        W / 2,
        k.groundY(0.7),
        Math.min(W, H) * 0.27,
        Math.min(W, H) * 0.095,
        12,
        u * 0.9,
        0,
        Math.PI * 2 - (Math.PI * 2) / 12,
      );
      // Sky lanterns drifting upwards.
      const lr = new ArtRandom(1131);
      const lanterns: { c: Container; vy: number; phase: number; x0: number }[] = [];
      for (let i = 0; i < 9; i++) {
        const sl = drawSkyLantern(40 * u * lr.range(0.6, 1.1));
        const c = new Container();
        c.addChild(sl.view);
        const x0 = lr.range(0, W);
        c.position.set(x0, lr.range(H * 0.05, ctx.horizonY));
        L.farMid.art.addChild(c);
        const glow = ctx.addGlow(L.farMid, c.x, c.y, (sl.lights[0]?.r ?? 60) * 1.2, 0xffa347, {
          threshold: 0,
          flicker: 0.1,
          alpha: 0.7,
        });
        lanterns.push({ c, vy: lr.range(6, 14) * u, phase: lr.range(0, 6), x0 });
        ctx.addAnimator((t, dt) => {
          const l = lanterns[i];
          if (!l) return;
          l.c.y -= l.vy * dt * ctx.quality.motionScale;
          l.c.x = l.x0 + Math.sin(t * 0.3 + l.phase) * 20 * u;
          if (l.c.y < -60 * u) l.c.y = ctx.horizonY;
          glow.position.set(l.c.x, l.c.y - 12 * u);
        });
      }
      k.toran(L.front);
    },
  },
};

/** Build a scene into the context's layers. */
export function buildScene(ctx: SceneBuildContext, recipe: SceneRecipe): void {
  recipe.build(ctx, new SceneKit(ctx));
}

/** Utility for scene previews: palette-free swatch of the scene's dominant colours. */
export function sceneAccent(sceneId: SceneId): number {
  const m: Record<SceneId, number> = {
    attract: MELA.marigold,
    market_square: MELA.saffron,
    hub: MELA.turmeric,
    stall_front: MELA.peacock,
    weighing_post: MELA.brass,
    road_home: MELA.indigo,
    tower_courtyard: MELA.sandstone,
    balloon_fair: MELA.rose,
    card_tent: MELA.kumkum,
    share_circle: MELA.banyan,
    report: lighten(MELA.indigo, 0.2),
  };
  return mixColor(m[sceneId], MELA.cream, 0.1);
}
