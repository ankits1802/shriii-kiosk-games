/**
 * Market props for the mela: stalls with striped scalloped awnings, goods (spice cones, fruit pyramids,
 * clay pots, bangles, fabric, sweets, flowers, toys), hanging lanterns, diyas, bunting flags and
 * marigold garlands. All drawn in daylight colours; scenes tint them with the time-of-day light.
 *
 * Convention: every builder draws around a local origin at the ground contact point (bottom centre),
 * with y negative upwards, and returns light positions (for night glows) in the same space.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import {
  catenary,
  glowDisc,
  marigold,
  polyline,
  rgrad,
  scallopPath,
  shadedBlob,
  softShadow,
  vgrad,
} from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';

export type StallGoods =
  | 'spice'
  | 'fruit'
  | 'pots'
  | 'bangles'
  | 'fabric'
  | 'sweets'
  | 'flowers'
  | 'toys';

export interface StallStyle {
  readonly goods: StallGoods;
  readonly stripeA: number;
  readonly stripeB: number;
  readonly cloth: number;
  readonly seed: number;
}

/** Built prop with its light sources (relative to the prop origin). */
export interface PropArt {
  readonly view: Container;
  readonly lights: readonly { x: number; y: number; r: number; color: number }[];
}

/** Awning colourways (stripe pairs) used across the fair. */
export const AWNING_COLOURWAYS: readonly (readonly [number, number])[] = [
  [MELA.saffron, MELA.cream],
  [MELA.peacock, MELA.cream],
  [MELA.vermilion, MELA.marigold],
  [MELA.indigo, MELA.marigold],
  [MELA.rose, MELA.cream],
  [MELA.mango, MELA.cream],
  [MELA.kumkum, MELA.parchment],
];

/** A complete market stall, `u` = scale unit (1 = 1080p short edge). */
export function drawStall(style: StallStyle, u: number): PropArt {
  return drawStallLayered(style, u, new ArtRandom(style.seed));
}

/** Internal: the stall drawn as separately-shaded layers (stripes stay visible under shading). */
function drawStallLayered(style: StallStyle, u: number, rnd: ArtRandom): PropArt {
  const view = new Container();
  const W = 270 * u;
  const H = 300 * u;
  const lights: { x: number; y: number; r: number; color: number }[] = [];
  const g = new Graphics();
  view.addChild(g);

  softShadow(g, 0, 2 * u, W * 0.64, 18 * u, MELA.ink, 0.4);

  const backTop = -H * 0.84;
  const backBot = -H * 0.34;
  g.rect(-W * 0.46, backTop, W * 0.92, backBot - backTop).fill(
    vgrad([
      [0, darken(style.cloth, 0.45)],
      [1, darken(style.cloth, 0.15)],
    ]),
  );
  for (let yy = backTop + 16 * u, row = 0; yy < backBot - 6 * u; yy += 18 * u, row++) {
    for (let xx = -W * 0.42 + (row % 2) * 9 * u; xx < W * 0.42; xx += 18 * u) {
      g.circle(xx, yy, 2.2 * u).fill({ color: lighten(style.cloth, 0.5), alpha: 0.45 });
    }
  }

  for (const sx of [-1, 1]) {
    const px = sx * W * 0.47;
    g.roundRect(px - 6 * u, -H * 0.97, 12 * u, H * 0.97, 4 * u).fill(
      vgrad([
        [0, lighten(MELA.wood, 0.2)],
        [1, darken(MELA.wood, 0.25)],
      ]),
    );
    g.rect(px - 5 * u, -H * 0.97, 3 * u, H * 0.97).fill({ color: 0xffffff, alpha: 0.14 });
  }

  drawGoods(g, style.goods, -H * 0.36, W * 0.84, u, rnd);

  const cTop = -H * 0.37;
  g.roundRect(-W * 0.48, cTop, W * 0.96, -cTop, 6 * u).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.1)],
      [1, darken(MELA.wood, 0.4)],
    ]),
  );
  g.rect(-W * 0.49, cTop - 2 * u, W * 0.98, 9 * u).fill(lighten(MELA.wood, 0.32));
  g.rect(-W * 0.49, cTop + 7 * u, W * 0.98, 3 * u).fill({ color: 0x000000, alpha: 0.18 });
  const clothTop = cTop + 16 * u;
  const clothH = -cTop - 24 * u;
  g.rect(-W * 0.44, clothTop, W * 0.88, clothH).fill(
    vgrad([
      [0, style.cloth],
      [1, darken(style.cloth, 0.2)],
    ]),
  );
  g.rect(-W * 0.44, clothTop, W * 0.88, 8 * u).fill(MELA.marigold);
  const tooth = 12 * u;
  for (let x = -W * 0.44; x < W * 0.44 - tooth * 0.5; x += tooth) {
    g.poly([
      x,
      clothTop + 8 * u,
      x + tooth / 2,
      clothTop + 17 * u,
      x + tooth,
      clothTop + 8 * u,
    ]).fill(MELA.marigold);
  }
  g.rect(-W * 0.44, clothTop + clothH - 7 * u, W * 0.88, 7 * u).fill(darken(style.cloth, 0.35));
  for (let x = -W * 0.36; x < W * 0.4; x += 28 * u)
    drawPaisley(g, x, clothTop + clothH * 0.6, 7 * u, lighten(style.cloth, 0.55));

  // Awning stripes.
  const aTop = -H * 1.0;
  const aBot = -H * 0.79;
  const backHalf = W * 0.47;
  const frontHalf = W * 0.58;
  const stripes = 10;
  const awn = new Graphics();
  for (let i = 0; i < stripes; i++) {
    const t0 = i / stripes;
    const t1 = (i + 1) / stripes;
    awn
      .poly([
        -backHalf + 2 * backHalf * t0,
        aTop,
        -backHalf + 2 * backHalf * t1,
        aTop,
        -frontHalf + 2 * frontHalf * t1,
        aBot,
        -frontHalf + 2 * frontHalf * t0,
        aBot,
      ])
      .fill(i % 2 === 0 ? style.stripeA : style.stripeB);
  }
  // Shading bands: dark at the back edge, sheen near the front.
  awn
    .poly([
      -backHalf,
      aTop,
      backHalf,
      aTop,
      backHalf * 1.04,
      aTop + (aBot - aTop) * 0.3,
      -backHalf * 1.04,
      aTop + (aBot - aTop) * 0.3,
    ])
    .fill({
      color: 0x000000,
      alpha: 0.16,
    });
  awn
    .poly([
      -frontHalf * 0.97,
      aTop + (aBot - aTop) * 0.72,
      frontHalf * 0.97,
      aTop + (aBot - aTop) * 0.72,
      frontHalf,
      aBot,
      -frontHalf,
      aBot,
    ])
    .fill({ color: 0xffffff, alpha: 0.16 });
  view.addChild(awn);

  // Scalloped valance with alternating colours + gold trim + tassels.
  const val = new Graphics();
  const scallops = 9;
  const sw = (2 * frontHalf) / scallops;
  const depth = 13 * u;
  for (let i = 0; i < scallops; i++) {
    const sx = -frontHalf + i * sw;
    val
      .moveTo(sx, aBot)
      .lineTo(sx + sw, aBot)
      .lineTo(sx + sw, aBot + 8 * u)
      .quadraticCurveTo(sx + sw / 2, aBot + 8 * u + depth * 2, sx, aBot + 8 * u)
      .closePath()
      .fill(i % 2 === 0 ? style.stripeB : style.stripeA);
  }
  scallopPath(val, -frontHalf, frontHalf, aBot + 8 * u, depth, scallops).stroke({
    width: 3 * u,
    color: MELA.brass,
  });
  val
    .moveTo(-frontHalf, aBot)
    .lineTo(frontHalf, aBot)
    .stroke({ width: 4 * u, color: MELA.brass });
  for (let i = 0; i <= scallops; i++) {
    const tx = -frontHalf + i * sw;
    val
      .moveTo(tx, aBot + 8 * u)
      .lineTo(tx, aBot + 22 * u)
      .stroke({ width: 2 * u, color: MELA.brass });
    val.circle(tx, aBot + 25 * u, 4 * u).fill(i % 2 === 0 ? MELA.vermilion : MELA.marigold);
  }
  view.addChild(val);

  // Marigold garland swag between the poles and hanging strands.
  const gar = new Graphics();
  const swag = catenary(-W * 0.47, aBot + 12 * u, W * 0.47, aBot + 12 * u, 34 * u, 22);
  for (let i = 0; i < swag.length; i++) {
    const p = swag[i];
    if (p)
      marigold(
        gar,
        p.x,
        p.y,
        6.5 * u,
        i % 3 === 0 ? MELA.vermilion : i % 2 === 0 ? MELA.marigold : MELA.saffron,
      );
  }
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      marigold(
        gar,
        sx * W * 0.47,
        aBot + 22 * u + k * 12 * u,
        6 * u,
        k % 2 === 0 ? MELA.marigold : MELA.saffron,
      );
    }
  }
  view.addChild(gar);

  // Hanging lantern (glows at dusk).
  const lan = drawLantern(
    u * 0.9,
    rnd.pick([MELA.vermilion, MELA.marigold, MELA.rose, MELA.saffron]),
  );
  lan.view.position.set(W * 0.22 * (rnd.chance(0.5) ? 1 : -1), aBot + 30 * u);
  view.addChild(lan.view);
  for (const l of lan.lights) lights.push({ ...l, x: l.x + lan.view.x, y: l.y + lan.view.y });

  return { view, lights };
}

/** Goods arranged along the counter top (y = counter top line, width = usable span). */
function drawGoods(
  g: Graphics,
  goods: StallGoods,
  y: number,
  width: number,
  u: number,
  rnd: ArtRandom,
): void {
  const left = -width / 2;
  switch (goods) {
    case 'spice': {
      const colours = [MELA.turmeric, MELA.kumkum, 0xc0392b, 0x6e9b3a, 0x8b4a9c, MELA.saffron];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const cx = left + (width / n) * (i + 0.5);
        const r = 19 * u;
        const c = colours[i % colours.length] ?? MELA.turmeric;
        // Cone heap.
        g.moveTo(cx - r * 0.95, y - 6 * u)
          .quadraticCurveTo(cx - r * 0.3, y - 42 * u, cx, y - 46 * u)
          .quadraticCurveTo(cx + r * 0.3, y - 42 * u, cx + r * 0.95, y - 6 * u)
          .closePath()
          .fill(
            rgrad(
              [
                [0, lighten(c, 0.35)],
                [0.6, c],
                [1, darken(c, 0.3)],
              ],
              { x: 0.35, y: 0.3 },
              0.9,
            ),
          );
        for (let k = 0; k < 7; k++) {
          g.circle(cx + rnd.range(-r * 0.5, r * 0.5), y - rnd.range(10, 34) * u, 1.3 * u).fill({
            color: darken(c, 0.4),
            alpha: 0.5,
          });
        }
        // Brass bowl.
        g.ellipse(cx, y - 4 * u, r * 1.08, 7 * u).fill(
          vgrad([
            [0, MELA.brassLight],
            [1, darken(MELA.brass, 0.25)],
          ]),
        );
        g.ellipse(cx - r * 0.4, y - 6 * u, r * 0.3, 2 * u).fill({ color: 0xffffff, alpha: 0.5 });
      }
      break;
    }
    case 'fruit': {
      const piles = [
        { c: MELA.saffron, n: 4 },
        { c: 0xf2c230, n: 3 },
        { c: 0x7cb342, n: 4 },
        { c: MELA.vermilion, n: 3 },
      ];
      piles.forEach((p, idx) => {
        const cx = left + (width / piles.length) * (idx + 0.5);
        const r = 9 * u;
        g.ellipse(cx, y - 3 * u, r * (p.n + 0.6), 6 * u).fill(darken(MELA.wood, 0.1));
        for (let row = 0; row < p.n; row++) {
          const count = p.n - row;
          for (let k = 0; k < count; k++) {
            const fx = cx + (k - (count - 1) / 2) * r * 1.9;
            const fy = y - 8 * u - row * r * 1.6;
            shadedBlob(g, fx, fy, r, r * 0.95, p.c);
          }
        }
      });
      // Banana bunch hanging from the awning line is drawn by the stall lantern slot; add leaves here.
      break;
    }
    case 'pots': {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const cx = left + (width / n) * (i + 0.5);
        const h = rnd.range(32, 52) * u;
        drawPot(g, cx, y, h, rnd.pick([MELA.terracotta, MELA.clay, 0xc0703e]), u);
      }
      break;
    }
    case 'bangles': {
      const cols = [
        MELA.vermilion,
        MELA.marigold,
        MELA.peacock,
        MELA.rose,
        MELA.lapis,
        0x2e8b57,
        MELA.brass,
      ];
      const stands = 3;
      for (let s = 0; s < stands; s++) {
        const cx = left + (width / stands) * (s + 0.5);
        g.rect(cx - 2 * u, y - 70 * u, 4 * u, 70 * u).fill(MELA.woodDark);
        g.ellipse(cx, y - 2 * u, 18 * u, 4 * u).fill(MELA.woodDark);
        for (let k = 0; k < 14; k++) {
          const c = cols[(k + s * 2) % cols.length] ?? MELA.brass;
          g.ellipse(cx, y - 66 * u + k * 4.2 * u, 12 * u, 3.4 * u).stroke({
            width: 2.6 * u,
            color: c,
          });
        }
        g.ellipse(cx - 6 * u, y - 62 * u, 2 * u, 20 * u).fill({ color: 0xffffff, alpha: 0.35 });
      }
      break;
    }
    case 'fabric': {
      const cols = [
        MELA.vermilion,
        MELA.peacock,
        MELA.marigold,
        MELA.indigo,
        MELA.rose,
        MELA.mango,
      ];
      const stacks = 4;
      for (let s = 0; s < stacks; s++) {
        const cx = left + (width / stacks) * (s + 0.5);
        for (let k = 0; k < 5; k++) {
          const c = cols[(k + s) % cols.length] ?? MELA.rose;
          const fy = y - 8 * u - k * 9 * u;
          g.roundRect(cx - 24 * u, fy - 8 * u, 48 * u, 9 * u, 3 * u).fill(c);
          g.rect(cx - 24 * u, fy - 3 * u, 48 * u, 2 * u).fill({
            color: MELA.brassLight,
            alpha: 0.8,
          });
        }
      }
      break;
    }
    case 'sweets': {
      const trays = 3;
      for (let s = 0; s < trays; s++) {
        const cx = left + (width / trays) * (s + 0.5);
        g.ellipse(cx, y - 3 * u, 34 * u, 8 * u).fill(
          vgrad([
            [0, MELA.brassLight],
            [1, darken(MELA.brass, 0.3)],
          ]),
        );
        if (s === 1) {
          // Jalebi spirals.
          for (let k = 0; k < 5; k++) {
            const jx = cx + (k - 2) * 12 * u;
            const jy = y - 12 * u - (k % 2) * 8 * u;
            const pts: { x: number; y: number }[] = [];
            for (let a = 0; a < Math.PI * 5; a += 0.3) {
              const rr = (a / (Math.PI * 5)) * 8 * u;
              pts.push({ x: jx + Math.cos(a) * rr, y: jy + Math.sin(a) * rr * 0.8 });
            }
            polyline(g, pts, 2.6 * u, 0xf39c12);
          }
        } else {
          // Laddoo pyramid.
          for (let row = 0; row < 3; row++) {
            const count = 3 - row;
            for (let k = 0; k < count; k++) {
              shadedBlob(
                g,
                cx + (k - (count - 1) / 2) * 15 * u,
                y - 10 * u - row * 12 * u,
                7.5 * u,
                7.5 * u,
                s === 0 ? 0xf0a030 : 0xf6e0a8,
              );
            }
          }
        }
      }
      break;
    }
    case 'flowers': {
      const baskets = 4;
      for (let s = 0; s < baskets; s++) {
        const cx = left + (width / baskets) * (s + 0.5);
        g.moveTo(cx - 26 * u, y - 22 * u)
          .lineTo(cx + 26 * u, y - 22 * u)
          .lineTo(cx + 20 * u, y)
          .lineTo(cx - 20 * u, y)
          .closePath()
          .fill(
            vgrad([
              [0, 0xc49a5a],
              [1, 0x8d6a3a],
            ]),
          );
        for (let k = -2; k <= 2; k++)
          g.moveTo(cx + k * 9 * u, y - 22 * u)
            .lineTo(cx + k * 7 * u, y)
            .stroke({ width: 1.2 * u, color: 0x6e5030, alpha: 0.6 });
        const c = s % 2 === 0 ? MELA.marigold : MELA.rose;
        for (let k = 0; k < 9; k++)
          marigold(
            g,
            cx + rnd.range(-22, 22) * u,
            y - rnd.range(22, 34) * u,
            6 * u,
            k % 3 === 0 ? MELA.saffron : c,
          );
      }
      break;
    }
    case 'toys': {
      const n = 4;
      for (let s = 0; s < n; s++) {
        const cx = left + (width / n) * (s + 0.5);
        if (s % 2 === 0) {
          // Pinwheel on a stick.
          g.rect(cx - 1.5 * u, y - 60 * u, 3 * u, 60 * u).fill(MELA.woodDark);
          const cols = [MELA.vermilion, MELA.marigold, MELA.peacock, MELA.rose];
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2;
            g.moveTo(cx, y - 60 * u)
              .lineTo(cx + Math.cos(a) * 16 * u, y - 60 * u + Math.sin(a) * 16 * u)
              .lineTo(cx + Math.cos(a + 0.8) * 10 * u, y - 60 * u + Math.sin(a + 0.8) * 10 * u)
              .closePath()
              .fill(cols[k] ?? MELA.rose);
          }
          g.circle(cx, y - 60 * u, 2.5 * u).fill(MELA.brass);
        } else {
          // Little damru-like drum.
          g.poly([
            cx - 14 * u,
            y - 30 * u,
            cx + 14 * u,
            y - 30 * u,
            cx + 4 * u,
            y - 16 * u,
            cx + 14 * u,
            y - 2 * u,
            cx - 14 * u,
            y - 2 * u,
            cx - 4 * u,
            y - 16 * u,
          ]).fill(MELA.vermilion);
          g.ellipse(cx, y - 30 * u, 14 * u, 4 * u).fill(MELA.cream);
          g.moveTo(cx - 10 * u, y - 26 * u)
            .lineTo(cx + 10 * u, y - 6 * u)
            .stroke({ width: 1.2 * u, color: MELA.brass });
          g.moveTo(cx + 10 * u, y - 26 * u)
            .lineTo(cx - 10 * u, y - 6 * u)
            .stroke({ width: 1.2 * u, color: MELA.brass });
        }
      }
      break;
    }
  }
}

/** Clay pot with painted bands (origin = base centre at y). */
export function drawPot(
  g: Graphics,
  cx: number,
  y: number,
  h: number,
  color: number,
  u: number,
): void {
  const r = h * 0.48;
  g.ellipse(cx, y - h * 0.42, r, h * 0.42).fill(
    rgrad(
      [
        [0, lighten(color, 0.3)],
        [0.55, color],
        [1, darken(color, 0.4)],
      ],
      { x: 0.35, y: 0.35 },
      0.8,
    ),
  );
  g.roundRect(cx - r * 0.45, y - h * 0.95, r * 0.9, h * 0.18, 3 * u).fill(darken(color, 0.1));
  g.ellipse(cx, y - h * 0.95, r * 0.5, h * 0.06).fill(darken(color, 0.45));
  g.ellipse(cx, y - h * 0.5, r * 0.98, h * 0.06).stroke({
    width: 2 * u,
    color: MELA.cream,
    alpha: 0.85,
  });
  for (let k = -3; k <= 3; k++)
    g.circle(cx + k * r * 0.24, y - h * 0.38, 1.6 * u).fill({ color: MELA.cream, alpha: 0.85 });
}

/** Paisley (buta) motif. */
export function drawPaisley(g: Graphics, x: number, y: number, s: number, color: number): void {
  g.moveTo(x, y + s)
    .bezierCurveTo(x - s * 1.2, y + s, x - s * 1.1, y - s * 0.6, x, y - s * 0.7)
    .bezierCurveTo(x + s * 0.9, y - s * 0.8, x + s * 1.3, y - s * 1.6, x + s * 0.4, y - s * 1.9)
    .bezierCurveTo(x + s * 1.6, y - s * 1.2, x + s * 1.2, y + s, x, y + s)
    .fill(color);
  g.circle(x - s * 0.05, y + s * 0.1, s * 0.3).fill(darken(color, 0.35));
}

/** Hanging paper/brass lantern; light at the body centre. Origin = hook point. */
export function drawLantern(u: number, color: number): PropArt {
  const view = new Container();
  const g = new Graphics();
  g.moveTo(0, 0)
    .lineTo(0, 10 * u)
    .stroke({ width: 1.5 * u, color: MELA.woodDark });
  g.roundRect(-9 * u, 10 * u, 18 * u, 5 * u, 2 * u).fill(MELA.brass);
  g.moveTo(-11 * u, 15 * u)
    .bezierCurveTo(-17 * u, 24 * u, -17 * u, 38 * u, -9 * u, 46 * u)
    .lineTo(9 * u, 46 * u)
    .bezierCurveTo(17 * u, 38 * u, 17 * u, 24 * u, 11 * u, 15 * u)
    .closePath()
    .fill(
      rgrad(
        [
          [0, lighten(color, 0.55)],
          [0.6, color],
          [1, darken(color, 0.3)],
        ],
        { x: 0.5, y: 0.55 },
        0.7,
      ),
    );
  for (let k = -1; k <= 1; k++)
    g.moveTo(k * 6 * u, 16 * u)
      .quadraticCurveTo(k * 9 * u, 30 * u, k * 5 * u, 45 * u)
      .stroke({ width: 1 * u, color: darken(color, 0.35), alpha: 0.6 });
  g.roundRect(-7 * u, 45 * u, 14 * u, 4 * u, 2 * u).fill(MELA.brass);
  g.moveTo(0, 49 * u)
    .lineTo(0, 58 * u)
    .stroke({ width: 1.5 * u, color: color });
  g.circle(0, 60 * u, 2.5 * u).fill(color);
  view.addChild(g);
  return { view, lights: [{ x: 0, y: 30 * u, r: 46 * u, color: 0xffb347 }] };
}

/** Clay diya: returns the bowl, the flame (animated separately) and the light point. Origin = base. */
export function drawDiya(u: number): {
  bowl: Graphics;
  flame: Graphics;
  light: { x: number; y: number; r: number; color: number };
} {
  const bowl = new Graphics();
  softShadow(bowl, 0, 2 * u, 20 * u, 4 * u, MELA.ink, 0.35);
  bowl
    .moveTo(-18 * u, -8 * u)
    .quadraticCurveTo(-14 * u, 4 * u, 0, 3 * u)
    .quadraticCurveTo(14 * u, 4 * u, 20 * u, -9 * u)
    .lineTo(26 * u, -12 * u)
    .lineTo(16 * u, -10 * u)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.terracotta, 0.2)],
        [1, darken(MELA.terracotta, 0.35)],
      ]),
    );
  bowl.ellipse(0, -8.5 * u, 17 * u, 3.5 * u).fill(darken(MELA.terracotta, 0.45));
  bowl.ellipse(0, -8.5 * u, 14 * u, 2.2 * u).fill({ color: 0xe8b04a, alpha: 0.8 });
  bowl
    .moveTo(-14 * u, -2 * u)
    .quadraticCurveTo(0, 2 * u, 14 * u, -2 * u)
    .stroke({ width: 1.2 * u, color: MELA.cream, alpha: 0.6 });
  const flame = new Graphics();
  flame
    .moveTo(0, 0)
    .bezierCurveTo(-6 * u, -4 * u, -4 * u, -12 * u, 0, -20 * u)
    .bezierCurveTo(4 * u, -12 * u, 6 * u, -4 * u, 0, 0)
    .fill(
      rgrad(
        [
          [0, 0xffffff],
          [0.35, 0xfff1a8],
          [0.7, 0xffa630],
          [1, 0xe8551e],
        ],
        { x: 0.5, y: 0.75 },
        0.7,
      ),
    );
  flame.position.set(22 * u, -12 * u);
  return { bowl, flame, light: { x: 22 * u, y: -22 * u, r: 60 * u, color: 0xffa347 } };
}

/** One bunting flag drawn hanging from (0, 0). */
export function drawFlag(
  kind: 'triangle' | 'pennant' | 'square',
  color: number,
  size: number,
): Graphics {
  const g = new Graphics();
  const trim = lighten(color, 0.45);
  if (kind === 'triangle') {
    g.poly([-size * 0.5, 0, size * 0.5, 0, 0, size * 1.05]).fill(
      vgrad([
        [0, lighten(color, 0.1)],
        [1, darken(color, 0.15)],
      ]),
    );
    g.moveTo(-size * 0.5, 1)
      .lineTo(size * 0.5, 1)
      .stroke({ width: size * 0.08, color: trim });
  } else if (kind === 'pennant') {
    g.poly([
      -size * 0.4,
      0,
      size * 0.4,
      0,
      size * 0.4,
      size * 0.9,
      0,
      size * 0.7,
      -size * 0.4,
      size * 0.9,
    ]).fill(color);
    g.circle(0, size * 0.32, size * 0.13).fill(trim);
  } else {
    g.rect(-size * 0.42, 0, size * 0.84, size * 0.7).fill(color);
    for (let i = 0; i < 6; i++) {
      const fx = -size * 0.42 + ((i + 0.5) * (size * 0.84)) / 6;
      g.moveTo(fx, size * 0.7)
        .lineTo(fx, size * 0.88)
        .stroke({ width: size * 0.05, color: trim });
    }
    g.rect(-size * 0.42, size * 0.24, size * 0.84, size * 0.1).fill(trim);
  }
  return g;
}

/** Bulb for string lights (body only; the glow is a separate additive sprite). */
export function drawBulb(size: number, color: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, size).fill(
    rgrad([
      [0, lighten(color, 0.7)],
      [0.6, color],
      [1, darken(color, 0.2)],
    ]),
  );
  return g;
}

/** Standalone soft glow disc (baked into a texture and drawn additively). */
export function drawGlow(radius: number, color: number): Graphics {
  return glowDisc(new Graphics(), 0, 0, radius, color, 1);
}

/** A row of goods without the stall (close-up counter scenes). Origin = left end of the counter line. */
export function drawGoodsRow(goods: StallGoods, width: number, u: number, seed: number): Container {
  const g = new Graphics();
  drawGoods(g, goods, 0, width, u, new ArtRandom(seed));
  g.position.x = width / 2;
  const wrap = new Container();
  wrap.addChild(g);
  return wrap;
}

/** Balloon seller's bunch: shiny balloons on strings gathered at a hand-height point. Origin = gather point. */
export function drawBalloonBunch(u: number, seed: number): Container {
  const rnd = new ArtRandom(seed);
  const view = new Container();
  const g = new Graphics();
  const cols = [
    MELA.vermilion,
    MELA.marigold,
    MELA.peacockLight,
    MELA.rose,
    MELA.lapis,
    MELA.mango,
    MELA.saffron,
    0x9b59b6,
  ];
  const balloons: { x: number; y: number; c: number; r: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const a = -Math.PI / 2 + rnd.range(-0.9, 0.9);
    const d = rnd.range(110, 190) * u;
    balloons.push({
      x: Math.cos(a) * d,
      y: Math.sin(a) * d,
      c: cols[i % cols.length] ?? MELA.rose,
      r: rnd.range(20, 27) * u,
    });
  }
  balloons.sort((a, b) => a.y - b.y);
  for (const b of balloons) {
    g.moveTo(0, 0)
      .quadraticCurveTo(b.x * 0.4 + rnd.range(-8, 8) * u, b.y * 0.5, b.x, b.y + b.r * 1.15)
      .stroke({ width: 1.2 * u, color: 0xf6f0e0, alpha: 0.8 });
  }
  for (const b of balloons) {
    g.ellipse(b.x, b.y, b.r * 0.86, b.r).fill(
      rgrad(
        [
          [0, lighten(b.c, 0.5)],
          [0.35, b.c],
          [1, darken(b.c, 0.35)],
        ],
        { x: 0.35, y: 0.3 },
        0.8,
      ),
    );
    g.poly([
      b.x - 4 * u,
      b.y + b.r * 1.12,
      b.x + 4 * u,
      b.y + b.r * 1.12,
      b.x,
      b.y + b.r * 0.96,
    ]).fill(darken(b.c, 0.2));
    g.ellipse(b.x - b.r * 0.32, b.y - b.r * 0.42, b.r * 0.14, b.r * 0.24).fill({
      color: 0xffffff,
      alpha: 0.6,
    });
  }
  view.addChild(g);
  return view;
}
