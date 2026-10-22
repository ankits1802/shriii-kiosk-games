/**
 * Don't-Tap fruit art. Fresh fruit (go) and spoiled fruit (no-go) differ by SHAPE cues first, colour
 * second (KSK-06): spoiled fruit sags flatter, is wrinkled, has rot spots with pale rims, a bite notch,
 * mould fuzz, wavy stink lines and buzzing flies. Fresh fruit is round, glossy, leafy and sparkling.
 * Drawn at radius `r` around the fruit centre; nothing here is text or a numeral.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from '../../art/color.ts';
import { rgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';

export type FruitKind = 'mango' | 'tomato' | 'pomegranate' | 'onion';
export const FRUIT_KINDS: readonly FruitKind[] = ['mango', 'tomato', 'pomegranate', 'onion'];

const BASE: Readonly<Record<FruitKind, number>> = {
  mango: 0xf5b32a,
  tomato: 0xe0412d,
  pomegranate: 0xc4283b,
  onion: 0xb5527a,
};

const SPOIL = 0x6b5a33;

function body(g: Graphics, kind: FruitKind, r: number, color: number, sag: number): void {
  const grad = rgrad(
    [
      [0, lighten(color, 0.45)],
      [0.55, color],
      [1, darken(color, 0.42)],
    ],
    { x: 0.36, y: 0.3 },
    0.78,
  );
  const ry = r * (1 - sag);
  switch (kind) {
    case 'mango':
      g.moveTo(-r * 0.15, -ry)
        .bezierCurveTo(r * 0.85, -ry * 1.05, r * 1.05, ry * 0.55, r * 0.2, ry)
        .bezierCurveTo(-r * 0.6, ry * 1.05, -r * 1.05, ry * 0.25, -r * 0.8, -ry * 0.35)
        .bezierCurveTo(-r * 0.62, -ry * 0.8, -r * 0.4, -ry * 0.95, -r * 0.15, -ry)
        .closePath()
        .fill(grad);
      break;
    case 'tomato':
      g.ellipse(0, r * sag * 0.4, r * 1.06, ry * 0.92).fill(grad);
      for (const k of [-0.45, 0, 0.45]) {
        g.moveTo(k * r, -ry * 0.75)
          .quadraticCurveTo(k * r * 1.25, 0, k * r * 0.9, ry * 0.7)
          .stroke({ width: Math.max(1.5, r * 0.035), color: darken(color, 0.25), alpha: 0.35 });
      }
      break;
    case 'pomegranate':
      g.circle(0, r * sag * 0.4, r * (1 - sag * 0.5)).fill(grad);
      // Crown.
      g.moveTo(-r * 0.24, -ry * 0.92)
        .lineTo(-r * 0.3, -ry * 1.22)
        .lineTo(-r * 0.12, -ry * 1.06)
        .lineTo(0, -ry * 1.28)
        .lineTo(r * 0.12, -ry * 1.06)
        .lineTo(r * 0.3, -ry * 1.22)
        .lineTo(r * 0.24, -ry * 0.92)
        .closePath()
        .fill(darken(color, 0.25));
      break;
    case 'onion':
      g.moveTo(0, -ry * 1.12)
        .bezierCurveTo(r * 0.2, -ry * 0.75, r * 1.05, -ry * 0.45, r * 0.95, ry * 0.25)
        .bezierCurveTo(r * 0.85, ry * 0.95, -r * 0.85, ry * 0.95, -r * 0.95, ry * 0.25)
        .bezierCurveTo(-r * 1.05, -ry * 0.45, -r * 0.2, -ry * 0.75, 0, -ry * 1.12)
        .closePath()
        .fill(grad);
      for (const k of [-0.55, -0.2, 0.2, 0.55]) {
        g.moveTo(0, -ry * 1.05)
          .quadraticCurveTo(k * r * 1.5, -ry * 0.1, k * r * 0.6, ry * 0.8)
          .stroke({ width: Math.max(1.2, r * 0.025), color: lighten(color, 0.4), alpha: 0.55 });
      }
      // Roots.
      for (const k of [-1, 0, 1]) {
        g.moveTo(k * r * 0.08, ry * 0.86)
          .lineTo(k * r * 0.16, ry * 1.04)
          .stroke({ width: Math.max(1, r * 0.03), color: 0xe8d6b0 });
      }
      break;
  }
}

function leaf(g: Graphics, kind: FruitKind, r: number, spoiled: boolean): void {
  const c = spoiled ? mixColor(MELA.mango, SPOIL, 0.7) : MELA.mango;
  const droop = spoiled ? 0.55 : 0;
  if (kind === 'mango' || kind === 'tomato') {
    g.moveTo(-r * 0.05, -r * 0.92)
      .lineTo(r * 0.02, -r * 1.18)
      .stroke({ width: r * 0.07, color: MELA.wood, cap: 'round' });
    g.moveTo(r * 0.02, -r * 1.12)
      .bezierCurveTo(
        r * 0.4,
        -r * (1.5 - droop),
        r * 0.85,
        -r * (1.3 - droop * 1.6),
        r * 0.95,
        -r * (1.0 - droop * 1.8),
      )
      .bezierCurveTo(
        r * 0.6,
        -r * (1.05 - droop),
        r * 0.3,
        -r * (1.05 - droop * 0.4),
        r * 0.02,
        -r * 1.12,
      )
      .fill(c);
  }
  if (kind === 'tomato') {
    for (let i = 0; i < 5; i += 1) {
      const a = -Math.PI / 2 + (i - 2) * 0.55;
      g.moveTo(0, -r * 0.82)
        .lineTo(
          Math.cos(a) * r * 0.42,
          -r * 0.82 + Math.sin(a) * r * 0.18 + r * (spoiled ? 0.22 : 0.1),
        )
        .stroke({ width: r * 0.08, color: c, cap: 'round' });
    }
  }
}

/** Irregular blotch (never round: round dark spots read as eyes). */
function blotch(
  g: Graphics,
  x: number,
  y: number,
  r: number,
  seed: number,
  color: number,
  alpha: number,
): void {
  const n = 9;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const k = 0.55 + 0.45 * Math.abs(Math.sin(seed * 12.9898 + i * 78.233));
    pts.push({ x: x + Math.cos(a) * r * k * 1.25, y: y + Math.sin(a) * r * k * 0.8 });
  }
  const last = pts[n - 1] as { x: number; y: number };
  const first = pts[0] as { x: number; y: number };
  g.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i += 1) {
    const p = pts[i] as { x: number; y: number };
    const q = pts[(i + 1) % n] as { x: number; y: number };
    g.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  g.closePath().fill({ color, alpha });
}

/**
 * Spoilage marks (shape cues): asymmetric bruises, zig-zag cracks, edge wrinkles and a mould patch.
 * Marks are deliberately placed off-axis and never in pairs, so the fruit never reads as a face.
 */
function spoilage(g: Graphics, r: number): void {
  blotch(g, r * 0.42, r * 0.36, r * 0.36, 4, 0x5a4420, 0.62);
  blotch(g, r * 0.1, r * 0.62, r * 0.2, 6, 0x5a4420, 0.5);
  blotch(g, -r * 0.66, r * 0.12, r * 0.14, 2, 0x4a3818, 0.55);
  // Zig-zag cracks.
  for (const [x, y, k] of [
    [-0.15, -0.55, 1],
    [0.05, -0.1, -1],
  ] as const) {
    g.moveTo(x * r, y * r)
      .lineTo((x + 0.1) * r, (y + 0.08 * k) * r)
      .lineTo((x + 0.18) * r, (y - 0.02 * k) * r)
      .lineTo((x + 0.3) * r, (y + 0.07 * k) * r)
      .stroke({ width: Math.max(1.5, r * 0.03), color: 0x231709, alpha: 0.7, cap: 'round' });
  }
  // Edge wrinkles (short hatching along the outline).
  for (let i = 0; i < 6; i += 1) {
    const a = 2.3 + i * 0.28;
    const x0 = Math.cos(a) * r * 0.92;
    const y0 = Math.sin(a) * r * 0.8;
    g.moveTo(x0, y0)
      .lineTo(x0 * 0.82, y0 * 0.82)
      .stroke({ width: Math.max(1.2, r * 0.025), color: 0x2a1d0c, alpha: 0.45, cap: 'round' });
  }
  // Mould patch: a pale fuzzy cluster on the upper left.
  g.circle(-r * 0.36, -r * 0.3, r * 0.2).fill({ color: 0xc9d4b2, alpha: 0.55 });
  for (let i = 0; i < 18; i += 1) {
    const a = i * 2.39996;
    const d = r * 0.26 * Math.sqrt(i / 18);
    g.circle(-r * 0.36 + Math.cos(a) * d, -r * 0.3 + Math.sin(a) * d, r * (0.05 - i * 0.0013)).fill(
      {
        color: 0xeef2e2,
        alpha: 0.9,
      },
    );
  }
}

/** A fly: dark body, two pale wings. */
function fly(r: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = Math.max(4, r * 0.09);
  g.ellipse(-s * 0.55, -s * 0.55, s * 0.75, s * 0.42).fill({ color: 0xffffff, alpha: 0.75 });
  g.ellipse(s * 0.55, -s * 0.55, s * 0.75, s * 0.42).fill({ color: 0xffffff, alpha: 0.75 });
  g.ellipse(0, 0, s * 0.62, s * 0.85).fill(0x1d1712);
  g.circle(0, -s * 0.7, s * 0.42).fill(0x1d1712);
  c.addChild(g);
  return c;
}

/** Built fruit: the art plus animatable parts. */
export interface FruitArt {
  readonly view: Container;
  readonly flies: readonly Container[];
  readonly stink: Graphics | null;
  readonly sparkle: Graphics | null;
}

/** Optional baking hook (texture cache): `bake(key, build)` returns a cached sprite of `build()`. */
export type Baker = (key: string, build: () => Container) => Container;

/** Draw a fruit of `kind` (fresh or spoiled) at radius `r`, centred on (0, 0). */
export function drawFruit(kind: FruitKind, spoiled: boolean, r: number, bake?: Baker): FruitArt {
  const view = new Container();
  const build = (): Container => {
    const g = new Graphics();
    const color = spoiled ? mixColor(BASE[kind], SPOIL, 0.68) : BASE[kind];
    const sag = spoiled ? 0.16 : 0;
    leaf(g, kind, r, spoiled);
    body(g, kind, r, color, sag);
    if (spoiled) {
      spoilage(g, r);
    } else {
      // Gloss: a crisp highlight and a soft rim light.
      g.ellipse(-r * 0.36, -r * 0.42, r * 0.28, r * 0.15).fill({ color: 0xffffff, alpha: 0.62 });
      g.circle(-r * 0.52, -r * 0.18, r * 0.06).fill({ color: 0xffffff, alpha: 0.5 });
    }
    return g;
  };
  view.addChild(
    bake ? bake(`fruit.${kind}.${spoiled ? 's' : 'f'}.${Math.round(r)}`, build) : build(),
  );
  const flies: Container[] = [];
  let stink: Graphics | null = null;
  let sparkle: Graphics | null = null;
  if (spoiled) {
    stink = new Graphics();
    for (const k of [-0.45, 0, 0.45]) {
      stink
        .moveTo(k * r, -r * 1.05)
        .bezierCurveTo((k + 0.18) * r, -r * 1.3, (k - 0.18) * r, -r * 1.48, k * r, -r * 1.72)
        .stroke({ width: Math.max(2, r * 0.05), color: 0x8d9a5c, alpha: 0.75, cap: 'round' });
    }
    view.addChild(stink);
    for (let i = 0; i < 3; i += 1) {
      const f = fly(r);
      flies.push(f);
      view.addChild(f);
    }
  } else {
    sparkle = new Graphics();
    const s = r * 0.22;
    sparkle
      .poly([
        0,
        -s,
        s * 0.22,
        -s * 0.22,
        s,
        0,
        s * 0.22,
        s * 0.22,
        0,
        s,
        -s * 0.22,
        s * 0.22,
        -s,
        0,
        -s * 0.22,
        -s * 0.22,
      ])
      .fill({
        color: 0xfffbe6,
        alpha: 0.95,
      });
    sparkle.position.set(r * 0.62, -r * 0.7);
    sparkle.blendMode = 'add';
    view.addChild(sparkle);
  }
  return { view, flies, stink, sparkle };
}
