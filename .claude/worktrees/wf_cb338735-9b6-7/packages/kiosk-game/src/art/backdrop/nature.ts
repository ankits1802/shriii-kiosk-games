/**
 * Nature props: banyan and neem trees (trunk and canopy split so the canopy can sway), painterly clouds
 * (body + lit highlight, tinted per time of day), birds (two wing frames), grass and flowers.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from '../color.ts';
import { marigold, rgrad, smoothPath, softShadow, vgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';

export interface TreeArt {
  readonly trunk: Container;
  readonly canopy: Container;
  /** Canopy pivot (trunk top) relative to the tree origin; sway rotates around it. */
  readonly pivot: { readonly x: number; readonly y: number };
}

/** Three-tone painterly canopy made of clumps inside an ellipse. */
function canopy(
  g: Graphics,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  clumps: number,
  clumpR: number,
  base: number,
  rnd: ArtRandom,
): void {
  const dark = darken(base, 0.38);
  const light = mixColor(base, 0xd6dc6a, 0.3);
  const pts: { x: number; y: number; r: number; tone: number }[] = [];
  for (let i = 0; i < clumps; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = Math.sqrt(rnd.next());
    pts.push({
      x: cx + Math.cos(a) * rx * d * 0.85,
      y: cy + Math.sin(a) * ry * d * 0.8,
      r: clumpR * rnd.range(0.75, 1.1),
      tone: rnd.range(-0.08, 0.08),
    });
  }
  pts.sort((p1, p2) => p1.y - p2.y);
  // Shadow pass (offset down-right), mid pass with slight tone variation, soft highlight pass.
  for (const p of pts) g.circle(p.x + p.r * 0.1, p.y + p.r * 0.2, p.r).fill(dark);
  for (const p of pts)
    g.circle(p.x, p.y, p.r * 0.9).fill(p.tone > 0 ? lighten(base, p.tone) : darken(base, -p.tone));
  for (const p of pts) {
    if (p.y < cy + ry * 0.1)
      g.ellipse(p.x - p.r * 0.18, p.y - p.r * 0.3, p.r * 0.55, p.r * 0.42).fill({
        color: light,
        alpha: 0.55,
      });
  }
  // Leaf flecks for texture.
  for (let i = 0; i < clumps * 5; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = Math.sqrt(rnd.next());
    const x = cx + Math.cos(a) * rx * d * 0.95;
    const y = cy + Math.sin(a) * ry * d * 0.9;
    g.ellipse(x, y, clumpR * 0.08, clumpR * 0.045).fill({
      color: y < cy ? light : dark,
      alpha: 0.45,
    });
  }
}

/** A great banyan with aerial roots. `s` = canopy half-width in px. */
export function drawBanyan(s: number, seed: number): TreeArt {
  const rnd = new ArtRandom(seed);
  const trunk = new Container();
  const tg = new Graphics();
  softShadow(tg, 0, 0, s * 1.1, s * 0.09, MELA.ink, 0.35);
  // Aerial roots curtain.
  for (let i = 0; i < 26; i++) {
    const x = rnd.range(-s * 0.95, s * 0.95);
    const top = -s * rnd.range(0.85, 1.05);
    const bottom = Math.abs(x) < s * 0.5 && rnd.chance(0.5) ? 0 : top + s * rnd.range(0.25, 0.6);
    tg.moveTo(x, top)
      .quadraticCurveTo(x + rnd.range(-6, 6), (top + bottom) / 2, x + rnd.range(-4, 4), bottom)
      .stroke({
        width: rnd.range(1.5, 4.5) * (s / 260),
        color: darken(MELA.wood, rnd.range(0, 0.3)),
        alpha: 0.9,
      });
  }
  // Main trunk with flared base and branches.
  const tw = s * 0.16;
  tg.moveTo(-tw * 1.8, 0)
    .bezierCurveTo(-tw * 0.9, -s * 0.1, -tw, -s * 0.5, -tw * 0.7, -s * 0.85)
    .lineTo(-s * 0.55, -s * 1.05)
    .lineTo(-s * 0.5, -s * 1.12)
    .lineTo(-tw * 0.2, -s * 0.95)
    .lineTo(s * 0.1, -s * 1.15)
    .lineTo(s * 0.2, -s * 1.1)
    .lineTo(tw * 0.6, -s * 0.9)
    .lineTo(s * 0.6, -s * 1.06)
    .lineTo(s * 0.62, -s * 0.99)
    .bezierCurveTo(tw * 1.2, -s * 0.75, tw, -s * 0.2, tw * 1.9, 0)
    .closePath()
    .fill(
      vgrad([
        [0, darken(MELA.wood, 0.1)],
        [1, darken(MELA.wood, 0.45)],
      ]),
    );
  for (let i = 0; i < 7; i++) {
    const x = rnd.range(-tw * 0.8, tw * 0.8);
    tg.moveTo(x, -rnd.range(0, s * 0.1))
      .quadraticCurveTo(x + rnd.range(-8, 8), -s * 0.4, x * 0.6, -s * 0.8)
      .stroke({
        width: 2 * (s / 260),
        color: darken(MELA.wood, 0.55),
        alpha: 0.5,
      });
  }
  tg.moveTo(-tw * 0.4, 0)
    .quadraticCurveTo(-tw * 0.5, -s * 0.4, -tw * 0.2, -s * 0.85)
    .stroke({ width: tw * 0.25, color: lighten(MELA.wood, 0.2), alpha: 0.25 });
  trunk.addChild(tg);

  const can = new Container();
  const cg = new Graphics();
  canopy(cg, 0, -s * 1.12, s * 1.15, s * 0.42, 46, s * 0.2, MELA.banyan, rnd);
  canopy(cg, -s * 0.55, -s * 1.0, s * 0.5, s * 0.22, 14, s * 0.15, MELA.banyan, rnd);
  canopy(cg, s * 0.6, -s * 1.02, s * 0.5, s * 0.22, 14, s * 0.15, MELA.banyan, rnd);
  can.addChild(cg);
  return { trunk, canopy: can, pivot: { x: 0, y: -s * 0.9 } };
}

/** A neem tree: slender forked trunk and feathery rounded clusters. `s` = height scale in px. */
export function drawNeem(s: number, seed: number): TreeArt {
  const rnd = new ArtRandom(seed);
  const trunk = new Container();
  const tg = new Graphics();
  softShadow(tg, 0, 0, s * 0.42, s * 0.05, MELA.ink, 0.3);
  const tw = s * 0.05;
  tg.moveTo(-tw * 1.4, 0)
    .bezierCurveTo(-tw, -s * 0.2, -tw * 1.2, -s * 0.45, -s * 0.18, -s * 0.72)
    .lineTo(-s * 0.15, -s * 0.75)
    .lineTo(-tw * 0.2, -s * 0.55)
    .lineTo(s * 0.12, -s * 0.8)
    .lineTo(s * 0.15, -s * 0.78)
    .bezierCurveTo(tw * 0.8, -s * 0.45, tw, -s * 0.2, tw * 1.4, 0)
    .closePath()
    .fill(
      vgrad([
        [0, 0x8a6a52],
        [1, 0x5a4232],
      ]),
    );
  trunk.addChild(tg);
  const can = new Container();
  const cg = new Graphics();
  const base = MELA.neem;
  const clusters = [
    { x: -s * 0.2, y: -s * 0.82, rx: s * 0.26, ry: s * 0.18 },
    { x: s * 0.16, y: -s * 0.88, rx: s * 0.26, ry: s * 0.19 },
    { x: 0, y: -s * 1.02, rx: s * 0.28, ry: s * 0.2 },
    { x: -s * 0.08, y: -s * 0.72, rx: s * 0.22, ry: s * 0.12 },
  ];
  for (const c of clusters) canopy(cg, c.x, c.y, c.rx, c.ry, 16, s * 0.085, base, rnd);
  // Feathery leaflets around the outline.
  for (let i = 0; i < 90; i++) {
    const c = rnd.pick(clusters);
    const a = rnd.range(0, Math.PI * 2);
    const x = c.x + Math.cos(a) * c.rx * 1.02;
    const y = c.y + Math.sin(a) * c.ry * 1.02;
    cg.ellipse(x, y, s * 0.018, s * 0.008).fill({
      color: y < c.y ? lighten(base, 0.25) : darken(base, 0.25),
      alpha: 0.9,
    });
  }
  can.addChild(cg);
  return { trunk, canopy: can, pivot: { x: 0, y: -s * 0.6 } };
}

/** Coconut palm (coastal variety in a few scenes). */
export function drawPalm(s: number, seed: number): TreeArt {
  const rnd = new ArtRandom(seed);
  const trunk = new Container();
  const tg = new Graphics();
  const lean = rnd.range(-0.25, 0.25) * s;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push({ x: lean * t * t, y: -s * t });
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const w = s * 0.035 * (1 - i * 0.04);
    tg.poly([a.x - w, a.y, a.x + w, a.y, b.x + w * 0.96, b.y, b.x - w * 0.96, b.y]).fill(
      i % 2 === 0 ? 0x8c6b4f : 0x7a5c43,
    );
  }
  trunk.addChild(tg);
  const can = new Container();
  const cg = new Graphics();
  const top = pts[pts.length - 1] ?? { x: 0, y: -s };
  // Drooping fronds: a curved rachis with tapering leaflets on both sides, darker underneath.
  const frondCount = 10;
  for (let k = 0; k < frondCount; k++) {
    const a = -Math.PI / 2 + ((k / (frondCount - 1)) * 2 - 1) * 1.9 + rnd.range(-0.12, 0.12);
    const len = s * rnd.range(0.34, 0.46);
    const droop = len * rnd.range(0.35, 0.6);
    const cx = top.x + Math.cos(a) * len * 0.55;
    const cy = top.y + Math.sin(a) * len * 0.55 - len * 0.18;
    const ex = top.x + Math.cos(a) * len;
    const ey = top.y + Math.sin(a) * len * 0.6 + droop;
    const dark = k % 2 === 0 ? 0x2f5a26 : 0x3d6b2e;
    const light = k % 2 === 0 ? 0x5f9a44 : 0x4f8a3a;
    const n = 14;
    for (let j = 1; j <= n; j++) {
      const t = j / (n + 1);
      // Point on the quadratic rachis and its tangent.
      const px = (1 - t) * (1 - t) * top.x + 2 * (1 - t) * t * cx + t * t * ex;
      const py = (1 - t) * (1 - t) * top.y + 2 * (1 - t) * t * cy + t * t * ey;
      const tx = 2 * (1 - t) * (cx - top.x) + 2 * t * (ex - cx);
      const ty = 2 * (1 - t) * (cy - top.y) + 2 * t * (ey - cy);
      const tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl;
      const ny = tx / tl;
      const leaf = len * 0.22 * Math.sin(t * Math.PI) + len * 0.04;
      for (const side of [-1, 1]) {
        const lx = px + (nx * side + (tx / tl) * 0.35) * leaf;
        const ly = py + (ny * side + (ty / tl) * 0.35) * leaf + leaf * 0.45;
        cg.moveTo(px, py)
          .quadraticCurveTo(
            (px + lx) / 2 + nx * side * leaf * 0.12,
            (py + ly) / 2 - leaf * 0.1,
            lx,
            ly,
          )
          .stroke({
            width: Math.max(1.2, s * 0.009),
            color: side > 0 ? light : dark,
            cap: 'round',
          });
      }
    }
    cg.moveTo(top.x, top.y)
      .quadraticCurveTo(cx, cy, ex, ey)
      .stroke({ width: Math.max(1.5, s * 0.011), color: 0x3a5a22, cap: 'round' });
  }
  for (let k = 0; k < 4; k++)
    cg.circle(top.x + (k - 1.5) * s * 0.022, top.y + s * 0.03 + (k % 2) * s * 0.012, s * 0.02).fill(
      0x6b5a2a,
    );
  can.addChild(cg);
  return { trunk, canopy: can, pivot: { x: top.x, y: top.y } };
}

/** A small fair-goer seen from afar (for crowds). Origin = feet. `h` = height in px. */
export function drawFairGoer(h: number, seed: number): Graphics {
  const rnd = new ArtRandom(seed);
  const g = new Graphics();
  const skin = rnd.pick([0x8d5a3b, 0xa86b45, 0xbf8558, 0x7a4b30, 0xc99468]);
  const cloth = rnd.pick([
    MELA.vermilion,
    MELA.marigold,
    MELA.peacock,
    MELA.rose,
    MELA.indigo,
    MELA.saffron,
    0xf3ead6,
    MELA.mango,
    0x8a5a9a,
    MELA.lapis,
  ]);
  const accent = rnd.pick([MELA.marigold, MELA.cream, MELA.vermilion, MELA.peacockLight]);
  const feminine = rnd.chance(0.5);
  const w = h * 0.26;
  const headR = h * 0.1;
  softShadow(g, 0, 0, w * 0.9, h * 0.04, MELA.ink, 0.35);
  if (feminine) {
    g.moveTo(-w * 0.45, -h * 0.66)
      .lineTo(w * 0.45, -h * 0.66)
      .lineTo(w * 0.62, -h * 0.02)
      .lineTo(-w * 0.62, -h * 0.02)
      .closePath()
      .fill(cloth);
    g.rect(-w * 0.62, -h * 0.1, w * 1.24, h * 0.06).fill(accent);
    g.moveTo(-w * 0.45, -h * 0.66)
      .lineTo(w * 0.5, -h * 0.4)
      .stroke({ width: h * 0.05, color: accent });
  } else {
    g.roundRect(-w * 0.45, -h * 0.68, w * 0.9, h * 0.38, w * 0.2).fill(cloth);
    g.rect(-w * 0.32, -h * 0.32, w * 0.24, h * 0.3).fill(rnd.chance(0.5) ? 0xf3ead6 : 0x4a3a2a);
    g.rect(w * 0.08, -h * 0.32, w * 0.24, h * 0.3).fill(rnd.chance(0.5) ? 0xf3ead6 : 0x4a3a2a);
  }
  g.circle(0, -h * 0.68 - headR * 0.9, headR).fill(skin);
  if (rnd.chance(0.3)) {
    g.ellipse(0, -h * 0.68 - headR * 1.7, headR * 1.15, headR * 0.55).fill(
      rnd.pick([MELA.saffron, MELA.vermilion, 0xf3ead6]),
    );
  } else {
    g.ellipse(0, -h * 0.68 - headR * 1.35, headR * 1.02, headR * 0.6).fill(0x231815);
  }
  if (rnd.chance(0.25)) {
    // Basket on the head or a balloon in hand.
    if (rnd.chance(0.5))
      g.ellipse(0, -h * 0.68 - headR * 2.2, headR * 1.4, headR * 0.5).fill(0xc49a5a);
    else {
      g.moveTo(w * 0.45, -h * 0.5)
        .lineTo(w * 0.7, -h * 1.05)
        .stroke({ width: 1, color: 0xf6f0e0 });
      g.ellipse(w * 0.7, -h * 1.12, headR * 0.8, headR).fill(
        rnd.pick([MELA.vermilion, MELA.peacockLight, MELA.marigold, MELA.rose]),
      );
    }
  }
  return g;
}

/** Cloud as two layers: shaded body (tint with palette.cloud) and lit highlight (tint with cloudLit). */
export function drawCloud(width: number, seed: number): { body: Graphics; lit: Graphics } {
  const rnd = new ArtRandom(seed);
  const body = new Graphics();
  const lit = new Graphics();
  const h = width * 0.28;
  const puffs: { x: number; y: number; r: number }[] = [];
  const n = 7 + rnd.int(0, 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = (t - 0.5) * width * 0.8;
    const r = h * (0.45 + Math.sin(t * Math.PI) * 0.55) * rnd.range(0.8, 1.1);
    puffs.push({ x, y: -r * 0.55, r });
  }
  // Shade underside.
  body.roundRect(-width * 0.48, -h * 0.25, width * 0.96, h * 0.32, h * 0.16).fill(0xc9c4cf);
  for (const p of puffs) body.circle(p.x, p.y + p.r * 0.08, p.r).fill(0xd4d0d8);
  for (const p of puffs) body.circle(p.x - p.r * 0.06, p.y - p.r * 0.04, p.r * 0.94).fill(0xeeeaf0);
  for (const p of puffs) lit.circle(p.x - p.r * 0.2, p.y - p.r * 0.28, p.r * 0.62).fill(0xffffff);
  for (const p of puffs.slice(1, -1))
    lit.circle(p.x - p.r * 0.32, p.y - p.r * 0.45, p.r * 0.32).fill(0xffffff);
  return { body, lit };
}

/** Bird silhouette, wings up (frame 0) or down (frame 1). */
export function drawBird(size: number, frame: 0 | 1, color = 0x2b2233): Graphics {
  const g = new Graphics();
  const wy = frame === 0 ? -size * 0.7 : size * 0.35;
  g.moveTo(-size, wy)
    .quadraticCurveTo(-size * 0.45, frame === 0 ? -size * 0.2 : size * 0.05, 0, 0)
    .quadraticCurveTo(size * 0.45, frame === 0 ? -size * 0.2 : size * 0.05, size, wy)
    .quadraticCurveTo(size * 0.45, frame === 0 ? -size * 0.05 : size * 0.22, 0, size * 0.18)
    .quadraticCurveTo(-size * 0.45, frame === 0 ? -size * 0.05 : size * 0.22, -size, wy)
    .fill(color);
  g.ellipse(0, size * 0.08, size * 0.14, size * 0.1).fill(color);
  return g;
}

/** Grass tuft with optional wildflowers. */
export function drawTuft(size: number, seed: number, flowers = true): Graphics {
  const rnd = new ArtRandom(seed);
  const g = new Graphics();
  for (let i = 0; i < 9; i++) {
    const x = rnd.range(-size * 0.5, size * 0.5);
    const h = size * rnd.range(0.5, 1.1);
    const lean = rnd.range(-0.4, 0.4) * size;
    g.moveTo(x - size * 0.05, 0)
      .quadraticCurveTo(x + lean * 0.4, -h * 0.6, x + lean, -h)
      .quadraticCurveTo(x + lean * 0.3, -h * 0.5, x + size * 0.05, 0)
      .fill(rnd.chance(0.5) ? 0x6b8f3a : 0x557a30);
  }
  if (flowers) {
    for (let i = 0; i < 3; i++) {
      if (rnd.chance(0.6))
        marigold(
          g,
          rnd.range(-size * 0.4, size * 0.4),
          -size * rnd.range(0.6, 1),
          size * 0.09,
          rnd.pick([MELA.marigold, MELA.saffron, MELA.rose]),
        );
    }
  }
  return g;
}

/** Tulsi planter (vrindavan) with plant. */
export function drawTulsi(s: number, seed: number): Graphics {
  const rnd = new ArtRandom(seed);
  const g = new Graphics();
  softShadow(g, 0, 0, s * 0.5, s * 0.08, MELA.ink, 0.3);
  g.roundRect(-s * 0.36, -s * 0.7, s * 0.72, s * 0.7, s * 0.04).fill(
    vgrad([
      [0, 0xe9d3b0],
      [1, 0xbf9f78],
    ]),
  );
  g.rect(-s * 0.42, -s * 0.78, s * 0.84, s * 0.1).fill(0xd8c09a);
  g.rect(-s * 0.42, -s * 0.06, s * 0.84, s * 0.06).fill(0xb89a72);
  // Painted motifs.
  g.circle(0, -s * 0.38, s * 0.12).stroke({ width: s * 0.02, color: MELA.vermilion });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    g.circle(Math.cos(a) * s * 0.18, -s * 0.38 + Math.sin(a) * s * 0.18, s * 0.018).fill(
      MELA.marigold,
    );
  }
  for (let i = 0; i < 40; i++) {
    const x = rnd.range(-s * 0.3, s * 0.3);
    const y = -s * 0.78 - rnd.range(0, s * 0.45) * (1 - Math.abs(x) / (s * 0.4));
    g.ellipse(x, y, s * 0.05, s * 0.03).fill(rnd.chance(0.5) ? 0x4f7a3a : 0x6e9b4a);
  }
  return g;
}

/** Smooth ridge line points for hills (deterministic). */
export function ridgePoints(
  width: number,
  baseY: number,
  amplitude: number,
  seed: number,
  wavelength: number,
  segments = 64,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = t * width;
    const n =
      Math.sin((x / wavelength) * Math.PI * 2 + seed) * 0.55 +
      Math.sin((x / (wavelength * 0.43)) * Math.PI * 2 + seed * 1.7) * 0.28 +
      Math.sin((x / (wavelength * 0.19)) * Math.PI * 2 + seed * 3.1) * 0.12;
    pts.push({ x, y: baseY - amplitude * (0.5 + 0.5 * n) });
  }
  return pts;
}

/** Fill a ridge silhouette down to `bottom` with a vertical gradient. */
export function fillRidge(
  g: Graphics,
  pts: readonly { x: number; y: number }[],
  bottom: number,
  top: number,
  low: number,
): void {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return;
  smoothPath(g, pts);
  g.lineTo(last.x, bottom).lineTo(first.x, bottom).closePath();
  g.fill(
    vgrad([
      [0, top],
      [1, low],
    ]),
  );
}

/** Rounded field patch with crop rows (Road Home). */
export function drawField(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  rows: number,
): void {
  g.roundRect(x, y, w, h, h * 0.3).fill(color);
  for (let i = 1; i < rows; i++) {
    const yy = y + (h / rows) * i;
    g.moveTo(x + w * 0.04, yy)
      .lineTo(x + w * 0.96, yy)
      .stroke({ width: Math.max(1, h * 0.04), color: darken(color, 0.18), alpha: 0.7 });
  }
}

/** A star dot (twinkles via alpha). */
export function drawStar(r: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r * 2.4).fill(
    rgrad([
      [0, '#fff6dcff'],
      [0.3, '#fff6dc55'],
      [1, '#fff6dc00'],
    ]),
  );
  g.circle(0, 0, r * 0.6).fill(0xffffff);
  return g;
}
