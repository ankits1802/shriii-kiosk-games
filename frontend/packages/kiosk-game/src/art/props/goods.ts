/**
 * Market goods (onions, tomatoes, mangoes, rice sacks, bangles, clay pots, coins) and pictured
 * quantities. Quantities are always shown as piles or rows of countable items, never as numerals
 * (ENG-11). Every builder draws around a local origin at the bottom centre (y negative upwards) in rig
 * units (a standing villager is ~330 units tall).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import { rgrad, softShadow } from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';

export type GoodsKind =
  | 'onion'
  | 'tomato'
  | 'mango'
  | 'rice_sack'
  | 'bangles'
  | 'clay_pot'
  | 'coin';

export const GOODS_KINDS: readonly GoodsKind[] = [
  'onion',
  'tomato',
  'mango',
  'rice_sack',
  'bangles',
  'clay_pot',
  'coin',
];

/** Natural size (height, rig units) of one item. */
export const GOODS_SIZE: Readonly<Record<GoodsKind, number>> = {
  onion: 16,
  tomato: 14,
  mango: 17,
  rice_sack: 62,
  bangles: 9,
  clay_pot: 34,
  coin: 4,
};

function shaded(g: Graphics, x: number, y: number, rx: number, ry: number, c: number): void {
  g.ellipse(x, y, rx, ry).fill(
    rgrad(
      [
        [0, lighten(c, 0.38)],
        [0.5, c],
        [1, darken(c, 0.35)],
      ],
      { x: 0.36, y: 0.32 },
      0.78,
    ),
  );
}

/** Draw one item with its base at (x, y). `s` scales the natural size. */
export function drawGood(
  g: Graphics,
  kind: GoodsKind,
  x: number,
  y: number,
  s = 1,
  tilt = 0,
): void {
  switch (kind) {
    case 'onion': {
      const r = 8 * s;
      const c = 0xa8456a;
      shaded(g, x, y - r, r, r * 0.92, c);
      g.moveTo(x - r * 0.25, y - r * 1.75)
        .quadraticCurveTo(x, y - r * 2.4 + tilt * 4, x + r * 0.25, y - r * 1.75)
        .fill(darken(c, 0.15));
      for (const k of [-0.45, 0, 0.45])
        g.moveTo(x + k * r * 0.4, y - r * 1.7)
          .quadraticCurveTo(x + k * r * 1.4, y - r, x + k * r * 0.6, y - r * 0.12)
          .stroke({ width: 0.9 * s, color: lighten(c, 0.35), alpha: 0.6 });
      g.moveTo(x - 2 * s, y - 0.5)
        .lineTo(x + 2 * s, y - 0.5)
        .stroke({ width: 1.2 * s, color: 0xe8d8b0 });
      break;
    }
    case 'tomato': {
      const r = 7 * s;
      shaded(g, x, y - r, r * 1.08, r, 0xd9332a);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + tilt;
        g.moveTo(x, y - r * 1.85)
          .lineTo(x + Math.cos(a) * r * 0.5, y - r * 1.85 + Math.sin(a) * r * 0.22)
          .stroke({ width: 1.6 * s, color: MELA.neem, cap: 'round' });
      }
      g.circle(x - r * 0.35, y - r * 1.35, r * 0.18).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    }
    case 'mango': {
      const r = 8.5 * s;
      g.moveTo(x - r * 0.9, y - r * 0.9)
        .bezierCurveTo(x - r * 1.1, y - r * 2.1, x + r * 0.9, y - r * 2.3, x + r, y - r * 1.1)
        .bezierCurveTo(
          x + r * 1.05,
          y - r * 0.1,
          x - r * 0.6,
          y + r * 0.1,
          x - r * 0.9,
          y - r * 0.9,
        )
        .fill(
          rgrad(
            [
              [0, 0xfbe36a],
              [0.55, 0xf2a62a],
              [1, 0xd06a24],
            ],
            { x: 0.35, y: 0.3 },
            0.8,
          ),
        );
      g.ellipse(x + r * 0.5, y - r * 0.6, r * 0.45, r * 0.35).fill({
        color: 0x8fb440,
        alpha: 0.45,
      });
      g.moveTo(x - r * 0.1, y - r * 1.9)
        .lineTo(x - r * 0.2, y - r * 2.3)
        .stroke({ width: 1.4 * s, color: MELA.woodDark });
      g.ellipse(x + r * 0.25, y - r * 2.3, r * 0.45, r * 0.18).fill(MELA.mango);
      break;
    }
    case 'rice_sack': {
      const w = 44 * s;
      const h = 62 * s;
      const c = 0xe8d7a8;
      g.moveTo(x - w * 0.5, y)
        .bezierCurveTo(
          x - w * 0.62,
          y - h * 0.4,
          x - w * 0.5,
          y - h * 0.85,
          x - w * 0.3,
          y - h * 0.9,
        )
        .lineTo(x - w * 0.12, y - h * 0.82)
        .lineTo(x - w * 0.18, y - h)
        .lineTo(x + w * 0.18, y - h)
        .lineTo(x + w * 0.12, y - h * 0.82)
        .lineTo(x + w * 0.3, y - h * 0.9)
        .bezierCurveTo(x + w * 0.5, y - h * 0.85, x + w * 0.62, y - h * 0.4, x + w * 0.5, y)
        .closePath()
        .fill(
          rgrad(
            [
              [0, lighten(c, 0.12)],
              [0.6, c],
              [1, darken(c, 0.3)],
            ],
            { x: 0.4, y: 0.4 },
            0.8,
          ),
        );
      g.moveTo(x - w * 0.14, y - h * 0.82)
        .lineTo(x + w * 0.14, y - h * 0.82)
        .stroke({ width: 3 * s, color: MELA.wood });
      // Woven texture and a painted stripe (no lettering).
      for (let k = 1; k < 6; k++)
        g.moveTo(x - w * 0.5, y - (h * 0.75 * k) / 6)
          .quadraticCurveTo(x, y - (h * 0.75 * k) / 6 + 3 * s, x + w * 0.5, y - (h * 0.75 * k) / 6)
          .stroke({ width: 0.8 * s, color: darken(c, 0.2), alpha: 0.5 });
      g.rect(x - w * 0.45, y - h * 0.5, w * 0.9, 6 * s).fill({ color: MELA.peacock, alpha: 0.85 });
      g.rect(x - w * 0.45, y - h * 0.38, w * 0.9, 3 * s).fill({
        color: MELA.vermilion,
        alpha: 0.85,
      });
      break;
    }
    case 'bangles': {
      const cols = [MELA.vermilion, MELA.brass, MELA.peacock, MELA.rose, MELA.marigold];
      for (let k = 0; k < 5; k++) {
        const c = cols[k % cols.length] ?? MELA.brass;
        g.ellipse(x, y - 3 * s - k * 2.4 * s, 9 * s, 3 * s).stroke({ width: 2.2 * s, color: c });
        g.ellipse(x - 3 * s, y - 4 * s - k * 2.4 * s, 2 * s, 0.8 * s).fill({
          color: 0xffffff,
          alpha: 0.6,
        });
      }
      break;
    }
    case 'clay_pot': {
      const h = 34 * s;
      const r = h * 0.48;
      const c = MELA.terracotta;
      g.ellipse(x, y - h * 0.42, r, h * 0.42).fill(
        rgrad(
          [
            [0, lighten(c, 0.3)],
            [0.55, c],
            [1, darken(c, 0.4)],
          ],
          { x: 0.35, y: 0.35 },
          0.8,
        ),
      );
      g.roundRect(x - r * 0.45, y - h * 0.95, r * 0.9, h * 0.18, 3 * s).fill(darken(c, 0.1));
      g.ellipse(x, y - h * 0.95, r * 0.5, h * 0.06).fill(darken(c, 0.45));
      g.ellipse(x, y - h * 0.5, r * 0.98, h * 0.06).stroke({
        width: 2 * s,
        color: MELA.cream,
        alpha: 0.85,
      });
      for (let k = -3; k <= 3; k++)
        g.circle(x + k * r * 0.24, y - h * 0.36, 1.6 * s).fill({ color: MELA.cream, alpha: 0.85 });
      break;
    }
    case 'coin': {
      const r = 7 * s;
      g.ellipse(x, y - r * 0.32, r, r * 0.34).fill(darken(MELA.brass, 0.25));
      g.ellipse(x, y - r * 0.48, r, r * 0.34).fill(
        rgrad(
          [
            [0, MELA.brassLight],
            [1, MELA.brass],
          ],
          { x: 0.4, y: 0.35 },
          0.8,
        ),
      );
      g.ellipse(x, y - r * 0.48, r * 0.6, r * 0.2).stroke({
        width: 0.9 * s,
        color: darken(MELA.brass, 0.3),
        alpha: 0.7,
      });
      break;
    }
  }
}

/** A single item as a container. */
export function createGood(kind: GoodsKind, s = 1): Container {
  const c = new Container();
  c.label = `good:${kind}`;
  const g = new Graphics();
  drawGood(g, kind, 0, 0, s);
  c.addChild(g);
  return c;
}

/**
 * Pictured quantity: `count` items heaped into a pyramid (deterministic arrangement for a seed).
 * The pile reads as "more" or "less" by size; it carries no numerals.
 */
export function createGoodsPile(kind: GoodsKind, count: number, s = 1, seed = 7): Container {
  const c = new Container();
  c.label = `pile:${kind}:${count}`;
  const g = new Graphics();
  const n = Math.max(0, Math.floor(count));
  const rnd = new ArtRandom(seed + n * 31);
  const item = GOODS_SIZE[kind] * s;
  const w = kind === 'rice_sack' ? item * 0.75 : kind === 'clay_pot' ? item * 0.95 : item * 1.05;
  // Row sizes from the bottom: a pyramid that fits n.
  let base = 1;
  while ((base * (base + 1)) / 2 < n) base++;
  const rows: number[] = [];
  let left = n;
  for (let r = base; r > 0 && left > 0; r--) {
    const take = Math.min(r, left);
    rows.push(take);
    left -= take;
  }
  if (n > 0) softShadow(g, 0, 0, Math.max(10, (base * w) / 2 + 6), 5, MELA.ink, 0.25);
  const rise = kind === 'coin' ? item * 0.55 : item * 0.72;
  rows.forEach((cnt, row) => {
    for (let i = 0; i < cnt; i++) {
      const x = (i - (cnt - 1) / 2) * w + rnd.range(-1.2, 1.2) * s;
      const y = -row * rise;
      drawGood(g, kind, x, y, s, rnd.range(-0.5, 0.5));
    }
  });
  c.addChild(g);
  return c;
}
