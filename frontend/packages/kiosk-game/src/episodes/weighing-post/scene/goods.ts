/**
 * Goods, brass weights and small props of The Weighing Post, drawn procedurally (original vector art,
 * no images). Origins are at the bottom centre; sizes are in the scale's local units (a pan is ~190
 * units wide). Quantities are always pictured as countable things, never written (ENG-11).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { lgrad, mangoLeaf, marigold, rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { createBasket, createSack } from '../../../art/props/containers.ts';
import { drawGood } from '../../../art/props/goods.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { GoodId } from '../../../paradigms/weighing-post.ts';

function potatoes(g: Graphics, cx: number, cy: number, w: number, rnd: ArtRandom): void {
  for (let i = 0; i < 7; i++) {
    const x = cx + rnd.range(-w * 0.38, w * 0.38);
    const y = cy - rnd.range(0, 16) - (i > 3 ? 10 : 0);
    const rx = rnd.range(12, 17);
    const ry = rx * 0.72;
    g.ellipse(x, y, rx, ry).fill(
      rgrad(
        [
          [0, 0xe2b979],
          [0.7, 0xc4955a],
          [1, 0x8a6236],
        ],
        { x: 0.35, y: 0.3 },
        0.8,
      ),
    );
    for (let k = 0; k < 3; k++)
      g.circle(x + rnd.range(-rx * 0.5, rx * 0.5), y + rnd.range(-ry * 0.4, ry * 0.4), 1.4).fill(
        0x6e4a28,
      );
  }
}

function lentilBag(): Container {
  const c = new Container();
  const g = new Graphics();
  const cloth = MELA.kumkum;
  softShadow(g, 0, 0, 58, 9, MELA.ink, 0.3);
  g.moveTo(-54, 0)
    .bezierCurveTo(-70, -50, -40, -86, -18, -92)
    .lineTo(18, -92)
    .bezierCurveTo(40, -86, 70, -50, 54, 0)
    .closePath()
    .fill(
      rgrad(
        [
          [0, lighten(cloth, 0.2)],
          [0.7, cloth],
          [1, darken(cloth, 0.35)],
        ],
        { x: 0.4, y: 0.45 },
        0.8,
      ),
    );
  // Block-print motifs.
  const rnd = new ArtRandom(31);
  for (let i = 0; i < 9; i++) {
    const x = rnd.range(-40, 40);
    const y = -rnd.range(14, 70);
    g.circle(x, y, 5).stroke({ width: 1.6, color: MELA.marigold, alpha: 0.85 });
    g.circle(x, y, 1.6).fill(MELA.cream);
  }
  // Mouth with orange lentils.
  g.ellipse(0, -94, 26, 9).fill(0xe8743b);
  for (let i = 0; i < 26; i++)
    g.circle(rnd.range(-20, 20), -96 - rnd.range(0, 9), 2.2).fill(i % 3 ? 0xf08a4b : 0xd65f2a);
  g.moveTo(-24, -86).quadraticCurveTo(0, -80, 24, -86).stroke({ width: 4, color: MELA.parchment });
  g.circle(26, -84, 4).fill(MELA.parchment);
  c.addChild(g);
  return c;
}

function jaggery(): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, 0, 74, 10, MELA.ink, 0.32);
  // Banana leaf.
  g.moveTo(-82, -4)
    .quadraticCurveTo(0, -26, 86, -6)
    .quadraticCurveTo(0, 12, -82, -4)
    .fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, 0x7cb342],
        [1, 0x3e7a2c],
      ]),
    );
  for (let i = -7; i <= 7; i++)
    g.moveTo(i * 10, -12)
      .lineTo(i * 11, 2)
      .stroke({ width: 1, color: 0x2f5e22, alpha: 0.5 });
  // Two golden-brown jaggery cones.
  for (const [x, h] of [
    [-26, 70],
    [24, 86],
  ] as const) {
    g.moveTo(x - 34, -8)
      .quadraticCurveTo(x - 28, -h * 0.7, x, -h)
      .quadraticCurveTo(x + 28, -h * 0.7, x + 34, -8)
      .quadraticCurveTo(x, 0, x - 34, -8)
      .fill(
        rgrad(
          [
            [0, 0xe0a24a],
            [0.55, 0xb8722c],
            [1, 0x7a4416],
          ],
          { x: 0.35, y: 0.3 },
          0.9,
        ),
      );
    g.moveTo(x - 12, -h * 0.7)
      .quadraticCurveTo(x - 6, -h * 0.4, x - 18, -18)
      .stroke({
        width: 3,
        color: 0xf5c77a,
        alpha: 0.5,
        cap: 'round',
      });
  }
  c.addChild(g);
  return c;
}

function chilliBundle(): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, 0, 62, 9, MELA.ink, 0.3);
  const rnd = new ArtRandom(57);
  for (let i = 0; i < 15; i++) {
    const a = -Math.PI / 2 + rnd.range(-0.7, 0.7);
    const len = rnd.range(70, 96);
    const bx = rnd.range(-10, 10);
    const tx = bx + Math.cos(a) * len;
    const ty = -16 + Math.sin(a) * len;
    const col = i % 4 === 0 ? 0xb3261e : i % 3 === 0 ? 0xe23b2a : 0xcc2f22;
    g.moveTo(bx - 5, -16)
      .quadraticCurveTo((bx + tx) / 2 + 9, (ty - 16) / 2, tx, ty)
      .quadraticCurveTo((bx + tx) / 2 - 4, (ty - 16) / 2, bx + 5, -16)
      .closePath()
      .fill(col);
    g.moveTo(bx - 1, -20)
      .quadraticCurveTo((bx + tx) / 2 + 3, (ty - 20) / 2, tx, ty)
      .stroke({
        width: 1.6,
        color: 0xff8a7a,
        alpha: 0.6,
      });
    g.circle(bx, -14, 3.5).fill(0x3f7a2a);
  }
  // Twine binding.
  g.roundRect(-18, -24, 36, 14, 5).fill(0xc8a76a);
  for (let k = 0; k < 4; k++)
    g.moveTo(-18, -22 + k * 3.5)
      .lineTo(18, -21 + k * 3.5)
      .stroke({ width: 1, color: 0x8a6a3a });
  c.addChild(g);
  return c;
}

/** One good as it sits on the pan (~100-130 units tall). */
export function createGoods(good: GoodId): Container {
  switch (good) {
    case 'rice_sack': {
      const s = createSack({ contents: 'rice', open: true, height: 124 });
      return s;
    }
    case 'potato_sack': {
      const c = new Container();
      const sack = createSack({ contents: 'none', open: true, height: 118 });
      const g = new Graphics();
      potatoes(g, 0, -100, 80, new ArtRandom(13));
      c.addChild(sack, g);
      return c;
    }
    case 'onion_basket':
      return createBasket({ contents: 'onion', count: 11, width: 164, seed: 19 });
    case 'lentil_bag':
      return lentilBag();
    case 'jaggery_block':
      return jaggery();
    case 'chilli_bundle':
      return chilliBundle();
    default: {
      const never: never = good;
      throw new Error(`unknown good ${String(never)}`);
    }
  }
}

/** A single brass standard weight (bat) of the scale (~30 x 26 units). */
export function drawBrassWeight(g: Graphics, x: number, y: number, s = 1): void {
  const w = 15 * s;
  const h = 20 * s;
  g.ellipse(x, y, w, 4.5 * s).fill(darken(MELA.brass, 0.5));
  g.moveTo(x - w, y)
    .lineTo(x - w * 0.86, y - h)
    .lineTo(x + w * 0.86, y - h)
    .lineTo(x + w, y)
    .closePath()
    .fill(
      lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
        [0, darken(MELA.brass, 0.38)],
        [0.3, 0xfff0b8],
        [0.55, MELA.brass],
        [1, darken(MELA.brass, 0.45)],
      ]),
    );
  g.ellipse(x, y - h, w * 0.86, 4 * s).fill(MELA.brassLight);
  g.roundRect(x - 3.5 * s, y - h - 9 * s, 7 * s, 9 * s, 3 * s).fill(MELA.brass);
  g.circle(x, y - h - 9 * s, 4.5 * s).fill(0xfff0b8);
  g.moveTo(x - w * 0.6, y - h * 0.45)
    .lineTo(x + w * 0.6, y - h * 0.45)
    .stroke({
      width: 1.2 * s,
      color: darken(MELA.brass, 0.4),
      alpha: 0.7,
    });
}

/** A neat pyramid of `count` brass weights (the declared quantity, countable at a glance). */
export function createWeightStack(count: number): Container {
  const c = new Container();
  c.label = `weights:${count}`;
  const g = new Graphics();
  const n = Math.max(0, Math.floor(count));
  const rows: number[] = [];
  let left = n;
  let width = Math.min(5, n);
  while (left > 0) {
    const k = Math.min(width, left);
    rows.push(k);
    left -= k;
    width = Math.max(1, width - 1);
  }
  softShadow(g, 0, 0, 70, 8, MELA.ink, 0.25);
  rows.forEach((k, r) => {
    for (let i = 0; i < k; i++) {
      const x = (i - (k - 1) / 2) * 32;
      drawBrassWeight(g, x, -r * 27, 1);
    }
  });
  c.addChild(g);
  return c;
}

/** A grey river stone (the hidden fraud in a sack). */
export function createStone(s = 1): Container {
  const c = new Container();
  const g = new Graphics();
  g.moveTo(-22 * s, 0)
    .bezierCurveTo(-30 * s, -18 * s, -8 * s, -30 * s, 8 * s, -27 * s)
    .bezierCurveTo(26 * s, -24 * s, 30 * s, -8 * s, 20 * s, 0)
    .closePath()
    .fill(
      rgrad(
        [
          [0, 0xb9b4ad],
          [0.7, 0x8a847c],
          [1, 0x5e5852],
        ],
        { x: 0.35, y: 0.3 },
        0.8,
      ),
    );
  g.ellipse(-6 * s, -18 * s, 6 * s, 3 * s).fill({ color: 0xffffff, alpha: 0.35 });
  c.addChild(g);
  return c;
}

/** A marigold garland (reward), hanging loop. */
export function createGarland(s = 1, half = false): Container {
  const c = new Container();
  const g = new Graphics();
  const n = half ? 9 : 17;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = Math.PI * (half ? 0.5 + t * 0.5 : t);
    const x = Math.cos(a) * 46 * s;
    const y = Math.sin(a) * 58 * s;
    marigold(g, x, y, 8.5 * s, i % 3 === 0 ? MELA.marigoldDeep : MELA.marigold);
  }
  for (const sx of half ? [-1] : [-1, 1])
    mangoLeaf(g, sx * 46 * s, -2 * s, 12 * s, sx * 1.2, MELA.neem);
  c.addChild(g);
  return c;
}

/** Embroidered cover cloth for a mystery basket / sack. */
export function createCoverCloth(w: number, h: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.moveTo(-w / 2, 0)
    .quadraticCurveTo(-w * 0.52, -h * 0.8, -w * 0.1, -h)
    .quadraticCurveTo(w * 0.1, -h * 1.08, w * 0.42, -h * 0.9)
    .quadraticCurveTo(w * 0.56, -h * 0.5, w / 2, 0)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.indigo, 0.25)],
        [1, MELA.indigo],
      ]),
    );
  const rnd = new ArtRandom(91);
  for (let i = 0; i < 14; i++) {
    const x = rnd.range(-w * 0.38, w * 0.38);
    const y = -rnd.range(h * 0.15, h * 0.85);
    g.circle(x, y, 3.2).fill(MELA.marigold);
    g.circle(x, y, 6).stroke({ width: 1, color: MELA.marigold, alpha: 0.6 });
  }
  g.moveTo(-w / 2, 0)
    .lineTo(w / 2, 0)
    .stroke({ width: 4, color: MELA.marigold });
  for (let i = 0; i < 9; i++) g.circle(-w / 2 + (w * i) / 8, 4, 3).fill(MELA.vermilion);
  c.addChild(g);
  return c;
}

/** A small heap of mangoes (probe baskets) drawn on a basket. */
export function createMangoBasket(count: number, covered: boolean): Container {
  const c = new Container();
  const b = createBasket({
    contents: covered ? 'none' : 'mango',
    count,
    width: 120,
    seed: 23 + count,
  });
  c.addChild(b);
  if (covered) {
    const cloth = createCoverCloth(132, 56);
    cloth.position.set(0, -44);
    c.addChild(cloth);
  }
  return c;
}

/** Draw coins (pictured quantity) as a tidy row on a Graphics. */
export function drawCoinRow(g: Graphics, n: number, cx: number, cy: number, s = 1.6): void {
  for (let i = 0; i < n; i++) drawGood(g, 'coin', cx + (i - (n - 1) / 2) * 15 * s, cy, s);
}
