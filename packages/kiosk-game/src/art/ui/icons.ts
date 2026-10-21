/**
 * Pictographic icon set. No letters, no numerals (ENG-11): meaning comes from pictures, shape and the
 * spoken audio key of each control. Each icon draws centred at (0, 0) inside a box of edge `s`.
 */
import { Graphics } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import { openArc } from '../draw.ts';
import { MELA } from '../palettes.ts';

export type IconDrawer = (g: Graphics, s: number, color: number) => void;

const stroke = (g: Graphics, s: number, color: number, k = 0.09): Graphics =>
  g.stroke({ width: Math.max(2, s * k), color, cap: 'round', join: 'round' });

function face(g: Graphics, s: number, color: number, mood: 'happy' | 'neutral' | 'sad'): void {
  const r = s * 0.44;
  g.circle(0, 0, r).fill(MELA.marigold);
  g.circle(0, 0, r).stroke({ width: s * 0.06, color: darken(MELA.marigold, 0.45) });
  for (const sx of [-1, 1]) {
    if (mood === 'happy')
      g.moveTo(sx * r * 0.5 - r * 0.15, -r * 0.18)
        .quadraticCurveTo(sx * r * 0.5, -r * 0.42, sx * r * 0.5 + r * 0.15, -r * 0.18)
        .stroke({ width: s * 0.06, color: MELA.ink, cap: 'round' });
    else g.ellipse(sx * r * 0.4, -r * 0.2, r * 0.1, r * 0.14).fill(MELA.ink);
  }
  if (mood === 'happy') {
    g.moveTo(-r * 0.55, r * 0.15)
      .quadraticCurveTo(0, r * 0.85, r * 0.55, r * 0.15)
      .closePath()
      .fill(0x7a2a24);
    g.ellipse(0, r * 0.45, r * 0.22, r * 0.1).fill(0xe0786a);
  } else if (mood === 'neutral') {
    g.moveTo(-r * 0.42, r * 0.35)
      .lineTo(r * 0.42, r * 0.35)
      .stroke({ width: s * 0.065, color: MELA.ink, cap: 'round' });
  } else {
    g.moveTo(-r * 0.45, r * 0.5)
      .quadraticCurveTo(0, r * 0.05, r * 0.45, r * 0.5)
      .stroke({ width: s * 0.065, color: MELA.ink, cap: 'round' });
    g.moveTo(r * 0.5, -r * 0.05)
      .quadraticCurveTo(r * 0.62, r * 0.18, r * 0.5, r * 0.25)
      .quadraticCurveTo(r * 0.38, r * 0.18, r * 0.5, -r * 0.05)
      .fill(0xbfe6ff);
  }
  void color;
}

function person(
  g: Graphics,
  x: number,
  y: number,
  h: number,
  color: number,
  opts: { stoop?: number; stick?: boolean; grey?: boolean; skirt?: boolean } = {},
): void {
  const head = h * 0.13;
  const stoop = opts.stoop ?? 0;
  const hx = x + stoop * h * 0.12;
  g.circle(hx, y - h + head, head).fill(color);
  if (opts.grey)
    g.moveTo(hx - head, y - h + head * 0.7)
      .quadraticCurveTo(hx, y - h - head * 0.25, hx + head, y - h + head * 0.7)
      .stroke({ width: head * 0.55, color: 0xe8e4e0, cap: 'round' });
  const neckY = y - h + head * 2.15;
  const hipY = y - h * 0.45;
  const bw = h * 0.13;
  if (opts.skirt) {
    g.moveTo(hx - bw, neckY)
      .lineTo(hx + bw, neckY)
      .lineTo(x + bw * 1.6, y - h * 0.08)
      .lineTo(x - bw * 1.6, y - h * 0.08)
      .closePath()
      .fill(color);
  } else {
    g.roundRect(hx - bw, neckY, bw * 2, hipY - neckY, bw * 0.6).fill(color);
    g.moveTo(x - bw * 0.55, hipY)
      .lineTo(x - bw * 0.7, y)
      .stroke({ width: bw * 0.9, color, cap: 'round' });
    g.moveTo(x + bw * 0.55, hipY)
      .lineTo(x + bw * 0.7, y)
      .stroke({ width: bw * 0.9, color, cap: 'round' });
  }
  g.moveTo(hx - bw * 0.9, neckY + h * 0.04)
    .lineTo(hx - bw * 1.5, hipY)
    .stroke({ width: bw * 0.7, color, cap: 'round' });
  g.moveTo(hx + bw * 0.9, neckY + h * 0.04)
    .lineTo(opts.stick ? hx + bw * 2.4 : hx + bw * 1.5, opts.stick ? hipY - h * 0.05 : hipY)
    .stroke({ width: bw * 0.7, color, cap: 'round' });
  if (opts.stick)
    g.moveTo(hx + bw * 2.5, hipY - h * 0.06)
      .lineTo(hx + bw * 2.7, y)
      .stroke({ width: bw * 0.45, color: darken(color, 0.25), cap: 'round' });
}

/** Icon registry. */
export const ICONS: Readonly<Record<string, IconDrawer>> = {
  tick: (g, s, c) => {
    g.moveTo(-s * 0.3, s * 0.02)
      .lineTo(-s * 0.08, s * 0.24)
      .lineTo(s * 0.32, -s * 0.22);
    stroke(g, s, c, 0.14);
  },
  cross: (g, s, c) => {
    g.moveTo(-s * 0.25, -s * 0.25)
      .lineTo(s * 0.25, s * 0.25)
      .moveTo(s * 0.25, -s * 0.25)
      .lineTo(-s * 0.25, s * 0.25);
    stroke(g, s, c, 0.14);
  },
  replay: (g, s, c) => {
    openArc(g, 0, 0, s * 0.28, -Math.PI * 0.35, Math.PI * 1.45);
    stroke(g, s, c, 0.1);
    const a = -Math.PI * 0.35;
    const tx = Math.cos(a) * s * 0.28;
    const ty = Math.sin(a) * s * 0.28;
    g.poly([
      tx + s * 0.13,
      ty - s * 0.02,
      tx - s * 0.05,
      ty - s * 0.15,
      tx - s * 0.02,
      ty + s * 0.11,
    ]).fill(c);
    // Speaker in the middle: replay the voice.
    g.poly([
      -s * 0.1,
      -s * 0.05,
      -s * 0.03,
      -s * 0.05,
      s * 0.06,
      -s * 0.12,
      s * 0.06,
      s * 0.12,
      -s * 0.03,
      s * 0.05,
      -s * 0.1,
      s * 0.05,
    ]).fill(c);
  },
  speaker: (g, s, c) => {
    g.poly([
      -s * 0.3,
      -s * 0.1,
      -s * 0.14,
      -s * 0.1,
      s * 0.04,
      -s * 0.26,
      s * 0.04,
      s * 0.26,
      -s * 0.14,
      s * 0.1,
      -s * 0.3,
      s * 0.1,
    ]).fill(c);
    openArc(g, s * 0.06, 0, s * 0.16, -0.8, 0.8);
    stroke(g, s, c, 0.07);
    openArc(g, s * 0.06, 0, s * 0.3, -0.8, 0.8);
    stroke(g, s, c, 0.07);
  },
  help: (g, s, c) => {
    g.roundRect(-s * 0.32, -s * 0.26, s * 0.64, s * 0.42, s * 0.14).fill(c);
    g.poly([-s * 0.1, s * 0.14, s * 0.06, s * 0.14, -s * 0.16, s * 0.32]).fill(c);
    for (let k = -1; k <= 1; k++) g.circle(k * s * 0.15, -s * 0.05, s * 0.05).fill(darken(c, 0.6));
  },
  hand: (g, s, c) => {
    // Open palm: "stop / keep or delete" (ONB-06).
    g.roundRect(-s * 0.2, -s * 0.06, s * 0.4, s * 0.38, s * 0.14).fill(c);
    const fingers = [
      [-0.16, 0.28],
      [-0.055, 0.34],
      [0.055, 0.33],
      [0.16, 0.26],
    ];
    for (const [fx = 0, fh = 0] of fingers)
      g.roundRect(s * fx - s * 0.045, -s * fh, s * 0.09, s * fh + s * 0.06, s * 0.045).fill(c);
    g.roundRect(-s * 0.32, -s * 0.02, s * 0.2, s * 0.09, s * 0.045).fill(c);
  },
  pointer: (g, s, c) => {
    g.roundRect(-s * 0.12, -s * 0.38, s * 0.12, s * 0.42, s * 0.06).fill(c);
    g.roundRect(-s * 0.18, -s * 0.02, s * 0.42, s * 0.34, s * 0.12).fill(c);
    g.roundRect(-s * 0.3, s * 0.0, s * 0.16, s * 0.1, s * 0.05).fill(c);
  },
  globe: (g, s, c) => {
    const r = s * 0.32;
    g.circle(0, 0, r);
    stroke(g, s, c, 0.07);
    g.ellipse(0, 0, r * 0.45, r);
    stroke(g, s, c, 0.06);
    g.moveTo(-r, 0)
      .lineTo(r, 0)
      .moveTo(-r * 0.86, -r * 0.5)
      .lineTo(r * 0.86, -r * 0.5)
      .moveTo(-r * 0.86, r * 0.5)
      .lineTo(r * 0.86, r * 0.5);
    stroke(g, s, c, 0.05);
  },
  play: (g, s, c) => {
    g.poly([-s * 0.16, -s * 0.26, s * 0.28, 0, -s * 0.16, s * 0.26]).fill(c);
  },
  skip: (g, s, c) => {
    g.poly([-s * 0.28, -s * 0.22, s * 0.02, 0, -s * 0.28, s * 0.22]).fill(c);
    g.poly([-s * 0.02, -s * 0.22, s * 0.28, 0, -s * 0.02, s * 0.22]).fill(c);
  },
  mic: (g, s, c) => {
    g.roundRect(-s * 0.1, -s * 0.32, s * 0.2, s * 0.38, s * 0.1).fill(c);
    openArc(g, 0, -s * 0.06, s * 0.2, 0.1, Math.PI - 0.1);
    stroke(g, s, c, 0.06);
    g.moveTo(0, s * 0.14)
      .lineTo(0, s * 0.28)
      .moveTo(-s * 0.12, s * 0.28)
      .lineTo(s * 0.12, s * 0.28);
    stroke(g, s, c, 0.06);
  },
  mic_off: (g, s, c) => {
    ICONS.mic?.(g, s, c);
    g.moveTo(-s * 0.3, -s * 0.3).lineTo(s * 0.3, s * 0.3);
    stroke(g, s, MELA.vermilion, 0.1);
  },
  ear: (g, s, c) => {
    g.moveTo(-s * 0.14, s * 0.24)
      .bezierCurveTo(-s * 0.28, -s * 0.05, -s * 0.18, -s * 0.34, s * 0.04, -s * 0.32)
      .bezierCurveTo(s * 0.26, -s * 0.3, s * 0.3, -s * 0.02, s * 0.12, s * 0.1)
      .quadraticCurveTo(s * 0.02, s * 0.18, s * 0.02, s * 0.3);
    stroke(g, s, c, 0.08);
  },
  heart: (g, s, c) => {
    g.moveTo(0, s * 0.3)
      .bezierCurveTo(-s * 0.45, s * 0.02, -s * 0.3, -s * 0.36, 0, -s * 0.14)
      .bezierCurveTo(s * 0.3, -s * 0.36, s * 0.45, s * 0.02, 0, s * 0.3)
      .fill(c);
  },
  star: (g, s, c) => {
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? s * 0.38 : s * 0.16;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.poly(pts).fill(c);
  },
  home: (g, s, c) => {
    g.poly([-s * 0.32, -s * 0.02, 0, -s * 0.3, s * 0.32, -s * 0.02]).fill(c);
    g.rect(-s * 0.22, -s * 0.04, s * 0.44, s * 0.32).fill(c);
    g.roundRect(-s * 0.06, s * 0.08, s * 0.12, s * 0.2, s * 0.05).fill(darken(c, 0.5));
  },
  game: (g, s) => {
    // A festive pinwheel (phirki) on a stick: "we play".
    g.moveTo(0, s * 0.02)
      .lineTo(s * 0.04, s * 0.42)
      .stroke({ width: Math.max(2, s * 0.05), color: MELA.wood, cap: 'round' });
    const cols = [MELA.vermilion, MELA.marigold, MELA.peacock, MELA.rose];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 - Math.PI / 4;
      const tip = { x: Math.cos(a) * s * 0.34, y: Math.sin(a) * s * 0.34 - s * 0.06 };
      const side = { x: Math.cos(a + 0.9) * s * 0.2, y: Math.sin(a + 0.9) * s * 0.2 - s * 0.06 };
      g.poly([0, -s * 0.06, tip.x, tip.y, side.x, side.y]).fill(cols[k] ?? MELA.rose);
      g.poly([0, -s * 0.06, tip.x, tip.y, side.x, side.y]).stroke({
        width: Math.max(1, s * 0.015),
        color: darken(cols[k] ?? MELA.rose, 0.35),
      });
    }
    g.circle(0, -s * 0.06, s * 0.05).fill(MELA.brass);
  },
  balance: (g, s, c) => {
    // Weighing scale: beam, post and two pans (judgement / weighing).
    g.moveTo(0, -s * 0.3)
      .lineTo(0, s * 0.3)
      .moveTo(-s * 0.16, s * 0.3)
      .lineTo(s * 0.16, s * 0.3);
    stroke(g, s, c, 0.07);
    g.moveTo(-s * 0.34, -s * 0.2).lineTo(s * 0.34, -s * 0.2);
    stroke(g, s, c, 0.07);
    for (const sx of [-1, 1]) {
      g.moveTo(sx * s * 0.34, -s * 0.2)
        .lineTo(sx * s * 0.24, s * 0.04)
        .moveTo(sx * s * 0.34, -s * 0.2)
        .lineTo(sx * s * 0.44, s * 0.04);
      stroke(g, s, c, 0.035);
      g.moveTo(sx * s * 0.2, s * 0.04)
        .quadraticCurveTo(sx * s * 0.34, s * 0.16, sx * s * 0.48, s * 0.04)
        .closePath()
        .fill(c);
    }
    g.circle(0, -s * 0.3, s * 0.05).fill(c);
  },
  chest: (g, s, c) => {
    // What we keep: a closed box of game tokens.
    g.roundRect(-s * 0.32, -s * 0.06, s * 0.64, s * 0.32, s * 0.05).fill(c);
    g.moveTo(-s * 0.32, -s * 0.06)
      .quadraticCurveTo(0, -s * 0.34, s * 0.32, -s * 0.06)
      .closePath()
      .fill(lighten(c, 0.15));
    g.roundRect(-s * 0.06, -s * 0.06, s * 0.12, s * 0.12, s * 0.03).fill(darken(c, 0.45));
    for (let k = -2; k <= 2; k++) g.circle(k * s * 0.1, s * 0.16, s * 0.035).fill(darken(c, 0.3));
  },
  bin: (g, s, c) => {
    g.rect(-s * 0.26, -s * 0.22, s * 0.52, s * 0.06).fill(c);
    g.rect(-s * 0.08, -s * 0.3, s * 0.16, s * 0.06).fill(c);
    g.moveTo(-s * 0.2, -s * 0.12)
      .lineTo(-s * 0.16, s * 0.3)
      .lineTo(s * 0.16, s * 0.3)
      .lineTo(s * 0.2, -s * 0.12)
      .closePath()
      .fill(c);
    for (let k = -1; k <= 1; k++)
      g.moveTo(k * s * 0.08, -s * 0.06)
        .lineTo(k * s * 0.07, s * 0.22)
        .stroke({ width: s * 0.03, color: darken(c, 0.4) });
  },
  camera: (g, s, c) => {
    // Snapshot ("a snapshot, not a diagnosis").
    g.roundRect(-s * 0.32, -s * 0.16, s * 0.64, s * 0.42, s * 0.08).fill(c);
    g.roundRect(-s * 0.12, -s * 0.26, s * 0.24, s * 0.12, s * 0.03).fill(c);
    g.circle(0, s * 0.05, s * 0.14).fill(darken(c, 0.55));
    g.circle(0, s * 0.05, s * 0.08).fill(lighten(c, 0.2));
  },
  stethoscope: (g, s, c) => {
    g.moveTo(-s * 0.2, -s * 0.3)
      .quadraticCurveTo(-s * 0.24, s * 0.06, 0, s * 0.08)
      .quadraticCurveTo(s * 0.24, s * 0.06, s * 0.2, -s * 0.3);
    stroke(g, s, c, 0.07);
    g.moveTo(0, s * 0.08).quadraticCurveTo(0, s * 0.3, s * 0.2, s * 0.26);
    stroke(g, s, c, 0.07);
    g.circle(s * 0.24, s * 0.22, s * 0.08).fill(c);
  },
  no: (g, s, c) => {
    g.circle(0, 0, s * 0.4);
    stroke(g, s, c, 0.09);
    g.moveTo(-s * 0.28, -s * 0.28).lineTo(s * 0.28, s * 0.28);
    stroke(g, s, c, 0.09);
  },
  card: (g, s, c) => {
    g.roundRect(-s * 0.2, -s * 0.3, s * 0.4, s * 0.56, s * 0.06).fill(c);
    g.circle(0, -s * 0.06, s * 0.09).fill(MELA.vermilion);
    g.roundRect(-s * 0.12, s * 0.08, s * 0.24, s * 0.04, s * 0.02).fill(darken(c, 0.35));
    g.roundRect(-s * 0.12, s * 0.15, s * 0.16, s * 0.04, s * 0.02).fill(darken(c, 0.35));
  },
  people: (g, s, c) => {
    person(g, -s * 0.16, s * 0.34, s * 0.6, c);
    person(g, s * 0.16, s * 0.34, s * 0.52, lighten(c, 0.15), { skirt: true });
  },
  phone: (g, s, c) => {
    g.roundRect(-s * 0.16, -s * 0.32, s * 0.32, s * 0.64, s * 0.07).fill(c);
    g.roundRect(-s * 0.12, -s * 0.25, s * 0.24, s * 0.44, s * 0.03).fill(darken(c, 0.55));
    g.circle(0, s * 0.25, s * 0.03).fill(darken(c, 0.4));
  },
  letter: (g, s, c) => {
    g.roundRect(-s * 0.3, -s * 0.2, s * 0.6, s * 0.42, s * 0.04).fill(c);
    g.moveTo(-s * 0.3, -s * 0.2)
      .lineTo(0, s * 0.04)
      .lineTo(s * 0.3, -s * 0.2);
    stroke(g, s, darken(c, 0.4), 0.05);
  },
  newspaper: (g, s, c) => {
    g.roundRect(-s * 0.3, -s * 0.26, s * 0.6, s * 0.52, s * 0.04).fill(c);
    g.rect(-s * 0.24, -s * 0.2, s * 0.22, s * 0.16).fill(darken(c, 0.35));
    for (let k = 0; k < 4; k++)
      g.rect(s * 0.02, -s * 0.2 + k * s * 0.06, s * 0.2, s * 0.025).fill(darken(c, 0.35));
    for (let k = 0; k < 3; k++)
      g.rect(-s * 0.24, s * 0.02 + k * s * 0.07, s * 0.48, s * 0.025).fill(darken(c, 0.35));
  },
  book: (g, s, c) => {
    g.moveTo(0, -s * 0.2)
      .quadraticCurveTo(-s * 0.18, -s * 0.28, -s * 0.34, -s * 0.22)
      .lineTo(-s * 0.34, s * 0.24)
      .quadraticCurveTo(-s * 0.18, s * 0.18, 0, s * 0.26)
      .closePath()
      .fill(c);
    g.moveTo(0, -s * 0.2)
      .quadraticCurveTo(s * 0.18, -s * 0.28, s * 0.34, -s * 0.22)
      .lineTo(s * 0.34, s * 0.24)
      .quadraticCurveTo(s * 0.18, s * 0.18, 0, s * 0.26)
      .closePath()
      .fill(lighten(c, 0.15));
  },
  slate: (g, s, c) => {
    g.roundRect(-s * 0.32, -s * 0.24, s * 0.64, s * 0.46, s * 0.04).fill(MELA.wood);
    g.rect(-s * 0.27, -s * 0.19, s * 0.54, s * 0.36).fill(0x2f3f3a);
    g.moveTo(-s * 0.18, s * 0.02)
      .quadraticCurveTo(-s * 0.05, -s * 0.12, s * 0.06, s * 0.04)
      .stroke({ width: s * 0.03, color: c });
    g.circle(s * 0.14, -s * 0.06, s * 0.03).fill(c);
  },
  gradcap: (g, s, c) => {
    g.poly([-s * 0.38, -s * 0.06, 0, -s * 0.22, s * 0.38, -s * 0.06, 0, s * 0.1]).fill(c);
    g.moveTo(-s * 0.22, 0)
      .lineTo(-s * 0.22, s * 0.18)
      .quadraticCurveTo(0, s * 0.3, s * 0.22, s * 0.18)
      .lineTo(s * 0.22, 0)
      .fill(darken(c, 0.15));
    g.moveTo(s * 0.3, -s * 0.08).lineTo(s * 0.32, s * 0.2);
    stroke(g, s, MELA.marigold, 0.04);
    g.circle(s * 0.32, s * 0.22, s * 0.04).fill(MELA.marigold);
  },
  face_happy: (g, s, c) => face(g, s, c, 'happy'),
  face_neutral: (g, s, c) => face(g, s, c, 'neutral'),
  face_sad: (g, s, c) => face(g, s, c, 'sad'),
  sun: (g, s, c) => {
    g.circle(0, 0, s * 0.17).fill(MELA.marigold);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.moveTo(Math.cos(a) * s * 0.25, Math.sin(a) * s * 0.25).lineTo(
        Math.cos(a) * s * 0.36,
        Math.sin(a) * s * 0.36,
      );
    }
    stroke(g, s, MELA.marigold, 0.07);
    void c;
  },
  moon: (g, s, c) => {
    g.circle(0, 0, s * 0.3).fill(c);
    g.circle(s * 0.13, -s * 0.08, s * 0.26).cut();
  },
  question_wave: (g, s, c) => {
    // "Not sure": a hand tilting side to side (drawn as a palm with motion arcs).
    ICONS.hand?.(g, s * 0.8, c);
    openArc(g, 0, 0, s * 0.42, -Math.PI * 0.85, -Math.PI * 0.6);
    stroke(g, s, c, 0.05);
    openArc(g, 0, 0, s * 0.42, -Math.PI * 0.4, -Math.PI * 0.15);
    stroke(g, s, c, 0.05);
  },
  hush: (g, s) => {
    // "Prefer not to say": a calm face with a finger on the lips.
    const r = s * 0.36;
    const c = 0xf2c48a;
    g.circle(0, 0, r)
      .fill(c)
      .circle(0, 0, r)
      .stroke({ width: s * 0.04, color: darken(c, 0.45) });
    for (const sx of [-1, 1])
      g.moveTo(sx * r * 0.45 - r * 0.12, -r * 0.2)
        .lineTo(sx * r * 0.45 + r * 0.12, -r * 0.2)
        .stroke({ width: s * 0.05, color: MELA.ink, cap: 'round' });
    g.moveTo(-r * 0.32, r * 0.35)
      .lineTo(r * 0.32, r * 0.35)
      .stroke({ width: s * 0.05, color: MELA.ink, cap: 'round' });
    g.roundRect(-s * 0.04, r * 0.02, s * 0.08, s * 0.4, s * 0.04).fill(darken(c, 0.25));
    g.roundRect(-s * 0.04, r * 0.02, s * 0.08, s * 0.4, s * 0.04).stroke({
      width: s * 0.02,
      color: darken(c, 0.5),
    });
  },
  repeat: (g, s, c) => {
    openArc(g, 0, 0, s * 0.28, Math.PI * 0.15, Math.PI * 0.85);
    stroke(g, s, c, 0.08);
    openArc(g, 0, 0, s * 0.28, Math.PI * 1.15, Math.PI * 1.85);
    stroke(g, s, c, 0.08);
    g.poly([
      s * 0.28 * Math.cos(Math.PI * 1.85) + s * 0.1,
      s * 0.28 * Math.sin(Math.PI * 1.85),
      s * 0.18,
      -s * 0.24,
      s * 0.3,
      -s * 0.02,
    ]).fill(c);
    g.poly([
      -s * 0.28 * Math.cos(Math.PI * 1.85) - s * 0.1,
      -s * 0.28 * Math.sin(Math.PI * 1.85),
      -s * 0.18,
      s * 0.24,
      -s * 0.3,
      s * 0.02,
    ]).fill(c);
  },
  mango: (g, s, c) => {
    g.moveTo(0, -s * 0.24)
      .bezierCurveTo(s * 0.34, -s * 0.24, s * 0.34, s * 0.3, 0, s * 0.3)
      .bezierCurveTo(-s * 0.3, s * 0.3, -s * 0.28, -s * 0.1, 0, -s * 0.24)
      .fill(0xf2b02a);
    g.ellipse(-s * 0.06, -s * 0.06, s * 0.08, s * 0.12).fill({ color: 0xffffff, alpha: 0.35 });
    g.moveTo(0, -s * 0.24)
      .quadraticCurveTo(s * 0.12, -s * 0.38, s * 0.26, -s * 0.32)
      .quadraticCurveTo(s * 0.12, -s * 0.26, 0, -s * 0.24)
      .fill(0x4f8a3a);
    void c;
  },
  banana: (g, s) => {
    g.moveTo(-s * 0.3, -s * 0.1)
      .quadraticCurveTo(0, s * 0.42, s * 0.32, -s * 0.12)
      .quadraticCurveTo(0, s * 0.22, -s * 0.3, -s * 0.1)
      .fill(0xf6d23a);
    g.moveTo(-s * 0.3, -s * 0.1)
      .lineTo(-s * 0.34, -s * 0.18)
      .stroke({ width: s * 0.04, color: 0x6a5a2a });
  },
  flower: (g, s) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.circle(Math.cos(a) * s * 0.18, Math.sin(a) * s * 0.18, s * 0.13).fill(MELA.marigold);
    }
    g.circle(0, 0, s * 0.14).fill(MELA.saffron);
  },
  diya: (g, s) => {
    g.moveTo(-s * 0.32, -s * 0.02)
      .quadraticCurveTo(0, s * 0.3, s * 0.3, -s * 0.04)
      .lineTo(s * 0.38, -s * 0.1)
      .closePath()
      .fill(MELA.terracotta);
    g.moveTo(s * 0.26, -s * 0.06)
      .bezierCurveTo(s * 0.18, -s * 0.16, s * 0.24, -s * 0.28, s * 0.28, -s * 0.36)
      .bezierCurveTo(s * 0.34, -s * 0.24, s * 0.36, -s * 0.14, s * 0.26, -s * 0.06)
      .fill(0xffb030);
  },
  coin: (g, s) => {
    g.circle(0, 0, s * 0.3).fill(0xe0a82e);
    g.circle(0, 0, s * 0.23).fill(0xf5d47a);
    g.circle(0, 0, s * 0.08).fill(0xc98f1e);
  },
  namaste: (g, s) => {
    // Folded hands (namaste), seen from the front: two palms pressed together, fingers pointing up,
    // thumbs resting in front, wrists with bangles in saffron sleeves.
    const skin = 0xe2a874;
    const shade = 0xc98a58;
    const edge = 0x6e3f22;
    const fw = s * 0.055;
    for (const sx of [-1, 1]) {
      // Palm (slightly tilted outward at the base).
      g.moveTo(sx * s * 0.02, -s * 0.06)
        .lineTo(sx * s * 0.2, -s * 0.02)
        .quadraticCurveTo(sx * s * 0.24, s * 0.14, sx * s * 0.15, s * 0.26)
        .lineTo(sx * s * 0.02, s * 0.24)
        .closePath()
        .fill(sx < 0 ? skin : shade)
        .stroke({ width: s * 0.022, color: edge, join: 'round' });
      // Four fingers rising to a point.
      for (let k = 0; k < 4; k++) {
        const x0 = sx * (s * 0.025 + k * fw * 0.95);
        const top = -s * (0.42 - k * 0.055 - (k === 3 ? 0.02 : 0));
        g.roundRect(Math.min(x0, x0 + sx * fw), top, fw, -top - s * 0.04, fw * 0.5)
          .fill(sx < 0 ? skin : shade)
          .stroke({ width: s * 0.018, color: edge });
      }
      // Thumb in front.
      g.roundRect(sx > 0 ? s * 0.005 : -s * 0.075, -s * 0.04, s * 0.07, s * 0.2, s * 0.035)
        .fill(skin)
        .stroke({ width: s * 0.018, color: edge });
      // Bangles and sleeve.
      g.roundRect(sx > 0 ? s * 0.02 : -s * 0.17, s * 0.24, s * 0.15, s * 0.035, s * 0.015).fill(
        MELA.brass,
      );
      g.roundRect(sx > 0 ? s * 0.01 : -s * 0.2, s * 0.275, s * 0.19, s * 0.14, s * 0.04)
        .fill(MELA.saffron)
        .stroke({ width: s * 0.02, color: edge });
    }
  },
  lotus: (g, s) => {
    for (let i = -2; i <= 2; i++) {
      g.moveTo(0, s * 0.2)
        .quadraticCurveTo(
          i * s * 0.14 - s * 0.1,
          -s * 0.05,
          i * s * 0.1,
          -s * 0.28 + Math.abs(i) * s * 0.08,
        )
        .quadraticCurveTo(i * s * 0.14 + s * 0.1, -s * 0.05, 0, s * 0.2)
        .fill(i === 0 ? MELA.lotus : lighten(MELA.rose, 0.2));
    }
    g.ellipse(0, s * 0.24, s * 0.32, s * 0.06).fill(MELA.mango);
  },
  lock: (g, s, c) => {
    g.roundRect(-s * 0.22, -s * 0.04, s * 0.44, s * 0.32, s * 0.06).fill(c);
    openArc(g, 0, -s * 0.04, s * 0.15, Math.PI, 0);
    stroke(g, s, c, 0.08);
  },
  qr: (g, s, c) => {
    const cell = s * 0.08;
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
    ] as const) {
      g.rect(x * s * 0.2 - cell * 1.5, y * s * 0.2 - cell * 1.5, cell * 3, cell * 3).stroke({
        width: cell * 0.7,
        color: c,
      });
      g.rect(x * s * 0.2 - cell * 0.5, y * s * 0.2 - cell * 0.5, cell, cell).fill(c);
    }
    g.rect(s * 0.12, s * 0.12, cell, cell)
      .fill(c)
      .rect(s * 0.24, s * 0.2, cell, cell)
      .fill(c)
      .rect(s * 0.16, s * 0.26, cell, cell)
      .fill(c);
  },
  printer: (g, s, c) => {
    g.roundRect(-s * 0.32, -s * 0.08, s * 0.64, s * 0.28, s * 0.06).fill(c);
    g.rect(-s * 0.18, -s * 0.3, s * 0.36, s * 0.2).fill(lighten(c, 0.2));
    g.rect(-s * 0.18, s * 0.12, s * 0.36, s * 0.22).fill(0xffffff);
    g.rect(-s * 0.12, s * 0.18, s * 0.24, s * 0.03).fill(darken(c, 0.3));
  },
  eye_closed: (g, s, c) => {
    g.moveTo(-s * 0.32, 0).quadraticCurveTo(0, s * 0.24, s * 0.32, 0);
    stroke(g, s, c, 0.08);
    for (let k = -2; k <= 2; k++) g.moveTo(k * s * 0.12, s * 0.1).lineTo(k * s * 0.14, s * 0.22);
    stroke(g, s, c, 0.06);
  },
};

/** Draw a registered icon into a new Graphics (unknown ids draw a neutral dot so nothing crashes). */
export function drawIcon(iconId: string, size: number, color: number): Graphics {
  const g = new Graphics();
  const d = ICONS[iconId];
  if (d) d(g, size, color);
  else g.circle(0, 0, size * 0.18).fill(color);
  return g;
}

/** All registered icon ids (gallery). */
export function iconIds(): string[] {
  return Object.keys(ICONS);
}

export { person as drawPersonGlyph };
