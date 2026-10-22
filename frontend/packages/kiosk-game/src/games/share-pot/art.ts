/**
 * Share-the-Pot props: the brass handi (pot) with its glow, the player's cloth pouch, the open-palm
 * "keep" spot, and the three tone faces (warm, neutral, firm) distinguished by shape, colour and
 * facial features (colour is never the only cue, KSK-06). No numerals or text anywhere (ENG-11).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import { drawIcon } from '../../art/ui/icons.ts';
import { drawBigCoin } from '../hub/kit/art.ts';

/** Brass handi; origin = base centre. `fill` (0..1) shows a heap of coins at the mouth. */
export class BrassPot {
  readonly view = new Container();
  private readonly heap = new Graphics();
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
    const s = size;
    const g = new Graphics();
    softShadow(g, 0, 0, s * 0.62, s * 0.12, MELA.ink, 0.45);
    // Body.
    g.ellipse(0, -s * 0.42, s * 0.5, s * 0.42).fill(
      rgrad(
        [
          [0, lighten(MELA.brassLight, 0.35)],
          [0.45, MELA.brass],
          [0.85, darken(MELA.brass, 0.35)],
          [1, darken(MELA.brass, 0.55)],
        ],
        { x: 0.34, y: 0.3 },
        0.78,
      ),
    );
    // Neck and rim.
    g.roundRect(-s * 0.26, -s * 0.9, s * 0.52, s * 0.14, s * 0.05).fill(
      vgrad([
        [0, lighten(MELA.brass, 0.15)],
        [1, darken(MELA.brass, 0.3)],
      ]),
    );
    g.ellipse(0, -s * 0.9, s * 0.34, s * 0.075).fill(darken(MELA.brass, 0.15));
    g.ellipse(0, -s * 0.9, s * 0.27, s * 0.05).fill(darken(MELA.brass, 0.6));
    // Engraved bands.
    for (const [y, w] of [
      [-0.62, 0.47],
      [-0.28, 0.48],
    ] as const) {
      g.ellipse(0, s * y, s * w, s * 0.05).stroke({
        width: s * 0.018,
        color: darken(MELA.brass, 0.35),
        alpha: 0.75,
      });
    }
    for (let k = -4; k <= 4; k++) {
      const x = k * s * 0.1;
      g.circle(x, -s * 0.45 + Math.abs(k) * s * 0.008, s * 0.022).fill(darken(MELA.brass, 0.3));
    }
    // Highlights.
    g.ellipse(-s * 0.2, -s * 0.55, s * 0.1, s * 0.2).fill({ color: 0xffffff, alpha: 0.35 });
    g.ellipse(-s * 0.26, -s * 0.36, s * 0.04, s * 0.07).fill({ color: 0xffffff, alpha: 0.5 });
    // Marigold garland around the neck.
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * (0.1 + (0.8 * i) / 10);
      const x = Math.cos(a) * s * 0.33;
      const y = -s * 0.74 + Math.sin(a) * s * 0.07;
      g.circle(x, y, s * 0.045).fill(i % 2 ? MELA.marigold : MELA.saffron);
      g.circle(x, y, s * 0.02).fill(MELA.marigoldDeep);
    }
    this.view.addChild(g, this.heap);
    this.setFill(0);
  }

  /** Mouth of the pot in local coordinates (where coins land). */
  get mouth(): { x: number; y: number } {
    return { x: 0, y: -this.size * 0.92 };
  }

  /** Show a heap of coins at the mouth (0 = empty, 1 = brimming). */
  setFill(level: number): void {
    const s = this.size;
    const g = this.heap;
    g.clear();
    const n = Math.round(Math.max(0, Math.min(1, level)) * 14);
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 5);
      const col = i % 5;
      const x = (col - 2) * s * 0.085 + (row % 2) * s * 0.04;
      const y = -s * 0.93 - row * s * 0.05;
      drawBigCoin(g, x, y, s * 0.06, 0.8);
    }
  }
}

/** The player's cloth pouch (where returned coins go). Origin = base centre. */
export function createPouch(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  softShadow(g, 0, 0, s * 0.55, s * 0.12, MELA.ink, 0.4);
  g.moveTo(-s * 0.42, -s * 0.05)
    .bezierCurveTo(-s * 0.55, -s * 0.55, -s * 0.25, -s * 0.78, -s * 0.12, -s * 0.8)
    .lineTo(s * 0.12, -s * 0.8)
    .bezierCurveTo(s * 0.25, -s * 0.78, s * 0.55, -s * 0.55, s * 0.42, -s * 0.05)
    .quadraticCurveTo(0, s * 0.06, -s * 0.42, -s * 0.05)
    .fill(
      rgrad(
        [
          [0, lighten(MELA.vermilion, 0.25)],
          [0.7, MELA.vermilion],
          [1, darken(MELA.kumkum, 0.35)],
        ],
        { x: 0.38, y: 0.4 },
        0.75,
      ),
    );
  // Tie and tassels.
  g.ellipse(0, -s * 0.8, s * 0.17, s * 0.06).fill(MELA.marigoldDeep);
  g.moveTo(-s * 0.13, -s * 0.84)
    .quadraticCurveTo(-s * 0.08, -s * 1.0, -s * 0.18, -s * 1.02)
    .stroke({ width: s * 0.04, color: MELA.marigold });
  g.moveTo(s * 0.13, -s * 0.84)
    .quadraticCurveTo(s * 0.08, -s * 1.0, s * 0.2, -s * 1.0)
    .stroke({ width: s * 0.04, color: MELA.marigold });
  // Embroidery.
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * s * 0.1;
    g.circle(x, -s * 0.3 + Math.abs(i - 3) * s * 0.03, s * 0.025).fill(MELA.brassLight);
  }
  g.moveTo(-s * 0.36, -s * 0.18)
    .quadraticCurveTo(0, -s * 0.05, s * 0.36, -s * 0.18)
    .stroke({ width: s * 0.025, color: MELA.brass, alpha: 0.9 });
  c.addChild(g);
  return c;
}

/** Open palm in a brass ring: "keep my coins" (slot 0). Origin = centre. */
export function createPalmSpot(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const r = size * 0.46;
  softShadow(g, 0, r * 0.9, r, r * 0.22, MELA.ink, 0.35);
  g.circle(0, 0, r).fill(
    rgrad(
      [
        [0, lighten(MELA.parchment, 0.4)],
        [1, MELA.sandstone],
      ],
      { x: 0.4, y: 0.35 },
      0.75,
    ),
  );
  g.circle(0, 0, r).stroke({ width: r * 0.1, color: MELA.brass });
  g.circle(0, 0, r * 0.82).stroke({ width: r * 0.03, color: darken(MELA.brass, 0.25), alpha: 0.6 });
  c.addChild(g);
  const hand = drawIcon('hand', size * 0.62, MELA.terracotta);
  c.addChild(hand);
  return c;
}

/** A tone face medallion. `code`: warm (round, marigold, smile), neutral (squircle, cream, level
 * mouth), firm (octagon, indigo, set brows and a flat mouth). Origin = centre. */
export function createToneFace(code: 'warm' | 'neutral' | 'firm', size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const r = size * 0.46;
  softShadow(g, 0, r * 1.0, r * 0.95, r * 0.2, MELA.ink, 0.4);
  const face = code === 'warm' ? MELA.marigold : code === 'neutral' ? MELA.parchment : MELA.lapis;
  const rim = code === 'warm' ? MELA.saffron : code === 'neutral' ? MELA.sandstone : MELA.indigo;
  const ink = code === 'firm' ? MELA.cream : MELA.ink;
  const shape = (gg: Graphics, rr: number): Graphics => {
    if (code === 'warm') return gg.circle(0, 0, rr);
    if (code === 'neutral') return gg.roundRect(-rr, -rr, rr * 2, rr * 2, rr * 0.45);
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      pts.push(Math.cos(a) * rr * 1.06, Math.sin(a) * rr * 1.06);
    }
    return gg.poly(pts);
  };
  shape(g, r * 1.0).fill(darken(rim, 0.25));
  g.y = 0;
  const top = new Graphics();
  shape(top, r * 0.94).fill(
    rgrad(
      [
        [0, lighten(face, 0.35)],
        [0.7, face],
        [1, darken(face, 0.15)],
      ],
      { x: 0.38, y: 0.32 },
      0.8,
    ),
  );
  shape(top, r * 0.94).stroke({ width: r * 0.06, color: lighten(rim, 0.3), alpha: 0.8 });
  // Features.
  const ey = -r * 0.18;
  const ex = r * 0.34;
  if (code === 'warm') {
    // Smiling crescent eyes, rosy cheeks, broad smile.
    for (const sx of [-1, 1]) {
      top
        .moveTo(sx * ex - r * 0.14, ey)
        .quadraticCurveTo(sx * ex, ey - r * 0.16, sx * ex + r * 0.14, ey)
        .stroke({ width: r * 0.08, color: ink, cap: 'round' });
      top
        .ellipse(sx * r * 0.52, r * 0.14, r * 0.14, r * 0.08)
        .fill({ color: MELA.rose, alpha: 0.7 });
    }
    top
      .moveTo(-r * 0.4, r * 0.18)
      .quadraticCurveTo(0, r * 0.62, r * 0.4, r * 0.18)
      .stroke({ width: r * 0.09, color: ink, cap: 'round' });
  } else if (code === 'neutral') {
    for (const sx of [-1, 1]) top.circle(sx * ex, ey, r * 0.085).fill(ink);
    top
      .moveTo(-r * 0.3, r * 0.32)
      .lineTo(r * 0.3, r * 0.32)
      .stroke({ width: r * 0.09, color: ink, cap: 'round' });
  } else {
    // Set brows angled down to the centre, steady eyes, firm flat mouth.
    for (const sx of [-1, 1]) {
      top.circle(sx * ex, ey + r * 0.04, r * 0.085).fill(ink);
      top
        .moveTo(sx * (ex + r * 0.2), ey - r * 0.24)
        .lineTo(sx * (ex - r * 0.16), ey - r * 0.12)
        .stroke({ width: r * 0.1, color: ink, cap: 'round' });
    }
    top
      .moveTo(-r * 0.32, r * 0.36)
      .lineTo(r * 0.32, r * 0.36)
      .stroke({ width: r * 0.12, color: ink, cap: 'round' });
  }
  c.addChild(g, top);
  return c;
}

/** A gift basket heaped with coins (the shared bonus the helper snatches). */
export function createGiftBasket(width: number, coins: number): Container {
  const c = new Container();
  const g = new Graphics();
  const w = width;
  const h = w * 0.45;
  softShadow(g, 0, 0, w * 0.55, w * 0.1, MELA.ink, 0.35);
  const heap = new Graphics();
  for (let i = 0; i < coins; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    drawBigCoin(
      heap,
      (col - 1.5) * w * 0.16 + (row % 2) * w * 0.06,
      -h * 0.95 - row * w * 0.08,
      w * 0.085,
      0.9,
    );
  }
  g.moveTo(-w / 2, -h)
    .quadraticCurveTo(-w * 0.44, -h * 0.15, -w * 0.3, 0)
    .lineTo(w * 0.3, 0)
    .quadraticCurveTo(w * 0.44, -h * 0.15, w / 2, -h)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.peacockLight, 0.1)],
        [1, darken(MELA.peacock, 0.3)],
      ]),
    );
  g.moveTo(-w / 2, -h)
    .lineTo(w / 2, -h)
    .stroke({ width: w * 0.05, color: MELA.brass });
  for (let k = -3; k <= 3; k++) g.circle(k * w * 0.12, -h * 0.5, w * 0.025).fill(MELA.marigold);
  // Ribbon bow.
  g.ellipse(-w * 0.1, -h * 1.02, w * 0.1, w * 0.05).fill(MELA.vermilion);
  g.ellipse(w * 0.1, -h * 1.02, w * 0.1, w * 0.05).fill(MELA.vermilion);
  g.circle(0, -h * 1.02, w * 0.04).fill(MELA.kumkum);
  c.addChild(heap, g);
  return c;
}
