/**
 * Steady Hands props: the standing brass samai lamp (five wicks) with layered flames and glow, the
 * brass hold plate with a henna palm print, a temple bell and a sky lantern. Original vector art.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';

/** One flame shape (origin at the wick), white-hot core to orange edge. */
export function drawFlame(g: Graphics, h: number): Graphics {
  const w = h * 0.42;
  g.moveTo(0, 0)
    .bezierCurveTo(-w, -h * 0.2, -w * 0.7, -h * 0.62, 0, -h)
    .bezierCurveTo(w * 0.7, -h * 0.62, w, -h * 0.2, 0, 0)
    .fill(
      rgrad(
        [
          [0, 0xffffff],
          [0.3, 0xfff3b0],
          [0.65, 0xffa630],
          [1, 0xe8551e],
        ],
        { x: 0.5, y: 0.8 },
        0.75,
      ),
    );
  g.ellipse(0, -h * 0.18, w * 0.28, h * 0.16).fill({ color: 0x5b8cff, alpha: 0.35 });
  return g;
}

/** Standing brass lamp; origin = base centre; `size` = overall height. Exposes wick positions. */
export class SamaiLamp {
  readonly view = new Container();
  readonly flames = new Container();
  readonly wicks: { x: number; y: number }[] = [];
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    const s = size;
    const g = new Graphics();
    softShadow(g, 0, 0, s * 0.3, s * 0.05, MELA.ink, 0.5);
    const brass = (): ReturnType<typeof vgrad> =>
      vgrad([
        [0, lighten(MELA.brassLight, 0.2)],
        [0.5, MELA.brass],
        [1, darken(MELA.brass, 0.35)],
      ]);
    // Domed base.
    g.moveTo(-s * 0.26, 0)
      .quadraticCurveTo(-s * 0.24, -s * 0.12, -s * 0.06, -s * 0.16)
      .lineTo(s * 0.06, -s * 0.16)
      .quadraticCurveTo(s * 0.24, -s * 0.12, s * 0.26, 0)
      .closePath()
      .fill(brass());
    g.ellipse(0, 0, s * 0.26, s * 0.03).fill(darken(MELA.brass, 0.3));
    // Stem with knops.
    g.roundRect(-s * 0.03, -s * 0.72, s * 0.06, s * 0.58, s * 0.02).fill(
      vgrad([
        [0, MELA.brass],
        [1, darken(MELA.brass, 0.25)],
      ]),
    );
    for (const y of [-0.25, -0.42, -0.6]) {
      g.ellipse(0, s * y, s * 0.07, s * 0.035).fill(
        rgrad(
          [
            [0, lighten(MELA.brassLight, 0.3)],
            [1, darken(MELA.brass, 0.3)],
          ],
          { x: 0.35, y: 0.3 },
          0.8,
        ),
      );
    }
    // Oil dish with five spouts (a star when seen from the front).
    g.moveTo(-s * 0.3, -s * 0.76)
      .quadraticCurveTo(0, -s * 0.66, s * 0.3, -s * 0.76)
      .lineTo(s * 0.24, -s * 0.8)
      .quadraticCurveTo(0, -s * 0.76, -s * 0.24, -s * 0.8)
      .closePath()
      .fill(brass());
    g.ellipse(0, -s * 0.785, s * 0.25, s * 0.03).fill(darken(MELA.brass, 0.5));
    g.ellipse(0, -s * 0.785, s * 0.21, s * 0.018).fill({ color: 0xe8b04a, alpha: 0.85 });
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * s * 0.12;
      const y = -s * 0.79 - (i === 2 ? s * 0.01 : 0);
      this.wicks.push({ x, y });
      g.circle(x, y, s * 0.012).fill(MELA.woodDark);
    }
    // Finial: a small peacock silhouette above the dish.
    g.moveTo(0, -s * 0.8)
      .lineTo(0, -s * 0.9)
      .stroke({ width: s * 0.02, color: MELA.brass });
    g.circle(0, -s * 0.93, s * 0.035).fill(MELA.brass);
    g.moveTo(-s * 0.01, -s * 0.96)
      .quadraticCurveTo(s * 0.05, -s * 1.02, s * 0.02, -s * 0.94)
      .fill(darken(MELA.brass, 0.15));
    g.ellipse(-s * 0.012, -s * 0.5, s * 0.008, s * 0.12).fill({ color: 0xffffff, alpha: 0.4 });
    this.view.addChild(g, this.flames);
    for (const w of this.wicks) {
      const f = drawFlame(new Graphics(), s * 0.18);
      f.position.set(w.x, w.y);
      f.scale.set(0.01);
      this.flames.addChild(f);
    }
  }
}

/** Brass plate with a rangoli border and a henna palm print; origin = centre. */
export function createHoldPlate(width: number, height: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, height * 0.42, width * 0.52, height * 0.12, MELA.ink, 0.45);
  g.ellipse(0, height * 0.06, width / 2, height / 2).fill(darken(MELA.brass, 0.4));
  g.ellipse(0, 0, width / 2, height / 2).fill(
    rgrad(
      [
        [0, lighten(MELA.brassLight, 0.35)],
        [0.6, MELA.brass],
        [1, darken(MELA.brass, 0.25)],
      ],
      { x: 0.4, y: 0.35 },
      0.75,
    ),
  );
  g.ellipse(0, 0, width * 0.43, height * 0.41).stroke({
    width: height * 0.03,
    color: darken(MELA.brass, 0.3),
    alpha: 0.7,
  });
  // Rangoli dots around the rim.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const col = [MELA.vermilion, MELA.marigold, MELA.peacock][i % 3] as number;
    g.circle(Math.cos(a) * width * 0.465, Math.sin(a) * height * 0.455, height * 0.025).fill(col);
  }
  c.addChild(g);
  // Henna palm (fingers up) in terracotta.
  const p = new Graphics();
  const ph = height * 0.62;
  const ink = MELA.terracotta;
  p.ellipse(0, ph * 0.18, ph * 0.26, ph * 0.28).fill({ color: ink, alpha: 0.85 });
  const fingers: [number, number, number][] = [
    [-0.2, -0.12, 0.34],
    [-0.07, -0.2, 0.4],
    [0.07, -0.2, 0.42],
    [0.2, -0.13, 0.36],
  ];
  for (const [fx, fy, len] of fingers) {
    p.roundRect(
      ph * fx - ph * 0.055,
      ph * fy - ph * len + ph * 0.18,
      ph * 0.11,
      ph * len,
      ph * 0.055,
    ).fill({
      color: ink,
      alpha: 0.85,
    });
  }
  p.roundRect(-ph * 0.42, ph * 0.02, ph * 0.1, ph * 0.3, ph * 0.05).fill({
    color: ink,
    alpha: 0.85,
  });
  p.rotation = -0.15;
  // Henna motif on the palm.
  p.circle(0, ph * 0.18, ph * 0.1).stroke({ width: ph * 0.02, color: MELA.cream, alpha: 0.7 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    p.circle(Math.cos(a) * ph * 0.16, ph * 0.18 + Math.sin(a) * ph * 0.16, ph * 0.02).fill({
      color: MELA.cream,
      alpha: 0.7,
    });
  }
  c.addChild(p);
  return c;
}

/** Temple bell hanging from its hook; origin = hook. */
export function createBell(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  g.moveTo(0, 0)
    .lineTo(0, s * 0.3)
    .stroke({ width: s * 0.04, color: MELA.woodDark });
  g.moveTo(-s * 0.08, s * 0.3)
    .quadraticCurveTo(-s * 0.3, s * 0.42, -s * 0.34, s * 0.95)
    .lineTo(s * 0.34, s * 0.95)
    .quadraticCurveTo(s * 0.3, s * 0.42, s * 0.08, s * 0.3)
    .closePath()
    .fill(
      rgrad(
        [
          [0, lighten(MELA.brassLight, 0.3)],
          [0.6, MELA.brass],
          [1, darken(MELA.brass, 0.45)],
        ],
        { x: 0.35, y: 0.35 },
        0.8,
      ),
    );
  g.ellipse(0, s * 0.95, s * 0.34, s * 0.06).fill(darken(MELA.brass, 0.35));
  g.circle(0, s * 1.02, s * 0.06).fill(darken(MELA.brass, 0.5));
  g.moveTo(-s * 0.3, s * 0.7)
    .quadraticCurveTo(0, s * 0.76, s * 0.3, s * 0.7)
    .stroke({
      width: s * 0.03,
      color: darken(MELA.brass, 0.3),
    });
  c.addChild(g);
  return c;
}

/** Paper sky lantern with its glow; origin = centre. */
export function createSkyLantern(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  g.moveTo(-s * 0.3, -s * 0.5)
    .lineTo(s * 0.3, -s * 0.5)
    .quadraticCurveTo(s * 0.42, 0, s * 0.22, s * 0.5)
    .lineTo(-s * 0.22, s * 0.5)
    .quadraticCurveTo(-s * 0.42, 0, -s * 0.3, -s * 0.5)
    .fill(
      rgrad(
        [
          [0, 0xfff1c0],
          [0.6, 0xffa94d],
          [1, 0xd9572b],
        ],
        { x: 0.5, y: 0.75 },
        0.8,
      ),
    );
  for (const x of [-0.12, 0.12])
    g.moveTo(s * x, -s * 0.5)
      .quadraticCurveTo(s * x * 1.4, 0, s * x * 0.8, s * 0.5)
      .stroke({ width: s * 0.02, color: 0xc8662e, alpha: 0.5 });
  g.circle(0, s * 0.42, s * 0.06).fill(0xffffff);
  c.addChild(g);
  return c;
}
