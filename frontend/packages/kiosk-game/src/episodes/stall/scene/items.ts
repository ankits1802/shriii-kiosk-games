/**
 * The stall's goods, fresh and spoiled, as original procedural vector art (no images, no text).
 *
 * Every item is drawn centred on (0, 0) inside a nominal 100 x 100 box. Spoiled items differ from fresh
 * ones by SHAPE as well as colour (KSK-06: colour is never the only cue): dark irregular rot patches,
 * mould fuzz, wrinkles and a sagging silhouette, plus the animated {@link FlySwarm} and stink wisps added
 * by the scene. The fresh/spoiled contrast stays clear under protanopia/deuteranopia simulation because
 * the cues are luminance and shape based.
 */
import { Container, Graphics, type Ticker } from 'pixi.js';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { lgrad, rgrad, smoothPath, softShadow } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { StallItem } from '../schedule.ts';

/** Desaturate and brown a colour for spoiled food (luminance drops too, not just hue). */
function rot(c: number, k = 0.62): number {
  return darken(mixColor(c, 0x5b4a2a, k), 0.18);
}

function shaded(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  c: number,
  light = { x: 0.36, y: 0.3 },
): void {
  g.ellipse(x, y, rx, ry).fill(
    rgrad(
      [
        [0, lighten(c, 0.42)],
        [0.45, c],
        [1, darken(c, 0.38)],
      ],
      light,
      0.8,
    ),
  );
}

/** Irregular dark rot patch (a blobby polygon) with a darker core. */
function rotPatch(
  g: Graphics,
  x: number,
  y: number,
  r: number,
  rnd: ArtRandom,
  base = 0x3b2a16,
): void {
  const pts: { x: number; y: number }[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * rnd.range(0.65, 1.15);
    pts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr * 0.85 });
  }
  smoothPath(g, pts, true).fill({ color: base, alpha: 0.88 });
  g.ellipse(x - r * 0.1, y - r * 0.05, r * 0.45, r * 0.38).fill({
    color: darken(base, 0.4),
    alpha: 0.9,
  });
  // Wet sheen on the bruise (reads as soft rot).
  g.ellipse(x - r * 0.35, y - r * 0.35, r * 0.18, r * 0.1).fill({ color: 0xffffff, alpha: 0.12 });
}

/** Mould fuzz: clusters of pale dots with a soft halo. */
function mould(g: Graphics, x: number, y: number, r: number, rnd: ArtRandom): void {
  g.circle(x, y, r * 1.1).fill({ color: 0xc9d3b0, alpha: 0.22 });
  for (let i = 0; i < 14; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = r * Math.sqrt(rnd.next());
    g.circle(x + Math.cos(a) * d, y + Math.sin(a) * d, r * rnd.range(0.12, 0.26)).fill({
      color: rnd.chance(0.5) ? 0xdfe6cf : 0xa9b78e,
      alpha: 0.9,
    });
  }
}

/** Wrinkle strokes (shrivelled skin). */
function wrinkles(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  rnd: ArtRandom,
  color = 0x2a1d0e,
): void {
  for (let i = 0; i < 4; i++) {
    const yy = y + rnd.range(-w * 0.4, w * 0.4);
    const xx = x + rnd.range(-w * 0.3, w * 0.3);
    g.moveTo(xx - w * 0.22, yy)
      .quadraticCurveTo(xx, yy - w * 0.08, xx + w * 0.22, yy + w * 0.03)
      .stroke({ width: 1.6, color, alpha: 0.45, cap: 'round' });
  }
}

function leaf(g: Graphics, x: number, y: number, len: number, angle: number, color: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const p = (px: number, py: number): [number, number] => [
    x + px * c - py * s,
    y + px * s + py * c,
  ];
  const w = len * 0.32;
  const [ax, ay] = p(0, 0);
  const [b1x, b1y] = p(len * 0.35, -w);
  const [b2x, b2y] = p(len * 0.8, -w * 0.6);
  const [tx, ty] = p(len, 0);
  const [c1x, c1y] = p(len * 0.8, w * 0.6);
  const [c2x, c2y] = p(len * 0.35, w);
  g.moveTo(ax, ay)
    .bezierCurveTo(b1x, b1y, b2x, b2y, tx, ty)
    .bezierCurveTo(c1x, c1y, c2x, c2y, ax, ay)
    .fill(
      lgrad({ x: 0, y: 0 }, { x: 1, y: 1 }, [
        [0, lighten(color, 0.25)],
        [1, darken(color, 0.2)],
      ]),
    );
  const [mx, my] = p(len * 0.92, 0);
  g.moveTo(ax, ay)
    .lineTo(mx, my)
    .stroke({ width: 1.4, color: lighten(color, 0.35), alpha: 0.7 });
}

function drawMango(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const body = spoiled ? rot(0xf2a33a, 0.55) : 0xf6b13a;
  const blush = spoiled ? rot(0xd9542b, 0.6) : 0xe2552d;
  const sag = spoiled ? 0.9 : 1;
  // Kidney-shaped mango, tilted, with the characteristic beak low on one side.
  const raw = [
    { x: -6, y: -46 },
    { x: 16, y: -40 },
    { x: 30, y: -18 },
    { x: 32, y: 10 },
    { x: 30, y: 32 },
    { x: 18, y: 44 },
    { x: 2, y: 46 },
    { x: -14, y: 36 },
    { x: -22, y: 14 },
    { x: -26, y: -12 },
    { x: -22, y: -34 },
  ];
  const tilt = 0.55;
  const pts = raw.map((p) => ({
    x: (p.x * Math.cos(tilt) - p.y * Math.sin(tilt)) * 1.05,
    y: (p.x * Math.sin(tilt) + p.y * Math.cos(tilt)) * sag * 0.9,
  }));
  smoothPath(g, pts, true).fill(
    rgrad(
      [
        [0, lighten(body, 0.45)],
        [0.5, body],
        [1, darken(body, 0.3)],
      ],
      { x: 0.35, y: 0.3 },
      0.85,
    ),
  );
  // Ripe blush on the shoulder.
  g.ellipse(14, -22, 20, 15).fill({ color: blush, alpha: spoiled ? 0.3 : 0.6 });
  g.ellipse(18, -28, 9, 5).fill({ color: 0xffffff, alpha: spoiled ? 0.08 : 0.4 });
  // Stem and leaf at the shoulder.
  g.moveTo(18, -38 * sag)
    .quadraticCurveTo(22, -46, 28, -50)
    .stroke({ width: 4, color: 0x5b3a1e, cap: 'round' });
  leaf(g, 26, -48, 34, -0.15, spoiled ? 0x7a6a3a : MELA.neem);
  if (spoiled) {
    rotPatch(g, -14, 10, 15, rnd);
    rotPatch(g, 18, 18, 10, rnd);
    rotPatch(g, 6, -18, 7, rnd);
    mould(g, -18, 12, 7, rnd);
    wrinkles(g, 0, 4, 48, rnd);
  }
}

function drawBanana(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const skin = spoiled ? 0x6b5426 : 0xf7d23e;
  const edge = spoiled ? 0x2e2210 : 0xc9a020;
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 14;
    const droop = spoiled ? 8 : 0;
    g.moveTo(-36 + off * 0.3, -24 + off)
      .bezierCurveTo(-30, 26 + off + droop, 24, 36 + off + droop, 44, 6 + off + droop)
      .bezierCurveTo(30, 22 + off + droop, -14, 16 + off + droop, -26 + off * 0.3, -28 + off)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
          [0, lighten(skin, 0.3)],
          [0.6, skin],
          [1, darken(skin, 0.25)],
        ]),
      )
      .stroke({ width: 1.6, color: edge, alpha: 0.8 });
    // Tips.
    g.circle(44, 6 + off + droop, 3.4).fill(0x3a2a14);
    if (spoiled) {
      for (let k = 0; k < 6; k++) {
        const t = rnd.range(0.15, 0.9);
        const px = -30 + t * 72;
        const py = -10 + off + t * 26 + droop * t;
        g.ellipse(px, py, rnd.range(3, 7), rnd.range(2, 4)).fill({ color: 0x1e150a, alpha: 0.85 });
      }
    } else {
      g.moveTo(-20, -10 + off)
        .quadraticCurveTo(4, 14 + off, 30, 12 + off)
        .stroke({
          width: 1.2,
          color: 0xffffff,
          alpha: 0.45,
        });
    }
  }
  // Stem crown.
  g.roundRect(-44, -36, 16, 14, 4).fill(spoiled ? 0x3e3018 : 0x7a8f3a);
  if (spoiled) {
    mould(g, -34, -26, 7, rnd);
    wrinkles(g, 4, 14, 44, rnd);
  }
}

function drawLaddoo(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const c = spoiled ? rot(0xf29a2e, 0.55) : 0xf2a02e;
  const balls = [
    { x: -22, y: 18, r: 22 },
    { x: 22, y: 18, r: 22 },
    { x: 0, y: -16, r: 22 },
  ];
  softShadow(g, 0, 40, 48, 8, 0x000000, 0.25);
  for (const b of balls) {
    shaded(g, b.x, b.y, b.r, b.r * (spoiled ? 0.9 : 1), c);
    // Boondi texture: tiny pearls.
    for (let i = 0; i < 22; i++) {
      const a = rnd.range(0, Math.PI * 2);
      const d = b.r * 0.85 * Math.sqrt(rnd.next());
      g.circle(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d * 0.95, 2.2).fill({
        color: lighten(c, 0.3),
        alpha: spoiled ? 0.25 : 0.6,
      });
    }
    g.ellipse(b.x - b.r * 0.35, b.y - b.r * 0.4, b.r * 0.28, b.r * 0.16).fill({
      color: 0xffffff,
      alpha: spoiled ? 0.06 : 0.35,
    });
  }
  // Cashew and silver leaf on top.
  g.ellipse(2, -34, 7, 4).fill(spoiled ? 0x6d5c3a : 0xf4e3c0);
  if (spoiled) {
    mould(g, -14, 10, 9, rnd);
    mould(g, 10, -18, 8, rnd);
    rotPatch(g, 24, 22, 8, rnd, 0x4a3a20);
    // Crumbs falling off.
    for (let i = 0; i < 5; i++)
      g.circle(rnd.range(-36, 36), rnd.range(38, 46), 2).fill(darken(c, 0.2));
  } else {
    g.rect(-4, -40, 9, 5).fill({ color: 0xeeeeee, alpha: 0.85 });
  }
}

function drawJalebi(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const c = spoiled ? rot(0xf08a1c, 0.6) : 0xf28a1a;
  const gloss = spoiled ? 0.08 : 0.55;
  const spiral = (cx: number, cy: number, r: number): void => {
    const pts: { x: number; y: number }[] = [];
    for (let t = 0; t <= Math.PI * 5.2; t += 0.18) {
      const rr = r * (0.15 + t / (Math.PI * 5.2)) * (spoiled ? 0.95 : 1);
      pts.push({ x: cx + Math.cos(t) * rr, y: cy + Math.sin(t) * rr * 0.82 });
    }
    smoothPath(g, pts).stroke({ width: 7.5, color: darken(c, 0.25), cap: 'round', join: 'round' });
    smoothPath(g, pts).stroke({ width: 5.5, color: c, cap: 'round', join: 'round' });
    smoothPath(g, pts).stroke({ width: 1.6, color: 0xffffff, alpha: gloss, cap: 'round' });
  };
  softShadow(g, 0, 40, 46, 8, 0x000000, 0.22);
  spiral(-18, 14, 26);
  spiral(20, 18, 24);
  spiral(0, -14, 26);
  if (spoiled) {
    mould(g, -10, 8, 8, rnd);
    mould(g, 18, -10, 7, rnd);
    // Ants: tiny dark segmented bodies in a trail.
    for (let i = 0; i < 7; i++) {
      const x = -40 + i * 11 + rnd.range(-2, 2);
      const y = 38 - i * 5 + rnd.range(-2, 2);
      g.circle(x, y, 1.7).fill(0x140c06);
      g.circle(x + 2.6, y - 0.8, 1.3).fill(0x140c06);
    }
  }
}

function drawSamosa(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const c = spoiled ? 0x4a3218 : 0xd99a3c;
  const tri = (cx: number, cy: number, s: number, tilt: number): void => {
    const p = (x: number, y: number): { x: number; y: number } => ({
      x: cx + x * Math.cos(tilt) - y * Math.sin(tilt),
      y: cy + x * Math.sin(tilt) + y * Math.cos(tilt),
    });
    const a = p(0, -s);
    const b = p(s * 0.95, s * 0.6);
    const d = p(-s * 0.95, s * 0.6);
    g.moveTo(a.x, a.y)
      .quadraticCurveTo((a.x + b.x) / 2 + 4, (a.y + b.y) / 2, b.x, b.y)
      .quadraticCurveTo((b.x + d.x) / 2, (b.y + d.y) / 2 + 6, d.x, d.y)
      .quadraticCurveTo((d.x + a.x) / 2 - 4, (d.y + a.y) / 2, a.x, a.y)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0.3, y: 1 }, [
          [0, lighten(c, 0.35)],
          [0.6, c],
          [1, darken(c, 0.3)],
        ]),
      );
    // Crimped seam.
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      g.circle(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.2).fill(darken(c, 0.25));
    }
    // Blisters on fried pastry.
    for (let i = 0; i < 7; i++) {
      const u = rnd.next();
      const v = rnd.next() * (1 - u);
      const x = a.x + (b.x - a.x) * u + (d.x - a.x) * v;
      const y = a.y + (b.y - a.y) * u + (d.y - a.y) * v;
      g.circle(x, y, rnd.range(1.6, 3)).fill({
        color: lighten(c, 0.4),
        alpha: spoiled ? 0.15 : 0.55,
      });
    }
  };
  softShadow(g, 0, 40, 46, 8, 0x000000, 0.24);
  tri(-16, 10, 30, -0.15);
  tri(18, 6, 30, 0.2);
  if (spoiled) {
    // Charred patches and mould.
    rotPatch(g, -14, 14, 11, rnd, 0x140c06);
    rotPatch(g, 20, 2, 9, rnd, 0x140c06);
    mould(g, 4, 22, 9, rnd);
    wrinkles(g, 0, 10, 40, rnd, 0x0a0603);
  } else {
    // Mint chutney dab.
    g.ellipse(38, 34, 10, 5).fill(0x3d8b3a);
  }
}

function drawGuava(g: Graphics, spoiled: boolean, rnd: ArtRandom): void {
  const skin = spoiled ? rot(0x8fbf4a, 0.62) : 0x9ccc4f;
  const flesh = spoiled ? rot(0xf08a94, 0.55) : 0xf58f99;
  // Whole fruit behind.
  shaded(g, -12, -4, 32, 34 * (spoiled ? 0.88 : 1), skin);
  for (let i = 0; i < 16; i++) {
    g.circle(-12 + rnd.range(-24, 24), -4 + rnd.range(-26, 26), 1.4).fill({
      color: lighten(skin, 0.45),
      alpha: 0.6,
    });
  }
  g.moveTo(-12, -38).lineTo(-10, -48).stroke({ width: 3.4, color: 0x4b3420, cap: 'round' });
  leaf(g, -10, -46, 26, -0.6, spoiled ? 0x6e6436 : MELA.mango);
  // Cut half in front showing pink flesh and seeds.
  g.ellipse(18, 16, 26, 22).fill(skin);
  g.ellipse(18, 16, 22, 18).fill(
    rgrad(
      [
        [0, lighten(flesh, 0.3)],
        [0.6, flesh],
        [1, darken(flesh, 0.15)],
      ],
      { x: 0.5, y: 0.5 },
      0.6,
    ),
  );
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.circle(18 + Math.cos(a) * 9, 16 + Math.sin(a) * 7, 1.8).fill(spoiled ? 0x2e2414 : 0xf6e2b0);
  }
  if (spoiled) {
    rotPatch(g, -22, 6, 13, rnd);
    rotPatch(g, 26, 22, 8, rnd);
    mould(g, 10, 10, 8, rnd);
    wrinkles(g, -12, -4, 50, rnd);
  }
}

const DRAWERS: Readonly<
  Record<StallItem, (g: Graphics, spoiled: boolean, rnd: ArtRandom) => void>
> = {
  mango: drawMango,
  banana: drawBanana,
  laddoo: drawLaddoo,
  jalebi: drawJalebi,
  samosa: drawSamosa,
  guava: drawGuava,
};

/** Draw an item (centred, nominal 100 x 100) into a fresh Graphics. Deterministic per (item, spoiled). */
export function drawStallItem(item: StallItem, spoiled: boolean): Graphics {
  const g = new Graphics();
  DRAWERS[item](g, spoiled, new ArtRandom(`stall-item:${item}:${spoiled ? 's' : 'f'}`));
  return g;
}

/**
 * Animated flies buzzing around a spoiled item, plus rising stink wisps. Purely decorative motion
 * within the item's own area (never over other stimuli); honours reduced motion (still flies, no wisps).
 */
export class FlySwarm {
  readonly view = new Container();
  private readonly flies: {
    body: Container;
    wingA: Graphics;
    wingB: Graphics;
    phase: number;
    rx: number;
    ry: number;
    speed: number;
  }[] = [];
  private readonly wisps: { g: Graphics; phase: number }[] = [];
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.update(tk.deltaMS / 1000);

  constructor(
    private readonly ticker: Ticker,
    private readonly radius: number,
    private readonly reducedMotion: boolean,
    seed: string,
  ) {
    const rnd = new ArtRandom(seed);
    this.view.eventMode = 'none';
    for (let i = 0; i < 3; i++) {
      const wisp = new Graphics();
      const x0 = (i - 1) * radius * 0.42;
      wisp
        .moveTo(x0, 0)
        .bezierCurveTo(
          x0 + radius * 0.16,
          -radius * 0.18,
          x0 - radius * 0.16,
          -radius * 0.36,
          x0,
          -radius * 0.54,
        )
        .bezierCurveTo(
          x0 + radius * 0.16,
          -radius * 0.7,
          x0 - radius * 0.08,
          -radius * 0.82,
          x0 + radius * 0.04,
          -radius * 0.95,
        )
        .stroke({ width: Math.max(2, radius * 0.06), color: 0x7f8a5a, alpha: 0.75, cap: 'round' });
      wisp.position.set(0, -radius * 0.35);
      if (reducedMotion) wisp.alpha = 0.5;
      this.view.addChild(wisp);
      this.wisps.push({ g: wisp, phase: i / 3 });
    }
    const flyR = Math.max(3, radius * 0.07);
    for (let i = 0; i < 3; i++) {
      const body = new Container();
      const wingA = new Graphics()
        .ellipse(-flyR * 0.6, -flyR * 0.9, flyR * 0.75, flyR * 0.45)
        .fill({ color: 0xe8f4ff, alpha: 0.75 });
      const wingB = new Graphics()
        .ellipse(flyR * 0.6, -flyR * 0.9, flyR * 0.75, flyR * 0.45)
        .fill({ color: 0xe8f4ff, alpha: 0.75 });
      const g = new Graphics();
      g.ellipse(0, 0, flyR, flyR * 0.72).fill(0x14100c);
      g.circle(flyR * 0.85, -flyR * 0.15, flyR * 0.5).fill(0x14100c);
      g.circle(flyR * 1.05, -flyR * 0.3, flyR * 0.18).fill(0x8a1c1c);
      body.addChild(wingA, wingB, g);
      this.view.addChild(body);
      this.flies.push({
        body,
        wingA,
        wingB,
        phase: rnd.range(0, Math.PI * 2),
        rx: radius * rnd.range(0.55, 0.85),
        ry: radius * rnd.range(0.3, 0.55),
        speed: rnd.range(2.2, 3.4) * (rnd.chance(0.5) ? 1 : -1),
      });
    }
    this.update(0);
    if (!reducedMotion) ticker.add(this.onTick);
  }

  private update(dt: number): void {
    // The swarm can be destroyed with its parent (item or plate) without destroy() being called.
    if (this.view.destroyed) {
      this.ticker.remove(this.onTick);
      return;
    }
    this.t += dt;
    for (const f of this.flies) {
      const a = f.phase + this.t * f.speed;
      f.body.position.set(Math.cos(a) * f.rx, -this.radius * 0.35 + Math.sin(a * 1.7) * f.ry);
      f.body.scale.x = Math.sign(-Math.sin(a) * f.speed) || 1;
      // Wing beat as a small shape change (no luminance flashing).
      const beat = 0.6 + 0.4 * Math.abs(Math.sin(this.t * 38 + f.phase));
      f.wingA.scale.y = beat;
      f.wingB.scale.y = 1.6 - beat;
    }
    for (const w of this.wisps) {
      const p = (this.t * 0.55 + w.phase) % 1;
      w.g.alpha = this.reducedMotion ? 0.5 : Math.sin(p * Math.PI) * 0.8;
      w.g.y = -this.radius * 0.3 - p * this.radius * 0.35;
    }
  }

  destroy(): void {
    this.ticker.remove(this.onTick);
    if (!this.view.destroyed) this.view.destroy({ children: true });
  }
}
