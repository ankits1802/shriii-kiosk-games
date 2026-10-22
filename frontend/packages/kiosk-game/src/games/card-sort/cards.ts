/**
 * Card art for the fortune-teller's deck. Each card face pictures 1-4 identical symbols (mango, clay
 * pot, star, leaf); colour always comes with a pattern (red + dots, green + stripes, yellow + checks,
 * blue + plain) so the colour dimension never depends on colour vision alone. Counts are pictured
 * quantities, never numerals. Card backs carry a gold mandala.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { CardFace } from './CardSortModule.ts';

const FILL: Readonly<Record<CardFace['colourPattern'], number>> = {
  red_dots: 0xd23b2f,
  green_stripes: 0x3f8f3e,
  yellow_checks: 0xe7b11e,
  blue_plain: 0x2f5fa7,
};

/** Symbol outline path centred at (0, 0) with radius s. */
function symbolPath(g: Graphics, shape: CardFace['shape'], s: number): void {
  switch (shape) {
    case 'mango':
      g.moveTo(-s * 0.1, -s)
        .bezierCurveTo(s * 0.85, -s * 1.02, s * 1.0, s * 0.55, s * 0.18, s)
        .bezierCurveTo(-s * 0.6, s * 1.02, -s * 1.0, s * 0.2, -s * 0.78, -s * 0.38)
        .bezierCurveTo(-s * 0.6, -s * 0.8, -s * 0.38, -s * 0.96, -s * 0.1, -s)
        .closePath();
      break;
    case 'pot':
      g.moveTo(-s * 0.42, -s * 0.95)
        .lineTo(s * 0.42, -s * 0.95)
        .lineTo(s * 0.34, -s * 0.7)
        .bezierCurveTo(s * 1.1, -s * 0.5, s * 1.05, s * 0.85, 0, s * 0.95)
        .bezierCurveTo(-s * 1.05, s * 0.85, -s * 1.1, -s * 0.5, -s * 0.34, -s * 0.7)
        .closePath();
      break;
    case 'star': {
      const pts: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? s : s * 0.45;
        pts.push(Math.cos(a) * rr, Math.sin(a) * rr + s * 0.05);
      }
      g.poly(pts);
      break;
    }
    case 'leaf':
      g.moveTo(0, -s)
        .bezierCurveTo(s * 0.9, -s * 0.45, s * 0.75, s * 0.55, 0, s)
        .bezierCurveTo(-s * 0.75, s * 0.55, -s * 0.9, -s * 0.45, 0, -s)
        .closePath();
      break;
  }
}

/** Pattern lines/dots over a symbol, clipped by a mask copy of the symbol. */
function patterned(face: CardFace, s: number): Container {
  const c = new Container();
  const base = new Graphics();
  symbolPath(base, face.shape, s);
  const color = FILL[face.colourPattern];
  base.fill(
    rgrad(
      [
        [0, lighten(color, 0.3)],
        [0.7, color],
        [1, darken(color, 0.3)],
      ],
      { x: 0.38, y: 0.32 },
      0.8,
    ),
  );
  c.addChild(base);
  const pat = new Graphics();
  const light = 0xfff6e0;
  switch (face.colourPattern) {
    case 'red_dots':
      for (let y = -s; y <= s; y += s * 0.42) {
        for (let x = -s; x <= s; x += s * 0.42) {
          pat.circle(x + ((y / (s * 0.42)) % 2 ? s * 0.21 : 0), y, s * 0.1).fill(light);
        }
      }
      break;
    case 'green_stripes':
      for (let x = -s * 1.6; x <= s * 1.6; x += s * 0.36) {
        pat
          .moveTo(x, -s * 1.1)
          .lineTo(x + s * 0.7, s * 1.1)
          .stroke({ width: s * 0.11, color: light });
      }
      break;
    case 'yellow_checks':
      for (let y = -s; y < s; y += s * 0.4) {
        for (let x = -s; x < s; x += s * 0.4) {
          if ((Math.round((x + s) / (s * 0.4)) + Math.round((y + s) / (s * 0.4))) % 2 === 0) {
            pat.rect(x, y, s * 0.4, s * 0.4).fill({ color: darken(color, 0.35), alpha: 0.55 });
          }
        }
      }
      break;
    case 'blue_plain':
      break;
  }
  const mask = new Graphics();
  symbolPath(mask, face.shape, s);
  mask.fill(0xffffff);
  pat.mask = mask;
  c.addChild(pat, mask);
  const outline = new Graphics();
  symbolPath(outline, face.shape, s);
  outline.stroke({ width: Math.max(2, s * 0.09), color: darken(color, 0.5) });
  c.addChild(outline);
  // Highlight.
  const hi = new Graphics()
    .ellipse(-s * 0.32, -s * 0.38, s * 0.22, s * 0.12)
    .fill({ color: 0xffffff, alpha: 0.4 });
  c.addChild(hi);
  return c;
}

/** Positions of `n` symbols on a card of size w x h. */
function layoutSymbols(n: number, w: number, h: number): { x: number; y: number; s: number }[] {
  const s = Math.min(w, h) * (n === 1 ? 0.27 : n === 2 ? 0.2 : 0.17);
  switch (n) {
    case 1:
      return [{ x: 0, y: 0, s }];
    case 2:
      return [
        { x: 0, y: -h * 0.2, s },
        { x: 0, y: h * 0.2, s },
      ];
    case 3:
      return [
        { x: 0, y: -h * 0.24, s },
        { x: -w * 0.2, y: h * 0.16, s },
        { x: w * 0.2, y: h * 0.16, s },
      ];
    default:
      return [
        { x: -w * 0.2, y: -h * 0.18, s },
        { x: w * 0.2, y: -h * 0.18, s },
        { x: -w * 0.2, y: h * 0.18, s },
        { x: w * 0.2, y: h * 0.18, s },
      ];
  }
}

/** Card face of width w (height 1.38 w), centred on (0, 0). */
export function drawCardFace(face: CardFace, w: number): Container {
  const h = w * 1.38;
  const c = new Container();
  const g = new Graphics();
  const r = w * 0.08;
  g.roundRect(-w / 2 + w * 0.03, -h / 2 + w * 0.05, w, h, r).fill({ color: 0x1a0d08, alpha: 0.28 });
  g.roundRect(-w / 2, -h / 2, w, h, r).fill(
    vgrad([
      [0, 0xfffaee],
      [1, MELA.parchment],
    ]),
  );
  g.roundRect(-w / 2 + w * 0.05, -h / 2 + w * 0.05, w * 0.9, h - w * 0.1, r * 0.7).stroke({
    width: Math.max(2, w * 0.025),
    color: MELA.brass,
  });
  // Corner flourishes (decorative paisley dots, no symbols that could be read as numbers).
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    g.circle(sx * w * 0.36, sy * h * 0.42, w * 0.03).fill(MELA.vermilion);
    g.circle(sx * w * 0.31, sy * h * 0.42, w * 0.016).fill(MELA.brass);
    g.circle(sx * w * 0.36, sy * h * 0.37, w * 0.016).fill(MELA.brass);
  }
  c.addChild(g);
  for (const p of layoutSymbols(face.count, w, h)) {
    const sym = patterned(face, p.s);
    sym.position.set(p.x, p.y);
    c.addChild(sym);
  }
  return c;
}

/** Card back (maroon with a gold mandala). */
export function drawCardBack(w: number): Container {
  const h = w * 1.38;
  const c = new Container();
  const g = new Graphics();
  const r = w * 0.08;
  g.roundRect(-w / 2, -h / 2, w, h, r).fill(
    vgrad([
      [0, 0x8a1f2c],
      [1, 0x5a1220],
    ]),
  );
  g.roundRect(-w / 2 + w * 0.06, -h / 2 + w * 0.06, w * 0.88, h - w * 0.12, r * 0.6).stroke({
    width: Math.max(2, w * 0.025),
    color: MELA.brass,
  });
  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * Math.PI * 2;
    g.ellipse(Math.cos(a) * w * 0.17, Math.sin(a) * w * 0.17, w * 0.07, w * 0.035).fill({
      color: MELA.brass,
      alpha: 0.85,
    });
  }
  g.circle(0, 0, w * 0.1).fill(MELA.marigold);
  g.circle(0, 0, w * 0.05).fill(MELA.vermilion);
  c.addChild(g);
  return c;
}
