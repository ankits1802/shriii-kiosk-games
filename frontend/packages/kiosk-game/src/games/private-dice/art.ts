/**
 * Private Dice props: the player's cupped hands (lower palm + covering hand), a carved wooden die with
 * pips (pips are decorative, never digits — ENG-11 allowlists dice pips), the six report pictures, and
 * the "someone watching?" eye. Original vector art.
 *
 * Privacy: `drawDieFace` paints pips into a Graphics and returns nothing; callers keep no copy of the
 * face value (mode a: the true outcome is never stored).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';

/** Pip positions for faces 1..6 on a unit square (-1..1). */
const PIPS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[0, 0]],
  2: [
    [-0.5, -0.5],
    [0.5, 0.5],
  ],
  3: [
    [-0.5, -0.5],
    [0, 0],
    [0.5, 0.5],
  ],
  4: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ],
  5: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0, 0],
    [-0.5, 0.5],
    [0.5, 0.5],
  ],
  6: [
    [-0.5, -0.55],
    [0.5, -0.55],
    [-0.5, 0],
    [0.5, 0],
    [-0.5, 0.55],
    [0.5, 0.55],
  ],
};

/** Paint a die face (top view) centred at (0, 0) into `g` (cleared first). */
export function drawDieFace(g: Graphics, face: number, size: number): void {
  g.clear();
  const s = size;
  g.roundRect(-s / 2, -s / 2 + s * 0.06, s, s, s * 0.2).fill(darken(MELA.parchment, 0.35));
  g.roundRect(-s / 2, -s / 2, s, s, s * 0.2).fill(
    rgrad(
      [
        [0, 0xfffbf0],
        [0.7, MELA.cream],
        [1, MELA.parchment],
      ],
      { x: 0.35, y: 0.3 },
      0.85,
    ),
  );
  g.roundRect(-s / 2, -s / 2, s, s, s * 0.2).stroke({ width: s * 0.03, color: MELA.sandstone });
  const pips = PIPS[face] ?? [];
  const red = face === 1 || face === 4;
  for (const [px, py] of pips) {
    g.circle(px * s * 0.36, py * s * 0.36, s * 0.095).fill(red ? MELA.kumkum : MELA.ink);
    g.circle(px * s * 0.36 - s * 0.02, py * s * 0.36 - s * 0.025, s * 0.03).fill({
      color: 0xffffff,
      alpha: 0.35,
    });
  }
}

/** A report picture: the die face on its own (tile pictogram). */
export function createDieFacePicture(face: number, size: number): Container {
  const c = new Container();
  const g = new Graphics();
  drawDieFace(g, face, size);
  c.addChild(g);
  return c;
}

/** The player's cupped hands: lower palm (behind the die) and covering hand (in front). */
export class CuppedHands {
  readonly view = new Container();
  readonly lower = new Container();
  readonly upper = new Container();
  /** Where the die rests (local). */
  readonly seat: { x: number; y: number };

  constructor(width: number) {
    const w = width;
    const skin = 0xc27a44;
    const sleeve = MELA.peacockDeep;
    const g = new Graphics();
    softShadow(g, 0, w * 0.32, w * 0.55, w * 0.07, MELA.ink, 0.4);
    // The player's own forearms rising from the bottom edge: skin wrists (bangles) into the palm,
    // then the sleeve with a brass cuff. Drawn per side, mirrored.
    for (const sx of [-1, 1]) {
      // Forearm (skin), wrist at the palm edge.
      g.moveTo(sx * w * 0.57, w * 0.7)
        .quadraticCurveTo(sx * w * 0.48, w * 0.36, sx * w * 0.42, w * 0.08)
        .lineTo(sx * w * 0.29, w * 0.22)
        .quadraticCurveTo(sx * w * 0.32, w * 0.48, sx * w * 0.37, w * 0.72)
        .closePath()
        .fill(
          vgrad([
            [0, lighten(skin, 0.08)],
            [1, darken(skin, 0.28)],
          ]),
        );
      // Sleeve (covers the lower forearm) with a darker inner fold.
      g.moveTo(sx * w * 0.7, w * 0.72)
        .quadraticCurveTo(sx * w * 0.6, w * 0.52, sx * w * 0.55, w * 0.42)
        .quadraticCurveTo(sx * w * 0.44, w * 0.37, sx * w * 0.3, w * 0.44)
        .quadraticCurveTo(sx * w * 0.31, w * 0.6, sx * w * 0.3, w * 0.74)
        .closePath()
        .fill(
          vgrad([
            [0, lighten(sleeve, 0.22)],
            [1, darken(sleeve, 0.35)],
          ]),
        );
      g.moveTo(sx * w * 0.5, w * 0.48)
        .quadraticCurveTo(sx * w * 0.47, w * 0.6, sx * w * 0.5, w * 0.72)
        .stroke({ width: w * 0.012, color: darken(sleeve, 0.45), alpha: 0.6 });
      // Brass cuff with a dotted border.
      g.moveTo(sx * w * 0.56, w * 0.43)
        .quadraticCurveTo(sx * w * 0.44, w * 0.37, sx * w * 0.3, w * 0.45)
        .stroke({ width: w * 0.03, color: MELA.brass });
      for (let i = 0; i < 5; i++) {
        const t = (i + 0.5) / 5;
        const x = sx * w * (0.55 - 0.24 * t);
        const y = w * (0.43 - 0.06 * Math.sin(Math.PI * t) + 0.01 * t);
        g.circle(x, y, w * 0.007).fill(MELA.vermilion);
      }
    }
    // Lower palm: a shallow bowl.
    g.moveTo(-w * 0.45, -w * 0.02)
      .quadraticCurveTo(-w * 0.42, w * 0.3, 0, w * 0.32)
      .quadraticCurveTo(w * 0.42, w * 0.3, w * 0.45, -w * 0.02)
      .quadraticCurveTo(0, w * 0.08, -w * 0.45, -w * 0.02)
      .fill(
        rgrad(
          [
            [0, lighten(skin, 0.25)],
            [1, darken(skin, 0.25)],
          ],
          { x: 0.45, y: 0.3 },
          0.8,
        ),
      );
    g.ellipse(0, w * 0.02, w * 0.36, w * 0.07).fill({ color: darken(skin, 0.35), alpha: 0.55 });
    // Bangles.
    for (const sx of [-1, 1]) {
      g.ellipse(sx * w * 0.37, w * 0.2, w * 0.075, w * 0.03).stroke({
        width: w * 0.022,
        color: MELA.vermilion,
      });
      g.ellipse(sx * w * 0.38, w * 0.25, w * 0.075, w * 0.03).stroke({
        width: w * 0.018,
        color: MELA.brass,
      });
    }
    this.lower.addChild(g);
    // Covering hand (fingers curled over).
    const h = new Graphics();
    h.moveTo(-w * 0.44, w * 0.0)
      .bezierCurveTo(-w * 0.46, -w * 0.32, -w * 0.15, -w * 0.38, w * 0.05, -w * 0.34)
      .bezierCurveTo(w * 0.35, -w * 0.3, w * 0.48, -w * 0.12, w * 0.44, w * 0.02)
      .quadraticCurveTo(0, w * 0.14, -w * 0.44, w * 0.0)
      .fill(
        rgrad(
          [
            [0, lighten(skin, 0.3)],
            [1, darken(skin, 0.2)],
          ],
          { x: 0.4, y: 0.25 },
          0.85,
        ),
      );
    for (let i = 0; i < 4; i++) {
      const x = -w * 0.26 + i * w * 0.15;
      h.moveTo(x, -w * 0.3)
        .quadraticCurveTo(x + w * 0.03, -w * 0.12, x + w * 0.01, w * 0.04)
        .stroke({ width: w * 0.012, color: darken(skin, 0.35), alpha: 0.6 });
    }
    // Henna on the back of the hand.
    h.circle(w * 0.02, -w * 0.16, w * 0.05).stroke({
      width: w * 0.01,
      color: MELA.terracotta,
      alpha: 0.8,
    });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      h.circle(
        w * 0.02 + Math.cos(a) * w * 0.08,
        -w * 0.16 + Math.sin(a) * w * 0.08,
        w * 0.012,
      ).fill({
        color: MELA.terracotta,
        alpha: 0.8,
      });
    }
    this.upper.addChild(h);
    this.seat = { x: 0, y: -w * 0.05 };
    this.view.addChild(this.lower);
  }
}

/** A small wooden die seen at three-quarters (closed hands peek / shaking). */
export function createDieBlock(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  g.poly([-s * 0.5, -s * 0.2, 0, -s * 0.45, s * 0.5, -s * 0.2, 0, s * 0.05]).fill(MELA.cream);
  g.poly([-s * 0.5, -s * 0.2, 0, s * 0.05, 0, s * 0.5, -s * 0.5, s * 0.25]).fill(MELA.parchment);
  g.poly([s * 0.5, -s * 0.2, 0, s * 0.05, 0, s * 0.5, s * 0.5, s * 0.25]).fill(
    darken(MELA.parchment, 0.12),
  );
  g.circle(0, -s * 0.2, s * 0.06).fill(MELA.ink);
  g.circle(-s * 0.25, s * 0.12, s * 0.05).fill(MELA.ink);
  g.circle(s * 0.25, s * 0.12, s * 0.05).fill(MELA.ink);
  c.addChild(g);
  return c;
}
