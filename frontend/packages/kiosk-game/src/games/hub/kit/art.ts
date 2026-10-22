/**
 * Shared procedural drawings for the set-2 scenes: laddoo sweets, a covered basket, big brass coins,
 * a selection ring, a soft cloth mat and a gentle "light pool" under interactive props. Original vector
 * art in the Mela style (no numerals, no text; quantities are pictured).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { createBasket } from '../../../art/props/containers.ts';

/** One laddoo (round sweet) centred at (x, y) with radius r. */
export function drawLaddoo(g: Graphics, x: number, y: number, r: number): void {
  g.circle(x, y, r).fill(
    rgrad(
      [
        [0, lighten(MELA.saffron, 0.45)],
        [0.55, MELA.saffron],
        [1, darken(MELA.marigoldDeep, 0.25)],
      ],
      { x: 0.38, y: 0.32 },
      0.75,
    ),
  );
  // Boondi texture.
  for (let i = 0; i < 9; i++) {
    const a = i * 2.39996;
    const d = r * 0.62 * Math.sqrt((i + 0.5) / 9);
    g.circle(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.11).fill({
      color: darken(MELA.saffron, 0.18),
      alpha: 0.55,
    });
  }
  g.ellipse(x - r * 0.3, y - r * 0.38, r * 0.3, r * 0.18).fill({ color: 0xffffff, alpha: 0.45 });
}

/** A heaped pile of `count` laddoos on a leaf plate (origin = plate centre). */
export function createLaddooPile(count: number, r: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, r * 0.4, r * 3.2, r * 0.7, MELA.ink, 0.3);
  // Banana-leaf plate.
  g.ellipse(0, r * 0.2, r * 3.1, r * 0.95).fill(
    vgrad([
      [0, lighten(MELA.mango, 0.15)],
      [1, darken(MELA.neem, 0.1)],
    ]),
  );
  g.moveTo(-r * 2.9, r * 0.2)
    .lineTo(r * 2.9, r * 0.2)
    .stroke({ width: r * 0.08, color: lighten(MELA.mango, 0.4), alpha: 0.7 });
  const n = Math.max(0, Math.floor(count));
  const pts: { x: number; y: number }[] = [];
  let placed = 0;
  for (let row = 0; placed < n; row++) {
    const perRow = Math.max(1, 4 - row);
    for (let i = 0; i < perRow && placed < n; i++, placed++) {
      pts.push({ x: (i - (perRow - 1) / 2) * r * 1.75, y: -row * r * 1.45 });
    }
  }
  for (const p of pts) drawLaddoo(g, p.x, p.y - r * 0.55, r);
  c.addChild(g);
  return c;
}

/**
 * A basket hidden under a draped cloth (unknown contents): peacock cloth with a gold border and a
 * tassel. Origin = basket base centre.
 */
export function createCoveredBasket(width: number): Container {
  const c = new Container();
  const s = width / 72;
  c.addChild(createBasket({ width, contents: 'none' }));
  const h = width * 0.42;
  const g = new Graphics();
  const cloth = MELA.peacock;
  g.moveTo(-width * 0.56, -h * 0.55)
    .bezierCurveTo(-width * 0.6, -h * 1.5, -width * 0.2, -h * 2.05, 0, -h * 2.0)
    .bezierCurveTo(width * 0.25, -h * 2.05, width * 0.62, -h * 1.45, width * 0.56, -h * 0.5)
    .quadraticCurveTo(width * 0.28, -h * 0.25, 0, -h * 0.42)
    .quadraticCurveTo(-width * 0.3, -h * 0.25, -width * 0.56, -h * 0.55)
    .fill(
      rgrad(
        [
          [0, lighten(cloth, 0.3)],
          [0.6, cloth],
          [1, darken(cloth, 0.35)],
        ],
        { x: 0.4, y: 0.3 },
        0.8,
      ),
    );
  // Gold border along the hem.
  g.moveTo(-width * 0.56, -h * 0.55)
    .quadraticCurveTo(-width * 0.3, -h * 0.25, 0, -h * 0.42)
    .quadraticCurveTo(width * 0.28, -h * 0.25, width * 0.56, -h * 0.5)
    .stroke({ width: 5 * s, color: MELA.brass });
  for (let k = -4; k <= 4; k++)
    g.circle(k * width * 0.12, -h * 0.4 + Math.abs(k) * h * 0.035, 1.8 * s).fill(MELA.brassLight);
  // Folds.
  for (const fx of [-0.28, 0.05, 0.32])
    g.moveTo(width * fx, -h * 1.85)
      .quadraticCurveTo(width * (fx + 0.04), -h * 1.1, width * (fx - 0.02), -h * 0.45)
      .stroke({ width: 2 * s, color: darken(cloth, 0.4), alpha: 0.45 });
  // Paisley motif and tassel.
  g.circle(0, -h * 1.25, 6 * s).fill(MELA.marigold);
  g.circle(0, -h * 1.25, 3 * s).fill(MELA.vermilion);
  g.moveTo(0, -h * 2.0)
    .lineTo(0, -h * 2.25)
    .stroke({ width: 1.5 * s, color: MELA.brass });
  g.circle(0, -h * 2.3, 4 * s).fill(MELA.vermilion);
  c.addChild(g);
  return c;
}

/** A large brass coin (pictured quantity unit), centred. */
export function drawBigCoin(g: Graphics, x: number, y: number, r: number, shine = 1): void {
  softShadow(g, x, y + r * 0.85, r * 0.95, r * 0.24, MELA.ink, 0.35);
  g.circle(x, y + r * 0.1, r).fill(darken(MELA.brass, 0.35));
  g.circle(x, y, r).fill(
    rgrad(
      [
        [0, lighten(MELA.brassLight, 0.35 * shine)],
        [0.6, MELA.brass],
        [1, darken(MELA.brass, 0.25)],
      ],
      { x: 0.38, y: 0.32 },
      0.8,
    ),
  );
  g.circle(x, y, r * 0.78).stroke({ width: r * 0.07, color: darken(MELA.brass, 0.2), alpha: 0.8 });
  // Lotus emboss (decorative; never a numeral).
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.ellipse(x + Math.cos(a) * r * 0.36, y + Math.sin(a) * r * 0.36, r * 0.17, r * 0.08).fill({
      color: darken(MELA.brass, 0.18),
      alpha: 0.7,
    });
  }
  g.circle(x, y, r * 0.18).fill(darken(MELA.brass, 0.25));
  g.ellipse(x - r * 0.35, y - r * 0.42, r * 0.32, r * 0.14).fill({ color: 0xffffff, alpha: 0.55 });
}

/** A big coin as its own view. */
export function createBigCoin(r: number): Container {
  const c = new Container();
  const g = new Graphics();
  drawBigCoin(g, 0, 0, r);
  c.addChild(g);
  return c;
}

/**
 * Selection ring: a thick marigold ring with four petals at the diagonals — a shape cue (not only
 * colour) that an item is selected.
 */
export function createSelectionRing(radius: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.circle(0, 0, radius).stroke({ width: radius * 0.12, color: MELA.cream, alpha: 0.95 });
  g.circle(0, 0, radius).stroke({ width: radius * 0.07, color: MELA.marigoldDeep });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const px = Math.cos(a) * radius;
    const py = Math.sin(a) * radius;
    g.circle(px, py, radius * 0.13).fill(MELA.cream);
    g.circle(px, py, radius * 0.08).fill(MELA.vermilion);
  }
  c.addChild(g);
  c.eventMode = 'none';
  return c;
}

/** A soft cloth mat (rounded, bordered) on which diegetic choices rest. */
export function createClothMat(
  width: number,
  height: number,
  color: number = MELA.kumkum,
): Container {
  const c = new Container();
  const g = new Graphics();
  const r = Math.min(width, height) * 0.18;
  softShadow(g, 0, height * 0.52, width * 0.52, height * 0.12, MELA.ink, 0.35);
  g.roundRect(-width / 2, -height / 2 + height * 0.04, width, height, r).fill(darken(color, 0.4));
  g.roundRect(-width / 2, -height / 2, width, height, r).fill(
    vgrad([
      [0, lighten(color, 0.12)],
      [1, darken(color, 0.12)],
    ]),
  );
  const inset = Math.min(width, height) * 0.08;
  g.roundRect(
    -width / 2 + inset,
    -height / 2 + inset,
    width - inset * 2,
    height - inset * 2,
    r * 0.7,
  ).stroke({ width: inset * 0.35, color: MELA.brass, alpha: 0.85 });
  const step = Math.max(inset * 1.6, 14);
  for (let x = -width / 2 + inset * 2; x < width / 2 - inset * 1.5; x += step) {
    g.circle(x, -height / 2 + inset * 0.5, inset * 0.18).fill(MELA.brassLight);
    g.circle(x, height / 2 - inset * 0.5, inset * 0.18).fill(MELA.brassLight);
  }
  c.addChild(g);
  return c;
}

/** Warm light pool on the ground (additive-looking ellipse) that draws the eye to interactives. */
export function createLightPool(rx: number, ry: number, color = 0xffd27a): Graphics {
  const g = new Graphics();
  g.ellipse(0, 0, rx, ry).fill(
    rgrad([
      [0, `#${mixColor(color, 0xffffff, 0.2).toString(16).padStart(6, '0')}88`],
      [1, `#${color.toString(16).padStart(6, '0')}00`],
    ]),
  );
  g.blendMode = 'add';
  g.eventMode = 'none';
  return g;
}
