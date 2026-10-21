/**
 * Carriers: a woven bamboo basket heaped with produce and a jute sack (open or tied). Origin at the
 * bottom centre; rig units. Both are suitable for carrying on the head or handing over.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import { rgrad, vgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';
import { drawGood, type GoodsKind } from './goods.ts';

export interface BasketOptions {
  readonly contents?: GoodsKind | 'none';
  /** Number of items heaped above the rim (pictured quantity). */
  readonly count?: number;
  /** Width of the basket (rig units, default 72). */
  readonly width?: number;
  readonly seed?: number;
}

/** Woven basket with heaped produce. */
export function createBasket(opts: BasketOptions = {}): Container {
  const c = new Container();
  c.label = 'basket';
  const w = opts.width ?? 72;
  const h = w * 0.42;
  const cane = 0xc9954f;
  const back = new Graphics();
  back.ellipse(0, -h, w / 2, w * 0.12).fill(darken(cane, 0.45));
  c.addChild(back);
  const contents = opts.contents ?? 'none';
  if (contents !== 'none') {
    const g = new Graphics();
    const rnd = new ArtRandom(opts.seed ?? 11);
    const count = Math.max(0, Math.floor(opts.count ?? 9));
    const s = w / 72;
    let placed = 0;
    for (let row = 0; placed < count; row++) {
      const perRow = Math.max(1, 5 - row * 2);
      for (let i = 0; i < perRow && placed < count; i++, placed++) {
        const x = (i - (perRow - 1) / 2) * 13 * s + rnd.range(-2, 2) * s;
        drawGood(g, contents, x, -h + 6 * s - row * 9 * s, s * 0.95, rnd.range(-0.6, 0.6));
      }
    }
    c.addChild(g);
  }
  const front = new Graphics();
  front
    .moveTo(-w / 2, -h)
    .quadraticCurveTo(-w * 0.46, -h * 0.2, -w * 0.32, 0)
    .lineTo(w * 0.32, 0)
    .quadraticCurveTo(w * 0.46, -h * 0.2, w / 2, -h)
    .quadraticCurveTo(0, -h + w * 0.16, -w / 2, -h)
    .fill(
      vgrad([
        [0, lighten(cane, 0.15)],
        [1, darken(cane, 0.25)],
      ]),
    );
  // Weave.
  for (let r = 1; r < 5; r++) {
    const y = -h + (h * r) / 5;
    const half = w / 2 - (w * 0.18 * r) / 5;
    front
      .moveTo(-half, y)
      .quadraticCurveTo(0, y + w * 0.1 * (1 - r / 6), half, y)
      .stroke({ width: 1.4, color: darken(cane, 0.35), alpha: 0.7 });
  }
  for (let k = -5; k <= 5; k++)
    front
      .moveTo(k * w * 0.09, -h + w * 0.1)
      .lineTo(k * w * 0.065, 0)
      .stroke({ width: 1.1, color: darken(cane, 0.3), alpha: 0.5 });
  front
    .moveTo(-w / 2, -h)
    .quadraticCurveTo(0, -h + w * 0.16, w / 2, -h)
    .stroke({ width: 4, color: darken(cane, 0.15) });
  c.addChild(front);
  return c;
}

export interface SackOptions {
  readonly contents?: 'rice' | 'grain' | 'onion' | 'none';
  readonly open?: boolean;
  /** Height (rig units, default 64). */
  readonly height?: number;
}

/** Jute sack; open sacks show their contents heaped at the mouth. */
export function createSack(opts: SackOptions = {}): Container {
  const c = new Container();
  c.label = 'sack';
  const h = opts.height ?? 64;
  const w = h * 0.72;
  const jute = 0xc8a76a;
  const g = new Graphics();
  const open = opts.open ?? false;
  const top = open ? -h * 0.86 : -h;
  g.moveTo(-w * 0.5, 0)
    .bezierCurveTo(-w * 0.64, -h * 0.4, -w * 0.56, top + h * 0.06, -w * (open ? 0.48 : 0.2), top)
    .lineTo(w * (open ? 0.48 : 0.2), top)
    .bezierCurveTo(w * 0.56, top + h * 0.06, w * 0.64, -h * 0.4, w * 0.5, 0)
    .closePath()
    .fill(
      rgrad(
        [
          [0, lighten(jute, 0.12)],
          [0.6, jute],
          [1, darken(jute, 0.32)],
        ],
        { x: 0.4, y: 0.45 },
        0.8,
      ),
    );
  for (let k = 1; k < 7; k++)
    g.moveTo(-w * 0.52, -(h * 0.82 * k) / 7)
      .quadraticCurveTo(0, -(h * 0.82 * k) / 7 + 3, w * 0.52, -(h * 0.82 * k) / 7)
      .stroke({ width: 0.8, color: darken(jute, 0.25), alpha: 0.5 });
  if (open) {
    g.ellipse(0, top, w * 0.48, h * 0.08).fill(darken(jute, 0.35));
    const fill = opts.contents ?? 'rice';
    if (fill === 'rice' || fill === 'grain') {
      const col = fill === 'rice' ? 0xf6f0e0 : 0xd9b25a;
      g.moveTo(-w * 0.44, top)
        .quadraticCurveTo(0, top - h * 0.22, w * 0.44, top)
        .quadraticCurveTo(0, top + h * 0.06, -w * 0.44, top)
        .fill(col);
      const rnd = new ArtRandom(5);
      for (let i = 0; i < 24; i++)
        g.ellipse(rnd.range(-w * 0.3, w * 0.3), top - rnd.range(0, h * 0.12), 1.2, 0.7).fill(
          darken(col, 0.18),
        );
    } else if (fill === 'onion') {
      for (let i = -1; i <= 1; i++) drawGood(g, 'onion', i * 12, top + 4, 0.9, i * 0.3);
      drawGood(g, 'onion', 6, top - 6, 0.9, 0.2);
    }
    // Rolled lip.
    g.ellipse(0, top + 2, w * 0.5, h * 0.06).stroke({ width: 3, color: lighten(jute, 0.1) });
  } else {
    g.moveTo(-w * 0.2, top)
      .lineTo(w * 0.2, top)
      .stroke({ width: 1, color: darken(jute, 0.3) });
    g.moveTo(-w * 0.16, top + h * 0.08)
      .lineTo(w * 0.16, top + h * 0.08)
      .stroke({ width: 3, color: MELA.wood });
    g.ellipse(0, top - 4, w * 0.18, 5).fill(lighten(jute, 0.05));
  }
  c.addChild(g);
  return c;
}
