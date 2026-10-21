/**
 * Static body parts of the rig, drawn once per (appearance, view) and baked to textures by the
 * character. Every part is drawn in rig units around its joint origin:
 *
 * - torso (with neck, top garment and chest drape) around the figure origin, per view yaw;
 * - lower garment (skirt, or the pelvis piece of trousers/dhoti/salwar/nauvari) per view yaw;
 * - limb segments (upper arm, forearm, thigh, shin) pointing down from their joint (view-independent);
 * - hands per shape (drawn for the screen-right arm; mirrored for the other side) and feet per view.
 *
 * Turned views use the wrap projection so garment details (plackets, buttons, borders, the saree
 * pallu) slide around the body and foreshorten instead of being pasted flat.
 */
import type { Graphics } from 'pixi.js';
import { darken, lighten } from '../../color.ts';
import { vgrad } from '../../draw.ts';
import { MELA } from '../../palettes.ts';
import type { Appearance } from '../appearance.ts';
import { type RigDims, torsoSection } from './dims.ts';
import { sectionExtent, wrapX } from './kinematics.ts';
import type { HandShape } from './pose.ts';

type Pt = { x: number; y: number };

/** Continue a path through points with a Catmull-Rom spline (no moveTo unless `move`). */
function curveThrough(g: Graphics, pts: readonly Pt[], move: boolean): void {
  const n = pts.length;
  if (n === 0) return;
  const at = (i: number): Pt => pts[Math.max(0, Math.min(n - 1, i))] ?? { x: 0, y: 0 };
  const p0 = at(0);
  if (move) g.moveTo(p0.x, p0.y);
  else g.lineTo(p0.x, p0.y);
  for (let i = 0; i < n - 1; i++) {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const d = at(i + 2);
    g.bezierCurveTo(
      b.x + (c.x - a.x) / 6,
      b.y + (c.y - a.y) / 6,
      c.x - (d.x - b.x) / 6,
      c.y - (d.y - b.y) / 6,
      c.x,
      c.y,
    );
  }
}

/** Wrap helper for the torso at yaw `theta`. */
function torsoWrap(d: RigDims, theta: number) {
  return {
    x: (x: number, y: number): number => {
      const s = torsoSection(d, y);
      return wrapX(x, s.w, s.df, theta).x;
    },
    facing: (x: number, y: number): number => {
      const s = torsoSection(d, y);
      return wrapX(x, s.w, s.df, theta).facing;
    },
  };
}

/* ============================================ torso ============================================ */

export function drawTorso(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const st = Math.sin(theta);
  const W = torsoWrap(d, theta);
  const skin = a.skin;
  const skinShade = darken(skin, 0.18);
  const uc = a.upperColor;
  const trim = a.upperTrim;
  const top = d.shoulderY;
  const neckW = 9;
  const hemY = d.hemY;

  // Neck (behind the collar), slightly forward in profile.
  const neckX = 4 * st;
  g.roundRect(neckX - neckW, d.neckTop - 6, neckW * 2, top - d.neckTop + 16, 6).fill(skinShade);
  g.rect(neckX - neckW, d.neckTop + 6, neckW * 2, 6).fill({ color: 0x000000, alpha: 0.08 });

  // Silhouette from projected cross-sections.
  const ys = [top - 7, top + 6, top + 30, d.waistY - 12];
  if (hemY > d.hipY + 2) ys.push(d.hipY, hemY);
  else ys.push(Math.max(hemY, d.waistY - 11));
  const right: Pt[] = [];
  const left: Pt[] = [];
  for (const y of ys) {
    const s = torsoSection(d, y);
    const e = sectionExtent(s.w, s.df, s.db, theta);
    right.push({ x: e.right, y });
    left.push({ x: e.left, y });
  }
  const r0 = right[0] ?? { x: 10, y: top };
  const l0 = left[0] ?? { x: -10, y: top };
  const rHem = right[right.length - 1] ?? r0;
  const lHem = left[left.length - 1] ?? l0;
  const hemMid = W.x(0, hemY);
  const fillTorso = vgrad([
    [0, lighten(uc, 0.1)],
    [1, darken(uc, 0.18)],
  ]);
  g.moveTo(l0.x * 0.55 + neckX * 0.45, top - 8);
  g.quadraticCurveTo(neckX, top - 9, r0.x * 0.55 + neckX * 0.45, top - 8);
  curveThrough(g, right, false);
  g.quadraticCurveTo(hemMid, hemY + 4, lHem.x, lHem.y);
  curveThrough(g, [...left].reverse(), false);
  g.closePath().fill(fillTorso);

  // Volume: shade the far side (right in front view, the back in turned views).
  const shadeSide = theta > 0.15 ? left : right;
  const inner = shadeSide.map((p) => ({ x: p.x * (theta > 0.15 ? 0.62 : 0.6), y: p.y }));
  curveThrough(g, shadeSide, true);
  curveThrough(g, [...inner].reverse(), false);
  g.closePath().fill({ color: 0x000000, alpha: 0.1 });
  if (theta > 0.15) {
    // Light along the chest edge.
    const rim = right.map((p) => ({ x: p.x * 0.86, y: p.y }));
    curveThrough(g, right.slice(1, -1), true);
    curveThrough(g, rim.slice(1, -1).reverse(), false);
    g.closePath().fill({ color: 0xffffff, alpha: 0.08 });
  }

  // Neckline.
  const dip = a.upper === 'blouse' ? 12 : 4;
  const nl = { x: W.x(-neckW - 3, top - 7), y: top - 7 };
  const nr = { x: W.x(neckW + 3, top - 7), y: top - 7 };
  const nc = { x: W.x(0, top + dip), y: top + dip };
  g.moveTo(nl.x, nl.y)
    .quadraticCurveTo(nc.x, nc.y, nr.x, nr.y)
    .lineTo(nr.x, nr.y - 2)
    .quadraticCurveTo(nc.x, top - 8, nl.x, nl.y - 2)
    .closePath()
    .fill(skinShade);
  g.moveTo(nl.x, nl.y).quadraticCurveTo(nc.x, nc.y, nr.x, nr.y).stroke({ width: 3, color: trim });

  if (a.upper === 'blouse' && a.drape !== 'pallu' && a.drape !== 'chador') {
    const y0 = d.waistY - 14;
    const xl = W.x(-d.ww * 0.95, y0);
    const xr = W.x(d.ww * 0.95, y0);
    g.rect(xl, y0, xr - xl, 10).fill(skinShade);
    g.moveTo(xl, y0).lineTo(xr, y0).stroke({ width: 2.5, color: trim });
  }
  if (a.upper === 'kurta' || a.upper === 'kurta_long' || a.upper === 'kameez') {
    if (W.facing(0, top + 20) > 0.05) {
      g.moveTo(W.x(0, top + 2), top + 2)
        .lineTo(W.x(0, top + 40), top + 40)
        .stroke({ width: 2, color: darken(uc, 0.25) });
      for (let k = 0; k < 4; k++)
        g.circle(W.x(0, top + 10 + k * 9), top + 10 + k * 9, 1.8).fill(trim);
    }
    g.moveTo(lHem.x, hemY).quadraticCurveTo(hemMid, hemY + 4, rHem.x, hemY);
    g.stroke({ width: 4, color: trim });
    // Side slits of the kurta.
    for (const sx of [-1, 1]) {
      const f = W.facing(sx * d.hemHalf * 0.98, hemY - 10);
      if (f < 0.05) continue;
      const x = W.x(sx * d.hemHalf * 0.96, hemY - 22);
      g.moveTo(x, hemY - 26)
        .lineTo(W.x(sx * d.hemHalf * 0.98, hemY), hemY)
        .stroke({
          width: 1.5,
          color: darken(uc, 0.25),
          alpha: 0.8,
        });
    }
    if (a.upper === 'kameez') {
      for (let k = -3; k <= 3; k++) {
        const x = k * 5;
        if (W.facing(x, top + 6) > 0.1)
          g.circle(W.x(x, top + 6 + Math.abs(k) * 1.5), top + 6 + Math.abs(k) * 1.5, 1.8).fill(
            trim,
          );
      }
      // Embroidered yoke.
      g.moveTo(W.x(-14, top + 14), top + 14)
        .quadraticCurveTo(W.x(0, top + 26), top + 26, W.x(14, top + 14), top + 14)
        .stroke({ width: 2, color: trim, alpha: 0.85 });
    }
  }
  if (a.upper === 'shirt' || a.upper === 'vest_shirt') {
    const collar = lighten(uc, 0.2);
    for (const sx of [-1, 1]) {
      if (W.facing(sx * 8, top) < 0.05) continue;
      g.poly([
        W.x(sx * (neckW + 3), top - 7),
        top - 7,
        W.x(sx * 2, top + 8),
        top + 8,
        W.x(sx * (neckW + 10), top + 2),
        top + 2,
      ]).fill(collar);
    }
    if (W.facing(0, top + 30) > 0.05) {
      g.moveTo(W.x(0, top + 6), top + 6)
        .lineTo(W.x(0, hemY), hemY)
        .stroke({ width: 1.5, color: darken(uc, 0.2) });
      for (let k = 0; k < 5; k++)
        g.circle(W.x(2.5, top + 14 + k * 14), top + 14 + k * 14, 1.6).fill(darken(uc, 0.3));
    }
    if (W.facing(-d.sw * 0.6, top + 30) > 0.05) {
      // Breast pocket.
      const px = W.x(-d.sw * 0.5, top + 22);
      g.roundRect(px - 6, top + 18, 12, 12, 2).stroke({ width: 1.3, color: darken(uc, 0.22) });
    }
    if (a.upper === 'vest_shirt') {
      for (const sx of [-1, 1]) {
        const pts = [
          [sx * 3, top + 6],
          [sx * (d.sw - 6), top + 2],
          [sx * d.sw * 0.96, d.waistY - 20],
          [sx * d.hemHalf * 0.95, hemY - 2],
          [sx * 6, hemY + 2],
        ] as const;
        const flat = pts.flatMap(([x, y]) => [W.x(x, y), y]);
        g.poly(flat).fill(trim);
        g.poly(flat).stroke({ width: 1.2, color: darken(trim, 0.3), alpha: 0.6 });
      }
    }
  }

  drawChestDrape(g, a, d, theta);
}

function drawChestDrape(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const W = torsoWrap(d, theta);
  const top = d.shoulderY;
  const dc = a.drapeColor;
  const wp = (pts: readonly (readonly [number, number])[]): number[] =>
    pts.flatMap(([x, y]) => [W.x(x, y), y]);
  switch (a.drape) {
    case 'pallu':
    case 'chador': {
      const s = a.drape === 'pallu' ? 1 : -1;
      const band = wp([
        [-s * d.ww * 1.05, d.waistY + 18],
        [-s * d.ww * 0.2, d.waistY + 24],
        [s * d.sw * 0.95, top + 2],
        [s * d.sw * 0.25, top - 6],
      ]);
      g.poly(band).fill(
        vgrad([
          [0, lighten(dc, 0.1)],
          [1, darken(dc, 0.12)],
        ]),
      );
      const b0x = W.x(-s * d.ww * 0.2, d.waistY + 24);
      const b1x = W.x(s * d.sw * 0.95, top + 2);
      g.moveTo(b0x, d.waistY + 24)
        .lineTo(b1x, top + 2)
        .stroke({ width: a.drape === 'pallu' ? 6 : 7, color: a.lowerBorder });
      for (let k = 1; k < 4; k++)
        g.moveTo(W.x(-s * d.ww + s * k * 8, d.waistY + 18), d.waistY + 18)
          .lineTo(W.x(s * d.sw * 0.3 + s * k * 9, top - 2), top - 2)
          .stroke({ width: 1.2, color: darken(dc, 0.3), alpha: 0.5 });
      if (a.drape === 'chador')
        for (let k = 0; k < 5; k++) {
          const tt = (k + 0.5) / 5;
          const fx = -s * d.ww * 0.2 + (s * d.sw * 0.95 + s * d.ww * 0.2) * tt;
          const fy = d.waistY + 24 + (top + 2 - d.waistY - 24) * tt;
          const x = W.x(fx, fy);
          g.poly([x - 3, fy + 6, x, fy + 1, x + 3, fy + 6]).fill(lighten(a.lowerBorder, 0.4));
        }
      break;
    }
    case 'dupatta': {
      const n = 9;
      const outer: Pt[] = [];
      const innerPts: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const x = -d.sw + 2 + (2 * d.sw - 4) * u;
        const sag = Math.sin(Math.PI * u);
        outer.push({ x: W.x(x * 1.04, top + 14 + sag * 46), y: top + 14 + sag * 46 });
        innerPts.push({ x: W.x(x, top + 2 + sag * 32), y: top + 2 + sag * 32 });
      }
      curveThrough(g, innerPts, true);
      curveThrough(g, [...outer].reverse(), false);
      g.closePath().fill(dc);
      curveThrough(g, outer, true);
      g.stroke({ width: 2.5, color: lighten(dc, 0.35) });
      break;
    }
    case 'shawl': {
      const pts = wp([
        [-d.sw - 6, top + 22],
        [-d.sw * 0.6, top - 6],
        [0, top - 2],
        [d.sw * 0.6, top - 6],
        [d.sw + 6, top + 22],
        [d.sw * 0.55, top + 48],
        [0, top + 32],
        [-d.sw * 0.55, top + 48],
      ]);
      g.poly(pts).fill(
        vgrad([
          [0, lighten(dc, 0.1)],
          [1, darken(dc, 0.15)],
        ]),
      );
      for (let k = -6; k <= 6; k++) {
        const x = k * 5;
        if (W.facing(x, top + 36) < 0.1) continue;
        const y = top + 34 + Math.abs(k) * 1.6;
        g.moveTo(W.x(x, y), y)
          .lineTo(W.x(x, y + 6), y + 6)
          .stroke({ width: 1.4, color: lighten(dc, 0.4) });
      }
      break;
    }
    case 'gamcha': {
      // Folded over the shoulder; the hanging end is a cloth chain.
      const x0 = -d.sw * 0.65;
      const pts = wp([
        [x0, top - 4],
        [x0 + 18, top - 4],
        [x0 + 18, top + 22],
        [x0, top + 22],
      ]);
      g.poly(pts).fill(dc);
      for (let k = 0; k < 3; k++) {
        const y = top + 2 + k * 8;
        g.moveTo(W.x(x0, y), y)
          .lineTo(W.x(x0 + 18, y), y)
          .stroke({ width: 1.5, color: lighten(dc, 0.5), alpha: 0.8 });
      }
      break;
    }
    case 'none':
      break;
  }
}

/* ======================================== lower garment ======================================== */

/** Skirt cross-section rows: [y, half-width]. */
function skirtRows(a: Appearance, d: RigDims): (readonly [number, number])[] {
  const ankle = -10;
  const { ww, hw } = d;
  switch (a.lower) {
    case 'mekhela':
      return [
        [d.waistY, ww],
        [d.hipY, hw * 1.02],
        [ankle, hw * 1.1],
      ];
    case 'mundu':
      return [
        [d.waistY, ww],
        [d.hipY, hw * 1.02],
        [ankle, hw * 1.08],
      ];
    case 'lehenga':
      return [
        [d.waistY, ww],
        [d.hipY, hw * 1.1],
        [-60, hw * 1.35],
        [ankle, hw * 1.5],
      ];
    default:
      return [
        [d.waistY, ww],
        [d.hipY, hw * 1.05],
        [-60, hw * 1.2],
        [ankle, hw * 1.32],
      ];
  }
}

export function drawLowerGarment(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  if (d.skirt) drawSkirt(g, a, d, theta);
  else drawPelvis(g, a, d, theta);
}

function drawSkirt(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const rows = skirtRows(a, d);
  const lc = a.lowerColor;
  const lb = a.lowerBorder;
  const ankle = -10;
  const depthF = a.lower === 'sari' || a.lower === 'lehenga' ? 0.8 : 0.66;
  const ext = rows.map(([y, w]) => ({ y, w, e: sectionExtent(w, w * depthF, w * 0.62, theta) }));
  const right = ext.map((r) => ({ x: r.e.right, y: r.y }));
  const left = ext.map((r) => ({ x: r.e.left, y: r.y }));
  const wrapAt = (x: number, y: number): { x: number; facing: number } => {
    let w = rows[0]?.[1] ?? 20;
    for (let i = 1; i < rows.length; i++) {
      const p = rows[i - 1];
      const q = rows[i];
      if (p && q && y <= q[0]) {
        const u = (y - p[0]) / Math.max(1e-6, q[0] - p[0]);
        w = p[1] + (q[1] - p[1]) * u;
        break;
      }
      if (q) w = q[1];
    }
    return wrapX(x, w, w * depthF, theta);
  };
  const lHem = left[left.length - 1] ?? { x: -20, y: ankle };
  const rHem = right[right.length - 1] ?? { x: 20, y: ankle };
  const hemMid = wrapAt(0, ankle).x;
  curveThrough(g, left, true);
  g.quadraticCurveTo(hemMid, ankle + 6, rHem.x, rHem.y);
  curveThrough(g, [...right].reverse(), false);
  g.closePath().fill(
    vgrad([
      [0, lighten(lc, 0.08)],
      [1, darken(lc, a.lower === 'mundu' ? 0.12 : 0.18)],
    ]),
  );
  // Shade the back/far side.
  const shade = theta > 0.15 ? left : right;
  curveThrough(g, shade, true);
  curveThrough(
    g,
    [...shade].reverse().map((p) => ({ x: p.x * 0.66 + (theta > 0.15 ? 0 : 0), y: p.y })),
    false,
  );
  g.closePath().fill({ color: 0x000000, alpha: 0.09 });

  const bandH = a.lower === 'mekhela' ? 0 : a.lower === 'mundu' ? 7 : 14;
  if (a.lower === 'sari' || a.lower === 'lehenga') {
    // Front pleats.
    for (let k = -3; k <= 3; k++) {
      const top = wrapAt(k * 2.5, d.hipY + 10);
      const bot = wrapAt(k * 7.5, ankle + 2);
      if (bot.facing < 0.05) continue;
      g.moveTo(top.x, d.hipY + 10)
        .quadraticCurveTo(wrapAt(k * 5, -70).x, -70, bot.x, ankle + 2)
        .stroke({ width: 1.6, color: darken(lc, 0.28), alpha: 0.7 });
    }
  }
  if (bandH > 0) {
    const yTop = ankle - bandH - 2;
    const pts: Pt[] = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      pts.push({ x: lHem.x + (rHem.x - lHem.x) * u, y: ankle - 2 + Math.sin(Math.PI * u) * 5 });
    }
    const topPts = pts.map((p) => ({ x: p.x * 0.97, y: p.y - bandH }));
    curveThrough(g, pts, true);
    curveThrough(g, [...topPts].reverse(), false);
    g.closePath().fill(lb);
    for (let k = -5; k <= 5; k++) {
      const w = wrapAt(k * d.hw * 0.22, yTop + bandH / 2);
      if (w.facing < 0.15) continue;
      g.circle(w.x, ankle - 3 - bandH / 2 + 3, 1.8).fill(lighten(lb, 0.5));
    }
  }
  if (a.lower === 'mekhela') {
    const yb = ankle - 30;
    const l = wrapAt(-d.hw * 1.2, yb).x;
    const r = wrapAt(d.hw * 1.2, yb).x;
    g.rect(l, yb, r - l, 16).fill(lb);
    for (let k = -4; k <= 4; k++) {
      const w = wrapAt(k * d.hw * 0.24, yb + 8);
      if (w.facing < 0.15) continue;
      g.poly([w.x - 4, yb + 8, w.x, yb + 2, w.x + 4, yb + 8, w.x, yb + 14]).fill(lighten(lb, 0.55));
    }
    g.rect(lHem.x, ankle - 8, rHem.x - lHem.x, 5).fill(lb);
  }
  if (a.lower === 'mundu') {
    const s = wrapAt(d.hw * 0.35, d.waistY + 2);
    if (s.facing > 0.05)
      g.moveTo(s.x, d.waistY + 2)
        .lineTo(wrapAt(d.hw * 0.45, ankle).x, ankle)
        .stroke({ width: 5, color: lb });
  }
  // Waist tuck line.
  g.moveTo(left[0]?.x ?? 0, d.waistY + 2)
    .quadraticCurveTo(wrapAt(0, d.waistY + 6).x, d.waistY + 6, right[0]?.x ?? 0, d.waistY + 2)
    .stroke({ width: 2, color: darken(lc, 0.25), alpha: 0.5 });
}

function drawPelvis(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const lc = a.lowerColor;
  const lb = a.lowerBorder;
  const { ww, hw } = d;
  let rows: (readonly [number, number])[];
  switch (a.lower) {
    case 'dhoti':
      rows = [
        [d.waistY, ww * 1.02],
        [d.hipY, hw * 1.18],
        [d.hipY + 34, hw * 1.12],
      ];
      break;
    case 'salwar':
      rows = [
        [d.waistY, ww],
        [d.hipY, hw * 1.15],
        [d.hipY + 30, hw * 1.15],
      ];
      break;
    case 'nauvari':
      rows = [
        [d.waistY + 4, ww * 1.02],
        [d.hipY, hw * 1.08],
        [d.hipY + 28, hw * 1.05],
      ];
      break;
    default:
      rows = [
        [d.waistY + 6, ww],
        [d.hipY, hw * 1.0],
        [d.hipY + 22, hw * 0.96],
      ];
  }
  const ext = rows.map(([y, w]) => ({ y, w, e: sectionExtent(w, w * 0.68, w * 0.7, theta) }));
  const right = ext.map((r) => ({ x: r.e.right, y: r.y }));
  const left = ext.map((r) => ({ x: r.e.left, y: r.y }));
  const bottom = rows[rows.length - 1]?.[0] ?? d.hipY;
  const crotchX = wrapX(
    0,
    rows[rows.length - 1]?.[1] ?? hw,
    (rows[rows.length - 1]?.[1] ?? hw) * 0.68,
    theta,
  ).x;
  curveThrough(g, left, true);
  const lB = left[left.length - 1] ?? { x: -hw, y: bottom };
  const rB = right[right.length - 1] ?? { x: hw, y: bottom };
  const notch = theta < 0.9 ? 8 * Math.cos(theta) : 0;
  g.quadraticCurveTo((lB.x + crotchX) / 2, bottom + 6, crotchX, bottom - notch);
  g.quadraticCurveTo((rB.x + crotchX) / 2, bottom + 6, rB.x, rB.y);
  curveThrough(g, [...right].reverse(), false);
  g.closePath().fill(
    vgrad([
      [0, lighten(lc, 0.06)],
      [1, darken(lc, 0.14)],
    ]),
  );
  const W = (x: number, y: number): { x: number; facing: number } => {
    const w = y < d.hipY ? ww : hw;
    return wrapX(x, w, w * 0.68, theta);
  };
  if (a.lower === 'dhoti') {
    for (let k = -2; k <= 2; k++) {
      const t = W(k * 3, d.hipY + 4);
      if (t.facing < 0.05) continue;
      g.moveTo(t.x, d.hipY + 4)
        .quadraticCurveTo(W(k * 2, d.hipY + 20).x, d.hipY + 20, W(k * 1.5, bottom).x, bottom)
        .stroke({ width: 1.5, color: darken(lc, 0.25) });
    }
    const b = W(-hw * 0.9, d.hipY);
    g.moveTo(b.x, d.hipY - 4)
      .lineTo(W(-2, bottom).x, bottom)
      .stroke({ width: 3, color: lb });
  } else if (a.lower === 'nauvari') {
    g.moveTo(W(-hw * 0.9, d.waistY + 10).x, d.waistY + 10)
      .lineTo(W(hw * 0.5, bottom).x, bottom)
      .stroke({ width: 5, color: lb, alpha: 0.9 });
  } else if (a.lower === 'salwar') {
    for (let k = -1; k <= 1; k += 2) {
      const t = W(k * hw * 0.5, d.hipY);
      if (t.facing < 0.05) continue;
      g.moveTo(t.x, d.waistY + 6)
        .quadraticCurveTo(
          W(k * hw * 0.7, d.hipY + 10).x,
          d.hipY + 10,
          W(k * hw * 0.55, bottom).x,
          bottom,
        )
        .stroke({ width: 1.4, color: darken(lc, 0.2), alpha: 0.7 });
    }
  } else {
    // Trousers: belt and fly.
    g.moveTo(left[0]?.x ?? 0, d.waistY + 8)
      .lineTo(right[0]?.x ?? 0, d.waistY + 8)
      .stroke({ width: 3, color: darken(lc, 0.35) });
    const f = W(0, d.hipY);
    if (f.facing > 0.1)
      g.moveTo(W(0, d.waistY + 10).x, d.waistY + 10)
        .lineTo(f.x, bottom - 6)
        .stroke({ width: 1.2, color: darken(lc, 0.3), alpha: 0.6 });
  }
}

/* ============================================ limbs ============================================ */

type LegStyle = {
  thighCol: number;
  shinCol: number;
  thighW: [number, number];
  shinW: [number, number];
};

function legStyle(a: Appearance): LegStyle {
  const b = a.build;
  const skinShade = darken(a.skin, 0.08);
  switch (a.lower) {
    case 'pants':
      return {
        thighCol: a.lowerColor,
        shinCol: a.lowerColor,
        thighW: [17 * b, 14 * b],
        shinW: [14 * b, 13 * b],
      };
    case 'dhoti':
      return {
        thighCol: a.lowerColor,
        shinCol: skinShade,
        thighW: [25 * b, 22 * b],
        shinW: [11 * b, 8 * b],
      };
    case 'salwar':
      return {
        thighCol: a.lowerColor,
        shinCol: a.lowerColor,
        thighW: [26 * b, 23 * b],
        shinW: [22 * b, 13 * b],
      };
    case 'nauvari':
      return {
        thighCol: a.lowerColor,
        shinCol: skinShade,
        thighW: [20 * b, 16 * b],
        shinW: [11 * b, 8 * b],
      };
    default:
      return {
        thighCol: skinShade,
        shinCol: skinShade,
        thighW: [15 * b, 11 * b],
        shinW: [11 * b, 8 * b],
      };
  }
}

/** Tapered capsule from (0, y0) to (0, y1). */
function capsule(
  g: Graphics,
  y0: number,
  y1: number,
  w0: number,
  w1: number,
  color: number | ReturnType<typeof vgrad>,
): void {
  g.moveTo(-w0 / 2, y0)
    .bezierCurveTo(-w0 / 2, y0 - w0 * 0.6, w0 / 2, y0 - w0 * 0.6, w0 / 2, y0)
    .lineTo(w1 / 2, y1)
    .bezierCurveTo(w1 / 2, y1 + w1 * 0.6, -w1 / 2, y1 + w1 * 0.6, -w1 / 2, y1)
    .closePath()
    .fill(color);
}

export function drawThigh(g: Graphics, a: Appearance, d: RigDims): void {
  const s = legStyle(a);
  capsule(
    g,
    0,
    d.thigh,
    s.thighW[0],
    s.thighW[1],
    vgrad([
      [0, lighten(s.thighCol, 0.05)],
      [1, darken(s.thighCol, 0.1)],
    ]),
  );
  if (a.lower === 'pants')
    g.moveTo(1.5, 4)
      .lineTo(1, d.thigh - 2)
      .stroke({ width: 1.2, color: lighten(a.lowerColor, 0.2), alpha: 0.5 });
  if (a.lower === 'dhoti' || a.lower === 'salwar')
    for (const x of [-5, 3])
      g.moveTo(x, 6)
        .quadraticCurveTo(x + 3, d.thigh * 0.5, x - 1, d.thigh)
        .stroke({ width: 1.3, color: darken(a.lowerColor, 0.22), alpha: 0.7 });
  if (a.lower === 'dhoti')
    g.moveTo(-s.thighW[1] / 2, d.thigh + 6)
      .lineTo(s.thighW[1] / 2, d.thigh + 6)
      .stroke({ width: 2.5, color: a.lowerBorder });
  if (a.lower === 'nauvari')
    g.moveTo(-s.thighW[1] / 2, d.thigh + 4)
      .lineTo(s.thighW[1] / 2, d.thigh + 4)
      .stroke({ width: 5, color: a.lowerBorder });
}

export function drawShin(g: Graphics, a: Appearance, d: RigDims): void {
  const s = legStyle(a);
  capsule(g, 0, d.shin, s.shinW[0], s.shinW[1], s.shinCol);
  if (a.lower === 'pants')
    g.rect(-s.shinW[1] / 2, d.shin - 6, s.shinW[1], 6).fill(darken(a.lowerColor, 0.18));
  if (a.lower === 'salwar')
    g.roundRect(-s.shinW[1] / 2 - 1, d.shin - 8, s.shinW[1] + 2, 8, 3).fill(a.lowerBorder);
  if (a.lower === 'dhoti') {
    capsule(g, -2, d.shin * 0.35, 23 * a.build, 20 * a.build, a.lowerColor);
    g.moveTo(-10 * a.build, d.shin * 0.35 + 4)
      .lineTo(10 * a.build, d.shin * 0.35 + 4)
      .stroke({ width: 2.5, color: a.lowerBorder });
  }
  if (a.lower === 'nauvari') {
    capsule(g, -2, d.shin * 0.22, 15 * a.build, 13 * a.build, a.lowerColor);
    g.moveTo(-7, d.shin * 0.22 + 3)
      .lineTo(7, d.shin * 0.22 + 3)
      .stroke({ width: 4, color: a.lowerBorder });
  }
}

const SLEEVE_FULL = new Set(['kurta', 'kurta_long', 'kameez', 'shirt']);

export function drawUpperArm(g: Graphics, a: Appearance, d: RigDims): void {
  const w = 13 * a.build;
  const L = d.upperArm;
  capsule(g, 0, L, w + 1, w * 0.9, a.skin);
  const full = SLEEVE_FULL.has(a.upper);
  const sleeveLen = full ? L + 4 : a.upper === 'vest_shirt' ? L * 0.55 : L * 0.42;
  const col = darken(a.upperColor, 0.04);
  capsule(
    g,
    -1,
    sleeveLen,
    w + 4,
    w + 2,
    vgrad([
      [0, lighten(col, 0.06)],
      [1, darken(col, 0.08)],
    ]),
  );
  g.moveTo(-w / 2 - 1.5, sleeveLen + 1)
    .lineTo(w / 2 + 1.5, sleeveLen + 1)
    .stroke({ width: 2.5, color: a.upperTrim });
  g.moveTo(w * 0.25, 4)
    .lineTo(w * 0.2, sleeveLen - 4)
    .stroke({ width: 1.2, color: 0x000000, alpha: 0.08 });
}

export function drawForearm(g: Graphics, a: Appearance, d: RigDims): void {
  const w = 12 * a.build;
  const L = d.foreArm;
  capsule(g, 0, L, w, w * 0.78, a.skin);
  if (SLEEVE_FULL.has(a.upper)) {
    const col = darken(a.upperColor, 0.08);
    capsule(g, -2, L - 9, w + 3, w + 1, col);
    g.moveTo(-w / 2 - 1.5, L - 8)
      .lineTo(w / 2 + 1.5, L - 8)
      .stroke({ width: 2.5, color: a.upperTrim });
  }
  if (a.bangles)
    for (let k = 0; k < 3; k++)
      g.moveTo(-w / 2 - 1, L - 9 + k * 3.2)
        .lineTo(w / 2 + 1, L - 9 + k * 3.2)
        .stroke({ width: 2.2, color: k === 1 ? MELA.vermilion : MELA.brass });
}

/** Hand drawn for the screen-right arm (thumb towards -x), origin at the wrist, pointing +y. */
export function drawHand(g: Graphics, a: Appearance, shape: HandShape): void {
  const skin = a.skin;
  const line = darken(skin, 0.28);
  const s = a.build;
  switch (shape) {
    case 'relaxed':
      g.ellipse(0, 8 * s, 7.5 * s, 9 * s).fill(skin);
      g.ellipse(-5.5 * s, 5 * s, 3.2 * s, 5.5 * s).fill(skin);
      g.moveTo(-2 * s, 13 * s)
        .quadraticCurveTo(1 * s, 15 * s, 4 * s, 13 * s)
        .stroke({ width: 1, color: line, alpha: 0.6 });
      break;
    case 'open': {
      g.ellipse(0, 7 * s, 8 * s, 7.5 * s).fill(skin);
      const fingers: [number, number][] = [
        [-4.5, 0.18],
        [-1.5, 0.06],
        [1.6, -0.06],
        [4.4, -0.2],
      ];
      for (const [x, ang] of fingers) {
        const len = (x > -2 && x < 2 ? 11 : 9.5) * s;
        const ex = x * s + Math.sin(-ang) * len;
        const ey = 12 * s + Math.cos(ang) * len;
        g.moveTo(x * s, 11 * s)
          .lineTo(ex, ey)
          .stroke({ width: 3.6 * s, color: skin, cap: 'round' });
      }
      g.moveTo(-6 * s, 6 * s)
        .lineTo(-12 * s, 10 * s)
        .stroke({ width: 4 * s, color: skin, cap: 'round' });
      g.moveTo(-2 * s, 9 * s)
        .quadraticCurveTo(1 * s, 11 * s, 3 * s, 8 * s)
        .stroke({ width: 0.9, color: line, alpha: 0.5 });
      break;
    }
    case 'fist':
      g.circle(0, 8 * s, 8 * s).fill(skin);
      g.moveTo(-6 * s, 6 * s)
        .quadraticCurveTo(-2 * s, 11 * s, 3 * s, 9 * s)
        .stroke({ width: 2.8 * s, color: lighten(skin, 0.04), cap: 'round' });
      for (let k = 0; k < 3; k++)
        g.moveTo(5.5 * s, (5 + k * 3.2) * s)
          .lineTo(7 * s, (5.5 + k * 3.2) * s)
          .stroke({ width: 0.9, color: line, alpha: 0.6 });
      break;
    case 'point':
      g.circle(0, 8 * s, 7.6 * s).fill(skin);
      g.moveTo(2 * s, 12 * s)
        .lineTo(2 * s, 25 * s)
        .stroke({ width: 3.8 * s, color: skin, cap: 'round' });
      g.moveTo(-6 * s, 6 * s)
        .quadraticCurveTo(-2 * s, 11 * s, 2 * s, 10 * s)
        .stroke({ width: 2.6 * s, color: lighten(skin, 0.04), cap: 'round' });
      break;
    case 'grip':
      g.circle(0, 8 * s, 8 * s).fill(skin);
      g.ellipse(1.2 * s, 9 * s, 2.6 * s, 4.6 * s).fill(darken(skin, 0.32));
      g.moveTo(-6 * s, 5 * s)
        .quadraticCurveTo(-4 * s, 10 * s, -1 * s, 12 * s)
        .stroke({ width: 2.6 * s, color: skin, cap: 'round' });
      break;
    case 'flat':
      g.ellipse(0, 10 * s, 5 * s, 12.5 * s).fill(skin);
      g.ellipse(-3.5 * s, 6 * s, 2.5 * s, 4.5 * s).fill(skin);
      g.moveTo(1.5 * s, 4 * s)
        .lineTo(1.5 * s, 19 * s)
        .stroke({ width: 0.9, color: line, alpha: 0.5 });
      break;
  }
}

/** Foot with chappal, origin at the ankle; the sole sits at y = -ankleY. */
export function drawFoot(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const s = Math.sin(theta);
  const b = a.build;
  const ground = -d.ankleY;
  const sole = darken(MELA.wood, 0.25);
  const strap = darken(MELA.wood, 0.1);
  const len = (12 + 9 * s) * b;
  const fwd = 7 * s * b;
  g.ellipse(fwd, ground - 2.5, len, 4.5).fill(sole);
  g.ellipse(fwd * 0.9, ground - 6, len * 0.72, 5.5).fill(a.skin);
  g.roundRect(-5 * b, -3, 10 * b, ground - 4, 4).fill(a.skin);
  if (s > 0.3) {
    g.circle(fwd + len * 0.72, ground - 6, 2.4).fill(lighten(a.skin, 0.05));
  }
  g.moveTo(fwd - len * 0.5, ground - 6)
    .quadraticCurveTo(fwd, ground - 12, fwd + len * 0.5, ground - 6)
    .stroke({ width: 2.4, color: strap });
}

/** Cloth strip texture for rope tails: length along x, thickness along y, border stripes. */
export function drawClothStrip(
  g: Graphics,
  color: number,
  border: number,
  thickness: number,
  length = 64,
): void {
  g.rect(0, -thickness / 2, length, thickness).fill(
    vgrad([
      [0, lighten(color, 0.12)],
      [0.5, color],
      [1, darken(color, 0.22)],
    ]),
  );
  g.rect(
    0,
    thickness / 2 - Math.max(2, thickness * 0.18),
    length,
    Math.max(2, thickness * 0.18),
  ).fill(border);
  g.rect(0, -thickness / 2, length, 1.6).fill(darken(color, 0.45));
  g.rect(0, thickness / 2 - 1.6, length, 1.6).fill(darken(border, 0.4));
}

/** Braid strip texture (alternating plaits). */
export function drawBraidStrip(g: Graphics, hair: number, thickness: number, length = 64): void {
  g.rect(0, -thickness / 2, length, thickness).fill(darken(hair, 0.2));
  for (let x = 0; x < length; x += 10) {
    g.ellipse(x + 5, -thickness * 0.18, 6, thickness * 0.32).fill(hair);
    g.ellipse(x + 10, thickness * 0.18, 6, thickness * 0.32).fill(lighten(hair, 0.08));
  }
}
