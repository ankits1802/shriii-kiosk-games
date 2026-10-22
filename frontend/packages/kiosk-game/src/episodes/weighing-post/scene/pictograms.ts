/**
 * Pictograms for the choice tokens. Every option is a picture (no words, no numerals; dice pips are the
 * allowlisted decorative exception, ENG-11). Dilemma options share one neutral style: no colour, glow or
 * shape suggests a "right" answer (never moralise).
 *
 * All drawings are centred on (0, 0) inside a box of edge `s` (local units = stage px of the token).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { marigold, rgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { drawGood } from '../../../art/props/goods.ts';
import { drawBrassWeight } from './goods.ts';
import type { ChoiceKind } from './types.ts';

const INK = MELA.ink;
const SKIN = 0xb57a50;
const SKIN_DARK = 0x8d5a3b;

/** Optional per-trial data for pictograms (pictured amounts). */
export interface PictogramData {
  readonly coins?: number;
  readonly safeCoins?: number;
  readonly winCoins?: number;
  readonly safeItems?: number;
  readonly riskyItems?: number;
}

function hand(g: Graphics, x: number, y: number, s: number, rot: number, open: boolean): void {
  // A simple mitten hand with thumb; rot in radians (0 = fingers up).
  const c = Math.cos(rot);
  const si = Math.sin(rot);
  const p = (px: number, py: number): [number, number] => [
    x + (px * c - py * si) * s,
    y + (px * si + py * c) * s,
  ];
  const pts: [number, number][] = open
    ? [
        [-10, 12],
        [-12, -6],
        [-9, -18],
        [-4, -20],
        [0, -21],
        [5, -20],
        [9, -17],
        [10, -2],
        [17, -8],
        [20, -4],
        [12, 12],
      ]
    : [
        [-11, 12],
        [-12, -4],
        [-6, -10],
        [6, -10],
        [12, -4],
        [16, -6],
        [18, 0],
        [11, 12],
      ];
  const [sx, sy] = p(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
  g.moveTo(sx, sy);
  for (const [px, py] of pts.slice(1)) {
    const [qx, qy] = p(px, py);
    g.lineTo(qx, qy);
  }
  g.closePath()
    .fill(SKIN)
    .stroke({ width: 2.2 * s, color: SKIN_DARK, join: 'round' });
  if (open) {
    for (const fx of [-6, -1, 4]) {
      const [ax, ay] = p(fx, -4);
      const [bx, by] = p(fx, -16);
      g.moveTo(ax, ay)
        .lineTo(bx, by)
        .stroke({ width: 1.2 * s, color: SKIN_DARK, alpha: 0.6 });
    }
  }
  // Cuff.
  const [c1x, c1y] = p(-11, 12);
  const [c2x, c2y] = p(12, 12);
  g.moveTo(c1x, c1y)
    .lineTo(c2x, c2y)
    .stroke({ width: 5 * s, color: MELA.cream, cap: 'round' });
}

function thumbUp(g: Graphics, x: number, y: number, s: number): void {
  // Fist with the thumb raised (cream outline for contrast on the green enamel).
  const p = (px: number, py: number): [number, number] => [x + px * s, y + py * s];
  g.roundRect(...p(-13, -4), 26 * s, 22 * s, 7 * s)
    .fill(SKIN)
    .stroke({ width: 2.4 * s, color: MELA.cream });
  for (const fy of [2, 8, 14])
    g.moveTo(...p(-12, fy))
      .lineTo(...p(4, fy))
      .stroke({ width: 1.4 * s, color: SKIN_DARK, alpha: 0.7 });
  g.moveTo(...p(-6, -4))
    .lineTo(...p(-8, -20))
    .quadraticCurveTo(...p(-4, -27), ...p(1, -20))
    .lineTo(...p(4, -4))
    .closePath()
    .fill(SKIN)
    .stroke({ width: 2.4 * s, color: MELA.cream, join: 'round' });
  g.roundRect(...p(-16, 16), 32 * s, 8 * s, 3 * s).fill(MELA.cream);
}

function coins(g: Graphics, n: number, cx: number, cy: number, s: number): void {
  const k = Math.max(0, Math.min(9, n));
  const per = Math.min(5, k);
  for (let i = 0; i < k; i++) {
    const row = Math.floor(i / per);
    const col = i % per;
    const inRow = Math.min(per, k - row * per);
    drawGood(g, 'coin', cx + (col - (inRow - 1) / 2) * 11 * s, cy - row * 7 * s, 1.15 * s);
  }
}

function sack(g: Graphics, cx: number, cy: number, s: number, tone = 0xc8a76a): void {
  g.moveTo(cx - 13 * s, cy)
    .bezierCurveTo(cx - 17 * s, cy - 11 * s, cx - 12 * s, cy - 22 * s, cx - 5 * s, cy - 25 * s)
    .lineTo(cx + 5 * s, cy - 25 * s)
    .bezierCurveTo(cx + 12 * s, cy - 22 * s, cx + 17 * s, cy - 11 * s, cx + 13 * s, cy)
    .closePath()
    .fill(tone)
    .stroke({ width: 1.6 * s, color: darken(tone, 0.4) });
  g.moveTo(cx - 5 * s, cy - 21 * s)
    .lineTo(cx + 5 * s, cy - 21 * s)
    .stroke({ width: 2 * s, color: MELA.wood });
}

function face(g: Graphics, cx: number, cy: number, s: number, cap: boolean): void {
  // Shoulders (indigo kurta) + head; the assistant's cap.
  g.moveTo(cx - 20 * s, cy + 22 * s)
    .quadraticCurveTo(cx - 18 * s, cy + 6 * s, cx, cy + 5 * s)
    .quadraticCurveTo(cx + 18 * s, cy + 6 * s, cx + 20 * s, cy + 22 * s)
    .closePath()
    .fill(MELA.indigo);
  g.circle(cx, cy - 5 * s, 11 * s)
    .fill(0xc99468)
    .stroke({ width: 1.6 * s, color: SKIN_DARK });
  g.circle(cx - 4 * s, cy - 6 * s, 1.5 * s).fill(INK);
  g.circle(cx + 4 * s, cy - 6 * s, 1.5 * s).fill(INK);
  g.moveTo(cx - 4 * s, cy)
    .quadraticCurveTo(cx, cy + 3 * s, cx + 4 * s, cy)
    .stroke({ width: 1.4 * s, color: INK });
  if (cap) {
    g.moveTo(cx - 12 * s, cy - 10 * s)
      .quadraticCurveTo(cx, cy - 22 * s, cx + 12 * s, cy - 10 * s)
      .closePath()
      .fill(MELA.cream)
      .stroke({ width: 1.4 * s, color: darken(MELA.cream, 0.35) });
  }
}

function selfChest(g: Graphics, cx: number, cy: number, s: number): void {
  // "Me": a cream kurta with a saffron collar, a hand pressed on the heart and a small heart glow.
  g.moveTo(cx - 26 * s, cy + 26 * s)
    .quadraticCurveTo(cx - 26 * s, cy - 14 * s, cx, cy - 18 * s)
    .quadraticCurveTo(cx + 26 * s, cy - 14 * s, cx + 26 * s, cy + 26 * s)
    .closePath()
    .fill(MELA.cream)
    .stroke({ width: 2 * s, color: darken(MELA.cream, 0.45) });
  g.moveTo(cx - 9 * s, cy - 17 * s)
    .lineTo(cx, cy - 4 * s)
    .lineTo(cx + 9 * s, cy - 17 * s)
    .stroke({ width: 3 * s, color: MELA.saffron });
  g.circle(cx - 8 * s, cy + 4 * s, 7 * s).fill({ color: MELA.rose, alpha: 0.55 });
  hand(g, cx - 6 * s, cy + 10 * s, s * 0.75, -0.35, true);
}

function wind(g: Graphics, cx: number, cy: number, s: number): void {
  for (const [r, a0, w] of [
    [16, 0.2, 3],
    [10, 1.4, 2.6],
    [20, 3.4, 2.4],
  ] as const) {
    g.moveTo(cx + Math.cos(a0) * r * s, cy + Math.sin(a0) * r * s)
      .arc(cx, cy, r * s, a0, a0 + 4.2)
      .stroke({ width: w * s, color: MELA.peacockDeep, cap: 'round' });
  }
  g.ellipse(cx + 16 * s, cy - 12 * s, 6 * s, 3 * s).fill(MELA.neem);
  g.ellipse(cx - 18 * s, cy + 10 * s, 5 * s, 2.5 * s).fill(MELA.mango);
}

function garland(g: Graphics, cx: number, cy: number, s: number, half: boolean): void {
  const n = half ? 6 : 11;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = Math.PI * (half ? t * 0.5 : t);
    marigold(
      g,
      cx + Math.cos(a) * 13 * s,
      cy + Math.sin(a) * 15 * s,
      4 * s,
      i % 2 ? MELA.marigold : MELA.marigoldDeep,
    );
  }
}

function dieFace(g: Graphics, face: number, s: number): void {
  const e = 34 * s;
  g.roundRect(-e / 2, -e / 2, e, e, 8 * s).fill(
    rgrad(
      [
        [0, 0xf3dcae],
        [1, 0xc9995a],
      ],
      { x: 0.35, y: 0.3 },
      0.9,
    ),
  );
  g.roundRect(-e / 2, -e / 2, e, e, 8 * s).stroke({ width: 2 * s, color: MELA.wood });
  const o = e * 0.28;
  const spots: Record<number, [number, number][]> = {
    1: [[0, 0]],
    2: [
      [-o, -o],
      [o, o],
    ],
    3: [
      [-o, -o],
      [0, 0],
      [o, o],
    ],
    4: [
      [-o, -o],
      [o, -o],
      [-o, o],
      [o, o],
    ],
    5: [
      [-o, -o],
      [o, -o],
      [0, 0],
      [-o, o],
      [o, o],
    ],
    6: [
      [-o, -o],
      [o, -o],
      [-o, 0],
      [o, 0],
      [-o, o],
      [o, o],
    ],
  };
  for (const [x, y] of spots[face] ?? [])
    g.circle(x, y, 3.6 * s).fill(face === 1 ? MELA.vermilion : MELA.woodDark);
}

function magnifier(g: Graphics, cx: number, cy: number, s: number): void {
  g.circle(cx, cy, 11 * s)
    .fill({ color: 0xdff3f2, alpha: 0.75 })
    .stroke({ width: 3.2 * s, color: MELA.brass });
  g.moveTo(cx + 8 * s, cy + 8 * s)
    .lineTo(cx + 18 * s, cy + 18 * s)
    .stroke({ width: 5 * s, color: MELA.wood, cap: 'round' });
  g.ellipse(cx - 4 * s, cy - 4 * s, 4 * s, 2 * s).fill({ color: 0xffffff, alpha: 0.7 });
}

function shimmer(g: Graphics, cx: number, cy: number, s: number): void {
  for (const [dx, dy, r] of [
    [-14, -18, 4],
    [12, -22, 3],
    [18, -6, 2.5],
  ] as const) {
    const x = cx + dx * s;
    const y = cy + dy * s;
    g.moveTo(x, y - r * 2 * s)
      .lineTo(x + r * 0.5 * s, y)
      .lineTo(x, y + r * 2 * s)
      .lineTo(x - r * 0.5 * s, y)
      .closePath()
      .fill(0xfff2b0);
    g.moveTo(x - r * 2 * s, y)
      .lineTo(x, y + r * 0.5 * s)
      .lineTo(x + r * 2 * s, y)
      .lineTo(x, y - r * 0.5 * s)
      .closePath()
      .fill(0xfff2b0);
  }
}

function basket(
  g: Graphics,
  cx: number,
  cy: number,
  s: number,
  items: number,
  covered: boolean,
): void {
  const w = 30 * s;
  if (!covered) {
    for (let i = 0; i < items; i++) {
      const row = i < 3 ? 0 : 1;
      const col = row === 0 ? i : i - 3;
      const inRow = row === 0 ? Math.min(3, items) : items - 3;
      drawGood(
        g,
        'mango',
        cx + (col - (inRow - 1) / 2) * 13 * s,
        cy - 12 * s - row * 10 * s,
        0.8 * s,
      );
    }
  }
  g.moveTo(cx - w, cy - 14 * s)
    .quadraticCurveTo(cx - w * 0.9, cy + 4 * s, cx - w * 0.6, cy + 10 * s)
    .lineTo(cx + w * 0.6, cy + 10 * s)
    .quadraticCurveTo(cx + w * 0.9, cy + 4 * s, cx + w, cy - 14 * s)
    .closePath()
    .fill(0xc9954f)
    .stroke({ width: 1.8 * s, color: darken(0xc9954f, 0.4) });
  for (let r = 1; r < 3; r++)
    g.moveTo(cx - w * (1 - r * 0.12), cy - 14 * s + r * 8 * s)
      .lineTo(cx + w * (1 - r * 0.12), cy - 14 * s + r * 8 * s)
      .stroke({ width: 1.2 * s, color: darken(0xc9954f, 0.35), alpha: 0.7 });
  if (covered) {
    g.moveTo(cx - w * 1.05, cy - 12 * s)
      .quadraticCurveTo(cx - w * 0.6, cy - 34 * s, cx, cy - 32 * s)
      .quadraticCurveTo(cx + w * 0.6, cy - 34 * s, cx + w * 1.05, cy - 12 * s)
      .closePath()
      .fill(MELA.indigo);
    for (const dx of [-14, 0, 14]) g.circle(cx + dx * s, cy - 22 * s, 2.4 * s).fill(MELA.marigold);
    shimmer(g, cx, cy - 18 * s, s * 0.8);
  }
}

/** Draw the pictogram for an option. */
export function drawPictogram(
  kind: ChoiceKind,
  code: string,
  size: number,
  data: PictogramData = {},
): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size / 84;
  switch (`${kind}:${code}`) {
    case 'weigh:approve': {
      // A marigold ring around a raised thumb: "all is well".
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        marigold(
          g,
          Math.cos(a) * 27 * s,
          Math.sin(a) * 27 * s,
          5.6 * s,
          i % 2 ? MELA.marigold : MELA.marigoldDeep,
        );
      }
      thumbUp(g, 0, 2 * s, s * 1.05);
      break;
    }
    case 'weigh:warn':
      // A raised open palm: "wait, mind the weight".
      hand(g, 0, 4 * s, s * 1.3, 0, true);
      break;
    case 'weigh:fine': {
      // A drawstring pouch with coins spilling: "pay a fine".
      const pouch = 0xe9c98a;
      g.moveTo(-22 * s, 20 * s)
        .bezierCurveTo(-32 * s, -2 * s, -16 * s, -16 * s, -8 * s, -18 * s)
        .lineTo(8 * s, -18 * s)
        .bezierCurveTo(16 * s, -16 * s, 32 * s, -2 * s, 22 * s, 20 * s)
        .quadraticCurveTo(0, 28 * s, -22 * s, 20 * s)
        .closePath()
        .fill(pouch)
        .stroke({ width: 2.4 * s, color: darken(pouch, 0.55) });
      g.moveTo(-10 * s, -18 * s)
        .lineTo(-14 * s, -27 * s)
        .lineTo(-4 * s, -23 * s)
        .lineTo(0, -29 * s)
        .lineTo(4 * s, -23 * s)
        .lineTo(14 * s, -27 * s)
        .lineTo(10 * s, -18 * s)
        .closePath()
        .fill(pouch)
        .stroke({ width: 2 * s, color: darken(pouch, 0.55) });
      g.moveTo(-11 * s, -17 * s)
        .quadraticCurveTo(0, -12 * s, 11 * s, -17 * s)
        .stroke({ width: 3.4 * s, color: MELA.vermilion });
      g.circle(0, 4 * s, 7 * s)
        .fill(MELA.brass)
        .stroke({ width: 1.6 * s, color: darken(MELA.brass, 0.4) });
      drawGood(g, 'coin', 24 * s, 26 * s, 2 * s);
      drawGood(g, 'coin', 33 * s, 20 * s, 1.8 * s);
      drawGood(g, 'coin', 28 * s, 13 * s, 1.6 * s);
      break;
    }
    case 'bribe:accept':
      coins(g, data.coins ?? 2, 0, -12 * s, s);
      hand(g, 0, 16 * s, s * 1.05, Math.PI, true);
      break;
    case 'bribe:decline':
      coins(g, data.coins ?? 2, -14 * s, 10 * s, s);
      hand(g, 16 * s, 0, s * 1.05, -Math.PI / 2, true);
      for (const dy of [-8, 0, 8])
        g.moveTo(-30 * s, (10 + dy * 0.6) * s)
          .lineTo(-38 * s, (10 + dy) * s)
          .stroke({ width: 2 * s, color: INK, alpha: 0.5 });
      break;
    case 'overpayment:return':
      coins(g, data.coins ?? 1, -6 * s, 0, s);
      g.moveTo(16 * s, 14 * s)
        .quadraticCurveTo(-4 * s, 30 * s, -26 * s, 18 * s)
        .stroke({ width: 3.4 * s, color: MELA.peacockDeep, cap: 'round' });
      g.moveTo(-26 * s, 18 * s)
        .lineTo(-18 * s, 12 * s)
        .moveTo(-26 * s, 18 * s)
        .lineTo(-18 * s, 24 * s)
        .stroke({
          width: 3.4 * s,
          color: MELA.peacockDeep,
          cap: 'round',
        });
      hand(g, 22 * s, -4 * s, s * 0.85, -Math.PI / 2, true);
      break;
    case 'overpayment:keep': {
      // Coins dropping into the wooden cash box.
      g.roundRect(-24 * s, 2 * s, 48 * s, 22 * s, 4 * s)
        .fill(MELA.wood)
        .stroke({ width: 2 * s, color: MELA.woodDark });
      g.rect(-24 * s, 2 * s, 48 * s, 5 * s).fill(MELA.brass);
      g.rect(-8 * s, 0, 16 * s, 3 * s).fill(MELA.woodDark);
      coins(g, data.coins ?? 1, 0, -10 * s, s);
      g.moveTo(0, -18 * s)
        .lineTo(0, -6 * s)
        .stroke({ width: 2 * s, color: INK, alpha: 0.4 });
      break;
    }
    case 'assistant_mistake:self':
    case 'fraud_found:self':
      selfChest(g, 0, 2 * s, s);
      if (kind === 'fraud_found') garland(g, 0, -14 * s, s * 1.1, false);
      break;
    case 'assistant_mistake:assistant':
    case 'fraud_found:assistant':
      face(g, 0, 4 * s, s * 1.2, true);
      if (kind === 'fraud_found') garland(g, 0, 6 * s, s * 1.3, false);
      break;
    case 'assistant_mistake:shared':
    case 'fraud_found:shared': {
      // Two people side by side ("us").
      g.moveTo(-34 * s, 26 * s)
        .quadraticCurveTo(-32 * s, 4 * s, -15 * s, 3 * s)
        .quadraticCurveTo(0, 4 * s, 0, 26 * s)
        .closePath()
        .fill(MELA.saffron);
      g.circle(-16 * s, -10 * s, 10 * s)
        .fill(0xb57a50)
        .stroke({ width: 1.4 * s, color: SKIN_DARK });
      face(g, 16 * s, 4 * s, s * 0.95, true);
      if (kind === 'fraud_found') {
        garland(g, -16 * s, -2 * s, s * 0.85, true);
        garland(g, 16 * s, -2 * s, s * 0.85, true);
      } else {
        hand(g, 0, 14 * s, s * 0.7, 0, false);
      }
      break;
    }
    case 'assistant_mistake:chance':
      wind(g, 0, 0, s * 1.2);
      break;
    case 'gamble:inspect':
      for (const dx of [-20, 0, 20]) sack(g, dx * s, 4 * s, s * 0.75);
      magnifier(g, 6 * s, -16 * s, s * 0.8);
      coins(g, data.safeCoins ?? 2, 0, 26 * s, s);
      break;
    case 'gamble:gamble':
      sack(g, -12 * s, 6 * s, s * 1.05);
      shimmer(g, -12 * s, -8 * s, s * 0.7);
      coins(g, data.winCoins ?? 4, 14 * s, 24 * s, s);
      break;
    case 'probe:safe':
      basket(g, 0, 10 * s, s, data.safeItems ?? 2, false);
      break;
    case 'probe:risky':
      basket(g, 0, 10 * s, s, data.riskyItems ?? 4, true);
      break;
    default: {
      const m = /^luck:face_(\d)$/.exec(`${kind}:${code}`);
      if (m) {
        dieFace(g, Number(m[1]), s * 1.55);
        break;
      }
      // Controls drawn by the token itself; unknown codes get a neutral dot.
      g.circle(0, 0, 10 * s).fill(lighten(INK, 0.3));
    }
  }
  c.addChild(g);
  return c;
}

/** Pictogram for the inspect / re-weigh control: a magnifier over a little balance. */
export function drawInspectIcon(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size / 84;
  g.moveTo(-24 * s, -4 * s)
    .lineTo(24 * s, -4 * s)
    .stroke({ width: 3 * s, color: MELA.ink, cap: 'round' });
  g.moveTo(0, -4 * s)
    .lineTo(0, 20 * s)
    .stroke({ width: 3 * s, color: MELA.ink });
  for (const sx of [-1, 1]) {
    g.moveTo(sx * 24 * s, -4 * s)
      .lineTo(sx * 30 * s, 8 * s)
      .lineTo(sx * 18 * s, 8 * s)
      .closePath()
      .stroke({ width: 2 * s, color: MELA.ink });
    g.moveTo(sx * 31 * s, 8 * s)
      .quadraticCurveTo(sx * 24 * s, 16 * s, sx * 17 * s, 8 * s)
      .fill(MELA.ink);
  }
  drawBrassWeight(g, 24 * s, 8 * s, 0.5 * s);
  magnifier(g, -6 * s, -18 * s, s);
  c.addChild(g);
  return c;
}
