/**
 * Live facial features: eyes (lids, iris, highlights, blink), brows, nose, mouth (expression curve plus
 * viseme shape), cheeks, facial hair, glasses and dangling earrings. Redrawn only when a visible
 * parameter changes. Positions wrap around the face for the head's yaw, so in three-quarter view the far
 * eye narrows and in profile only the near eye shows.
 */
import type { Graphics } from 'pixi.js';
import { clamp, darken } from '../../color.ts';
import { openArc } from '../../draw.ts';
import { MELA } from '../../palettes.ts';
import type { Appearance } from '../appearance.ts';
import type { ExpressionParams } from '../expressions.ts';
import type { RigDims } from './dims.ts';
import { faceWrap } from './drawHead.ts';

export interface FeatureInputs {
  readonly blink: number;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly mouthOpen: number;
  readonly mouthWidth: number;
  readonly mouthRound: number;
  readonly pressed: boolean;
}

const GREY_HAIR = 0xd8d4d0;

export function drawFeatures(
  g: Graphics,
  a: Appearance,
  d: RigDims,
  p: ExpressionParams,
  f: FeatureInputs,
  yaw: number,
  earrings: { readonly l: number; readonly r: number },
): void {
  g.clear();
  const cy = d.headCY;
  const skin = a.skin;
  const ink = 0x2a1a14;
  const browCol = a.hair === GREY_HAIR ? 0x9a928c : darken(a.hair, 0.1);
  const s = Math.sin(yaw);
  const W = (x: number): { x: number; facing: number } => faceWrap(x, yaw);
  const center = W(0);

  if (p.flush > 0.01)
    g.ellipse(center.x * 0.8, cy - 8, 32 - 10 * s, 26).fill({
      color: 0xd83a2a,
      alpha: p.flush * 0.22,
    });
  if (p.blush > 0.01)
    for (const sx of [-1, 1]) {
      const c = W(sx * 24);
      if (c.facing < 0.1) continue;
      g.ellipse(c.x, cy + 14, 8 * c.facing ** 0.6, 5).fill({
        color: 0xf06a6a,
        alpha: p.blush * 0.42,
      });
    }
  if (p.browAngle > 0.25) {
    const n = p.browAngle > 0.45 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const x0 = W(-6 + k * 6 - 3).x;
      const x1 = W(-6 + k * 6 + 3).x;
      g.moveTo(x0, cy - 30 - k)
        .lineTo(x1, cy - 33 - k)
        .stroke({ width: 1.6, color: darken(skin, 0.35), alpha: 0.8 });
    }
  }

  if (a.facialHair === 'beard') {
    const L = W(-36).x;
    const R = W(36).x;
    g.moveTo(L, cy + 4)
      .quadraticCurveTo(L, cy + 52, center.x, cy + 58)
      .quadraticCurveTo(R + 6 * s, cy + 52, R + 4 * s, cy + 4)
      .quadraticCurveTo(W(30).x, cy + 30, center.x, cy + 32)
      .quadraticCurveTo(W(-30).x, cy + 30, L, cy + 4)
      .fill(a.hair);
  } else if (a.facialHair === 'stubble') {
    g.ellipse(center.x, cy + 30, 26 - 6 * s, 16).fill({ color: darken(skin, 0.3), alpha: 0.18 });
  }

  // Eyes.
  const open = p.eyeOpen * (1 - f.blink);
  const eyePos: { x: number; w: number; sx: -1 | 1 }[] = [];
  for (const sx of [-1, 1] as const) {
    const e = W(sx * 15);
    if (e.facing < 0.12) continue;
    const fw = Math.min(1, e.facing) ** 0.7;
    eyePos.push({ x: e.x, w: fw, sx });
    const ex = e.x;
    const ey = cy + 1;
    const ry = 9.5 * Math.max(1, p.eyeOpen);
    const rx = 8.2 * fw;
    if (open < 0.12) {
      const up = p.eyeSmile > 0.5 ? -4 : 1;
      g.moveTo(ex - 8 * fw, ey + 1)
        .quadraticCurveTo(ex, ey + up, ex + 8 * fw, ey + 1)
        .stroke({ width: 2.8, color: ink, cap: 'round' });
      continue;
    }
    g.ellipse(ex, ey, rx, ry).fill(0xffffff);
    const ix = ex + (f.gazeX * 3 + s * 2) * fw;
    const iy = ey + f.gazeY * 3;
    const ir = 6.6;
    g.ellipse(ix, iy, ir * Math.max(0.55, fw), ir).fill(0x4a2c1a);
    g.ellipse(ix, iy, ir * Math.max(0.55, fw), ir).stroke({ width: 1, color: 0x2a160c });
    g.ellipse(ix, iy, 3.3 * p.pupil * Math.max(0.55, fw), 3.3 * p.pupil).fill(0x0e0806);
    g.circle(ix - 2.2 * fw, iy - 2.6, 2.1).fill(0xffffff);
    g.circle(ix + 2 * fw, iy + 2, 0.9).fill(0xffffff);
    const lidBase = ey - ry + (1 - Math.min(open, 1)) * ry * 1.7;
    const slope = sx * -p.browAngle * 0.75;
    const lidAt = (x: number): number => lidBase + slope * (x - ex);
    const hw = 12 * fw + 1;
    g.poly([
      ex - hw,
      ey - ry - 6,
      ex + hw,
      ey - ry - 6,
      ex + hw,
      lidAt(ex + hw),
      ex - hw,
      lidAt(ex - hw),
    ]).fill(skin);
    if (open >= 0.98 && Math.abs(p.browAngle) < 0.05 && fw > 0.9) {
      openArc(g, ex, ey, 8.6, Math.PI * 1.08, Math.PI * 1.92).stroke({
        width: 2.6,
        color: ink,
        cap: 'round',
      });
    } else {
      g.moveTo(ex - 8.5 * fw, lidAt(ex - 8.5 * fw))
        .lineTo(ex + 8.5 * fw, lidAt(ex + 8.5 * fw))
        .stroke({ width: 2.6, color: ink, cap: 'round' });
    }
    if (a.feminine) {
      const outer = s > 0.3 ? -1 : sx;
      g.moveTo(ex + outer * 8 * fw, lidAt(ex + outer * 8 * fw))
        .lineTo(ex + outer * (8 * fw + 3), lidAt(ex + outer * 8 * fw) - 3)
        .stroke({ width: 1.8, color: ink, cap: 'round' });
    }
    if (p.eyeSmile > 0.02)
      g.ellipse(ex, ey + ry * (1.75 - p.eyeSmile * 0.85), hw - 1, 8).fill(skin);
    if (a.age > 0.6) {
      const outer = s > 0.3 ? -1 : sx;
      g.moveTo(ex + outer * 11 * fw, ey + 2)
        .lineTo(ex + outer * (11 * fw + 4), ey + 4)
        .stroke({ width: 1.2, color: darken(skin, 0.3), alpha: 0.7 });
    }
  }

  // Brows.
  for (const sx of [-1, 1] as const) {
    const e = W(sx * 15);
    if (e.facing < 0.12) continue;
    const fw = Math.min(1, e.facing) ** 0.7;
    const lift = p.browLift + (sx === 1 ? p.browAsym : -p.browAsym * 0.3);
    const by = cy - 15 - lift;
    const inner = e.x - sx * 9 * fw;
    const outer = e.x + sx * 10 * fw;
    g.moveTo(outer, by + 1)
      .quadraticCurveTo(e.x, by - 4, inner, by + p.browAngle * 14)
      .stroke({ width: 4.6, color: browCol, cap: 'round' });
  }

  // Nose (profile nose is part of the baked head; here the bridge and nostril line).
  if (s < 0.9) {
    const nx = center.x;
    const tip = nx + 4.5 * s;
    g.moveTo(tip - 3.5 * (1 - s * 0.6), cy + 15)
      .quadraticCurveTo(tip, cy + 19, tip + 3.5, cy + 15)
      .stroke({ width: 2, color: darken(skin, 0.3), cap: 'round' });
    g.moveTo(nx + s * 1.5, cy + 4)
      .quadraticCurveTo(nx - 2 + s * 7, cy + 10, tip - 1.5 + s * 2, cy + 13)
      .stroke({ width: 1.4, color: darken(skin, 0.18 + s * 0.1), alpha: 0.7 });
  }
  if (a.noseRing) {
    const r = W(-5);
    if (r.facing > 0.1) g.circle(r.x + 3 * s, cy + 17, 3).stroke({ width: 1.4, color: MELA.brass });
  }
  if (a.bindi && center.facing > 0.15) g.circle(center.x - 1.5 * s, cy - 21, 2.8).fill(MELA.kumkum);
  if (a.tilak && center.facing > 0.15) {
    g.moveTo(center.x - 1.5 * s, cy - 34)
      .lineTo(center.x - 1.5 * s, cy - 20)
      .stroke({ width: 3, color: MELA.saffron });
    g.circle(center.x - 1.5 * s, cy - 19, 2).fill(MELA.kumkum);
  }

  // Mouth: expression curve plus the speech viseme.
  const my = cy + 27;
  const mw = 11 * p.mouthWidth * f.mouthWidth;
  const L = W(-mw);
  const R = W(mw);
  const C = W(0);
  const ctrlX = 2 * C.x - (L.x + R.x) / 2;
  const o = clamp(p.mouthOpen + f.mouthOpen * (1 - p.mouthOpen * 0.5), 0, 1);
  const sm = p.smile * (1 - f.mouthRound * 0.7);
  const lip = 0x8a3a32;
  const round = f.mouthRound > 0.35 && o > 0.12;
  if (round) {
    const rx = Math.max(3, (R.x - L.x) * 0.42);
    const ry = 3 + o * 9;
    g.ellipse(C.x, my + ry * 0.4, rx, ry).fill(0x5a1a1c);
    g.ellipse(C.x, my + ry * 0.4, rx, ry).stroke({ width: 2.2, color: lip });
  } else if (o > 0.06) {
    const depth = 4 + o * 13;
    g.moveTo(L.x, my - sm * 1.5)
      .quadraticCurveTo(ctrlX, my - 2 - sm * 2 + (sm < 0 ? 3 : 0), R.x, my - sm * 1.5)
      .quadraticCurveTo(ctrlX, my + depth + sm * 4, L.x, my - sm * 1.5)
      .fill(0x5a1a1c);
    if (p.teeth > 0.3 || (f.mouthOpen > 0.2 && f.mouthWidth > 1.1))
      g.moveTo(L.x + (C.x - L.x) * 0.2, my - sm * 1.2)
        .quadraticCurveTo(ctrlX, my + 1, R.x - (R.x - C.x) * 0.2, my - sm * 1.2)
        .lineTo(R.x - (R.x - C.x) * 0.3, my + 2)
        .quadraticCurveTo(ctrlX, my + 4, L.x + (C.x - L.x) * 0.3, my + 2)
        .closePath()
        .fill(0xfaf6f0);
    if (depth > 8 && f.mouthRound < 0.3)
      g.ellipse(C.x, my + depth * 0.72, (R.x - L.x) * 0.2, depth * 0.14).fill(0xc95a54);
    g.moveTo(L.x, my - sm * 1.5)
      .quadraticCurveTo(ctrlX, my + depth + sm * 4, R.x, my - sm * 1.5)
      .stroke({ width: 1.6, color: lip });
  } else {
    g.moveTo(L.x, my - sm * 2)
      .quadraticCurveTo(ctrlX, my + sm * 7, R.x, my - sm * 2)
      .stroke({ width: f.pressed ? 3.6 : 2.8, color: lip, cap: 'round' });
    if (sm > 0.6)
      for (const [pt, sx] of [
        [L, -1],
        [R, 1],
      ] as const) {
        if (pt.facing < 0.15) continue;
        g.moveTo(pt.x + sx * 1, my - sm * 2 - 1)
          .lineTo(pt.x + sx * 3, my - sm * 2 - 3)
          .stroke({ width: 1.6, color: lip, cap: 'round' });
      }
  }
  if (a.age > 0.6)
    for (const sx of [-1, 1]) {
      const c = W(sx * (mw + 6));
      if (c.facing < 0.15) continue;
      g.moveTo(c.x, my - 8)
        .quadraticCurveTo(c.x + sx * 3, my - 2, c.x, my + 4)
        .stroke({ width: 1.3, color: darken(skin, 0.28), alpha: 0.7 });
    }
  if (a.facialHair === 'moustache' || a.facialHair === 'beard') {
    const pts = [-15, -8, 0, 8, 15].map((x) => W(x).x);
    const [x0, x1, x2, x3, x4] = pts as [number, number, number, number, number];
    g.moveTo(x0, my - 3)
      .quadraticCurveTo(x1, my - 11, x2, my - 7)
      .quadraticCurveTo(x3, my - 11, x4, my - 3)
      .quadraticCurveTo(x3, my - 5, x2, my - 4)
      .quadraticCurveTo(x1, my - 5, x0, my - 3)
      .fill(a.hair === GREY_HAIR ? 0xc8c2bc : darken(a.hair, 0.05));
  }

  // Glasses (follow the eyes).
  if (a.glasses && eyePos.length > 0) {
    const frame = 0x3a2a24;
    for (const e of eyePos) {
      g.ellipse(e.x, cy + 1, 11.5 * e.w + 0.5, 11.5).stroke({ width: 2.2, color: frame });
      g.moveTo(e.x - 6 * e.w, cy - 6)
        .lineTo(e.x - 2 * e.w, cy - 8)
        .stroke({ width: 1.6, color: 0xffffff, alpha: 0.6 });
    }
    const first = eyePos[0];
    const second = eyePos[1];
    if (first && second) {
      const midx = (first.x + second.x) / 2;
      g.moveTo(first.x + 11.5 * first.w, cy)
        .quadraticCurveTo(midx, cy - 3, second.x - 11.5 * second.w, cy)
        .stroke({ width: 2, color: frame });
    }
    // Temple arm towards the near ear.
    const near = s > 0.2 ? eyePos[0] : undefined;
    if (near) {
      g.moveTo(near.x - 11.5 * near.w, cy - 1)
        .lineTo(39 * Math.sin(-(Math.PI / 2 + 0.1) + yaw) + 4, cy - 2)
        .stroke({ width: 2, color: frame });
    } else if (s <= 0.2) {
      for (const e of eyePos) {
        const out = e.x + e.sx * 11.5 * e.w;
        g.moveTo(out, cy - 1)
          .lineTo(out + e.sx * 12, cy - 2)
          .stroke({ width: 2, color: frame });
      }
    }
  }

  // Earrings (jhumka) swinging on their pendulums.
  if (a.earrings)
    for (const sx of [-1, 1] as const) {
      const phi = sx * (Math.PI / 2 + 0.1) + yaw;
      const facing = Math.cos(phi);
      if (facing < -0.35) continue;
      const ex = 39 * Math.sin(phi) + (facing > 0.2 ? -1 : 0);
      const ang = sx === -1 ? earrings.l : earrings.r;
      const top = cy + 15;
      const len = a.feminine ? 9 : 4;
      const bx = ex + Math.sin(ang) * len;
      const by = top + Math.cos(ang) * len;
      g.circle(ex, top + 2, 3.2).fill(MELA.brass);
      if (a.feminine) {
        g.moveTo(ex, top + 3)
          .lineTo(bx, by)
          .stroke({ width: 1.2, color: MELA.brass });
        g.moveTo(bx - 4, by + 1)
          .quadraticCurveTo(bx, by - 5, bx + 4, by + 1)
          .lineTo(bx - 4, by + 1)
          .fill(MELA.brassLight);
        g.circle(bx, by + 3, 1.5).fill(MELA.brass);
      }
    }
}
