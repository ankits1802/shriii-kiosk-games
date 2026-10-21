/**
 * Head art per view yaw (front 0, three-quarter, side profile; the other direction is a mirror):
 *
 * - base layer (baked): back hair, ears, the face shape (skull + jaw, a forward jaw and nose bump in
 *   profile);
 * - front layer (baked): fringe and side hair, back-of-head hair in turned views, headwear.
 *
 * Eyes, brows, nose, mouth, glasses and earrings are drawn live by `drawFeatures` on top of the base.
 * Hair and headwear paths are written for the front view and wrapped around the head sphere.
 */
import type { Graphics } from 'pixi.js';
import { darken, lighten } from '../../color.ts';
import { vgrad } from '../../draw.ts';
import { MELA } from '../../palettes.ts';
import type { Appearance } from '../appearance.ts';
import type { RigDims } from './dims.ts';
import { wrapX } from './kinematics.ts';

/** Head-sphere wrap for hair and headwear (front-view x -> image x at yaw). */
function hx(x: number, theta: number, r = 42): number {
  return wrapX(x, r, r, theta).x;
}

/** Face-surface wrap (flatter than the skull: features sit on the face plane). */
export function faceWrap(x: number, theta: number): { x: number; facing: number } {
  return wrapX(x, 39, 34, theta);
}

/** Point on the head circle at angle phi (0 = front centre) for yaw theta. */
function around(phi: number, theta: number, r: number): { x: number; facing: number } {
  return { x: r * Math.sin(phi + theta), facing: Math.cos(phi + theta) };
}

const GREY_HAIR = 0xd8d4d0;

export function drawHeadBase(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const cy = d.headCY;
  const s = Math.sin(theta);
  const skin = a.skin;
  const hair = a.hair;
  const hairDark = darken(hair, 0.2);

  // Back hair (behind the face).
  switch (a.hairStyle) {
    case 'bun': {
      g.circle(-4 * s, cy - 4, 43).fill(hairDark);
      const bx = -24 * s;
      const by = cy - 46 + 18 * s;
      g.circle(bx, by, 19).fill(hair);
      g.circle(bx - 5, by - 4, 7).fill({ color: lighten(hair, 0.25), alpha: 0.5 });
      break;
    }
    case 'braid':
      g.circle(-4 * s, cy - 4, 43).fill(hairDark);
      break;
    case 'long_open':
      g.roundRect(-46 - 8 * s, cy - 40, 92, 110, 40).fill(hairDark);
      break;
    case 'bob':
      g.roundRect(-47 - 6 * s, cy - 44, 94, 84, 38).fill(hairDark);
      break;
    case 'short':
      g.ellipse(-5 * s, cy - 8, 41, 42).fill(hairDark);
      break;
    case 'bald_sides':
      break;
    case 'covered':
      break;
  }
  if (a.headwear === 'pallu_head') {
    const off = -10 * s;
    g.moveTo(-50 + off, cy + 40)
      .quadraticCurveTo(-56 + off, cy - 50, off + 6 * s, cy - 56)
      .quadraticCurveTo(56 + off, cy - 50, 50 + off * 0.2, cy + 40)
      .lineTo(60 + off * 0.2, cy + 80)
      .lineTo(-60 + off, cy + 80)
      .closePath()
      .fill(darken(a.headwearColor, 0.12));
  }

  // Ears: visible ones; near-side ears in turned views sit on top of the skull.
  const ears: { x: number; facing: number }[] = [-1, 1].map((sx) =>
    around(sx * (Math.PI / 2 + 0.1), theta, 39),
  );
  const drawEar = (x: number, front: boolean): void => {
    g.ellipse(x, cy + 4, front ? 7 : 8, 11).fill(darken(skin, 0.06));
    g.ellipse(x + (front ? -1 : 0), cy + 4, front ? 3.5 : 4, 6).fill(darken(skin, 0.2));
  };
  for (const e of ears) if (e.facing > -0.35 && e.facing <= 0.2) drawEar(e.x, false);

  // Face: skull plus jaw (the jaw slides forward in profile).
  g.ellipse(0, cy - 2, 39, 44).fill(skin);
  g.ellipse(9 * s, cy + 14, 33 - 6 * s, 32 - 2 * s).fill(skin);
  if (s > 0.85) {
    // Profile: nose and chin.
    const fx = 33 + 2 * s;
    g.moveTo(fx - 4, cy - 2)
      .quadraticCurveTo(fx + 2, cy + 4, fx + 8 * s, cy + 15)
      .quadraticCurveTo(fx + 3, cy + 19, fx - 4, cy + 19)
      .closePath()
      .fill(skin);
    g.moveTo(fx + 1, cy + 17)
      .quadraticCurveTo(fx - 2, cy + 18, fx - 3, cy + 15)
      .stroke({
        width: 1.4,
        color: darken(skin, 0.3),
        alpha: 0.7,
      });
    g.ellipse(fx - 6, cy + 40, 10, 7).fill(skin);
  }
  // Soft forehead light and jaw shade.
  g.ellipse(-8 + 12 * s, cy - 22, 20, 12).fill({ color: 0xffffff, alpha: 0.08 });
  g.ellipse(6 * s, cy + 44, 22, 6).fill({ color: darken(skin, 0.3), alpha: 0.18 });
  if (s > 0.2) {
    // Cheekbone plane shadow towards the back of the head.
    g.ellipse(-22 * s, cy + 8, 14, 22).fill({ color: darken(skin, 0.25), alpha: 0.1 * s });
  }
  for (const e of ears) if (e.facing > 0.2) drawEar(e.x, true);
}

export function drawHeadFront(g: Graphics, a: Appearance, d: RigDims, theta: number): void {
  const cy = d.headCY;
  const s = Math.sin(theta);
  const hair = a.hair;
  const parting = a.feminine;
  const X = (x: number): number => hx(x, theta);

  switch (a.hairStyle) {
    case 'bun':
    case 'braid':
    case 'long_open':
    case 'bob':
    case 'short': {
      if (s > 0.85) {
        profileHair(g, a, cy, theta);
        if (a.hairStyle === 'bun') {
          g.circle(-40, cy - 30, 18).fill(hair);
          g.circle(-44, cy - 35, 6).fill({ color: lighten(hair, 0.25), alpha: 0.5 });
        }
        break;
      }
      const low = a.hairStyle === 'bob' ? 18 : 2;
      g.moveTo(X(-41), cy + low)
        .bezierCurveTo(X(-46), cy - 40, X(-20), cy - 52, X(0), cy - 50)
        .bezierCurveTo(X(20), cy - 52, X(46), cy - 40, X(41), cy + low)
        .quadraticCurveTo(X(38), cy - 18, X(parting ? 24 : 30), cy - 26)
        .quadraticCurveTo(
          X(parting ? 10 : 6),
          cy - 34,
          X(parting ? 0 : -18),
          cy - (parting ? 36 : 30),
        )
        .quadraticCurveTo(X(parting ? -10 : -30), cy - 34, X(-26), cy - 26)
        .quadraticCurveTo(X(-38), cy - 18, X(-41), cy + low)
        .closePath()
        .fill(hair);
      g.moveTo(X(-26), cy - 40)
        .quadraticCurveTo(X(-10), cy - 50, X(6), cy - 48)
        .stroke({ width: 3, color: lighten(hair, 0.3), alpha: 0.4 });
      if (parting && a.bindi && wrapX(0, 42, 42, theta).facing > 0.2)
        g.moveTo(X(0), cy - 36)
          .lineTo(X(0), cy - 48)
          .stroke({ width: 2, color: MELA.vermilion, alpha: 0.85 });
      if (s > 0.2) backOfHead(g, a, cy, theta, a.hairStyle === 'bob' ? cy + 30 : cy + 14);
      break;
    }
    case 'bald_sides': {
      const earX = 39 * Math.sin(-(Math.PI / 2 + 0.1) + theta);
      for (const sx of [-1, 1]) {
        if (s > 0.2) continue;
        if (wrapX(sx * 38, 42, 42, theta).facing < -0.2) continue;
        g.moveTo(X(sx * 41), cy + 2)
          .quadraticCurveTo(X(sx * 46), cy - 24, X(sx * 30), cy - 34)
          .quadraticCurveTo(X(sx * 36), cy - 14, X(sx * 36), cy + 4)
          .closePath()
          .fill(hair);
      }
      if (s > 0.2) {
        // Horseshoe of hair around the back of the head, above and behind the near ear.
        g.moveTo(earX + 6, cy - 24)
          .quadraticCurveTo(earX - 8, cy - 32, -38, cy - 22)
          .quadraticCurveTo(-45, cy - 4, -37, cy + 12)
          .quadraticCurveTo(earX - 14, cy + 8, earX - 9, cy - 6)
          .quadraticCurveTo(earX - 3, cy - 15, earX + 6, cy - 24)
          .closePath()
          .fill(hair);
      }
      break;
    }
    default:
      break;
  }

  const hw = a.headwearColor;
  switch (a.headwear) {
    case 'pagri': {
      const fill = vgrad([
        [0, lighten(hw, 0.15)],
        [1, darken(hw, 0.12)],
      ]);
      g.moveTo(-44, cy - 14)
        .bezierCurveTo(-52, cy - 62, 52, cy - 62, 44, cy - 14)
        .quadraticCurveTo(X(0), cy - 30 + 8 * s, -44, cy - 14)
        .fill(fill);
      for (let k = 0; k < 4; k++)
        g.moveTo(X(-42 + k * 4), cy - 18 - k * 9)
          .quadraticCurveTo(X(0), cy - 40 - k * 9, X(42 - k * 4), cy - 18 - k * 9)
          .stroke({ width: 2.2, color: darken(hw, 0.25), alpha: 0.7 });
      g.moveTo(X(-30), cy - 30)
        .quadraticCurveTo(X(0), cy - 66, X(30), cy - 44)
        .stroke({ width: 5, color: lighten(hw, 0.25), alpha: 0.6 });
      if (s < 0.85 && wrapX(40, 42, 42, theta).facing > -0.3)
        g.ellipse(X(46), cy - 10, 7, 16).fill(darken(hw, 0.1));
      if (s > 0.85) g.ellipse(-44, cy - 20, 8, 13).fill(darken(hw, 0.12));
      break;
    }
    case 'turban': {
      g.moveTo(-43, cy - 10)
        .bezierCurveTo(-48, cy - 50, -20, cy - 70, 0, cy - 72)
        .bezierCurveTo(20, cy - 70, 48, cy - 50, 43, cy - 10)
        .quadraticCurveTo(X(0), cy - 26 + 8 * s, -43, cy - 10)
        .fill(
          vgrad([
            [0, lighten(hw, 0.12)],
            [1, darken(hw, 0.15)],
          ]),
        );
      const fx = X(0);
      g.moveTo(X(-38), cy - 16)
        .quadraticCurveTo(X(-6), cy - 40, fx + 10 * (1 - s), cy - 70)
        .stroke({ width: 2.5, color: darken(hw, 0.3), alpha: 0.7 });
      g.moveTo(X(38), cy - 16)
        .quadraticCurveTo(X(6), cy - 40, fx - 10 * (1 - s), cy - 70)
        .stroke({ width: 2.5, color: darken(hw, 0.3), alpha: 0.7 });
      if (s > 0.2)
        for (let k = 0; k < 3; k++)
          g.moveTo(-40, cy - 20 - k * 14)
            .quadraticCurveTo(-10, cy - 34 - k * 14, fx - 4, cy - 30 - k * 12)
            .stroke({ width: 2, color: darken(hw, 0.22), alpha: 0.5 });
      break;
    }
    case 'cap': {
      g.moveTo(-40, cy - 18)
        .bezierCurveTo(-44, cy - 62, 44, cy - 62, 40, cy - 18)
        .closePath()
        .fill(hw);
      g.moveTo(-34, cy - 40)
        .quadraticCurveTo(0, cy - 60, 30, cy - 44)
        .stroke({ width: 3, color: lighten(hw, 0.2), alpha: 0.4 });
      // Peak points forward: wide in front view, a visor in profile.
      const cx = X(0) + 14 * s;
      g.ellipse(cx, cy - 18, 46 - 18 * s, 9 - 2 * s).fill(darken(hw, 0.2));
      g.circle(-6 * s, cy - 56, 3).fill(darken(hw, 0.25));
      break;
    }
    case 'topi':
      g.moveTo(-36, cy - 26)
        .lineTo(-30, cy - 48)
        .quadraticCurveTo(0, cy - 56, 30, cy - 48)
        .lineTo(36, cy - 26)
        .quadraticCurveTo(0, cy - 34, -36, cy - 26)
        .fill(hw);
      g.moveTo(-30, cy - 34)
        .quadraticCurveTo(0, cy - 42, 30, cy - 34)
        .stroke({ width: 1.5, color: darken(hw, 0.15) });
      if (s > 0.6)
        g.moveTo(30, cy - 48)
          .lineTo(36, cy - 26)
          .stroke({ width: 1.2, color: darken(hw, 0.2) });
      break;
    case 'gajra': {
      const bx = a.hairStyle === 'bun' ? (s > 0.85 ? -40 : -24 * s) : 0;
      for (let k = 0; k < 9; k++) {
        const ang = Math.PI + (k / 8) * Math.PI;
        const x = bx + Math.cos(ang) * (21 - 6 * s) - 4 * s;
        const by = a.hairStyle === 'bun' ? (s > 0.85 ? cy - 30 : cy - 46 + 18 * s) : cy - 46;
        const y = by + Math.sin(ang) * 13 + 6;
        g.circle(x, y, 4).fill(hw);
        g.circle(x, y, 1.4).fill(0xf2e8a0);
      }
      break;
    }
    case 'pallu_head':
      if (s > 0.85) {
        // Profile: the saree end covers the crown and back of the head down to the shoulders.
        g.moveTo(30, cy - 34)
          .quadraticCurveTo(18, cy - 58, -10, cy - 56)
          .bezierCurveTo(-46, cy - 54, -54, cy - 20, -54, cy + 34)
          .lineTo(-60, cy + 80)
          .lineTo(-14, cy + 80)
          .quadraticCurveTo(-12, cy + 40, -14, cy + 24)
          .quadraticCurveTo(-22, cy - 6, 4, cy - 30)
          .quadraticCurveTo(16, cy - 38, 30, cy - 34)
          .fill(hw);
        g.moveTo(30, cy - 34)
          .quadraticCurveTo(14, cy - 44, 0, cy - 36)
          .stroke({ width: 3, color: a.upperTrim });
        break;
      }
      g.moveTo(X(-46) - 8 * s, cy + 30)
        .quadraticCurveTo(X(-50) - 8 * s, cy - 46, X(0) - 4 * s, cy - 52)
        .quadraticCurveTo(X(50), cy - 46, X(46), cy + 30)
        .quadraticCurveTo(X(38), cy - 30, X(0), cy - 34)
        .quadraticCurveTo(X(-38), cy - 30, X(-46) - 8 * s, cy + 30)
        .fill(hw);
      g.moveTo(X(-40), cy - 30)
        .quadraticCurveTo(X(0), cy - 44, X(40), cy - 30)
        .stroke({ width: 3, color: a.upperTrim });
      break;
    case 'none':
      break;
  }
  if (a.hair === GREY_HAIR && a.hairStyle !== 'covered' && a.headwear === 'none' && s > 0.2) {
    // Silver sheen on the back of the head.
    g.ellipse(-26 * s, cy - 24, 10, 6).fill({ color: 0xffffff, alpha: 0.25 });
  }
}

/** Hair over the back of the skull in turned views (from the crown down to the nape, behind the ear). */
function backOfHead(g: Graphics, a: Appearance, cy: number, theta: number, nape: number): void {
  const hair = a.hair;
  const s = Math.sin(theta);
  const earX = 39 * Math.sin(-(Math.PI / 2 + 0.1) + theta);
  const back = -41 - 2 * s;
  g.moveTo(12 * s, cy - 47)
    .bezierCurveTo(-28, cy - 54, back - 4, cy - 30, back, Math.min(nape - 6, cy + 16))
    .quadraticCurveTo(back + 4, nape, (back + earX) / 2, nape + 2)
    .quadraticCurveTo(earX - 10, cy + 10, earX - 7, cy - 12)
    .quadraticCurveTo(earX - 2, cy - 30, 12 * s, cy - 38)
    .closePath()
    .fill(hair);
  g.moveTo(back + 10, cy - 38)
    .quadraticCurveTo(back + 2, cy - 20, back + 5, cy)
    .stroke({ width: 2.5, color: lighten(hair, 0.28), alpha: 0.35 });
}

/** Profile hair: a cap from the forehead hairline over the crown to the nape, clear of the ear. */
function profileHair(g: Graphics, a: Appearance, cy: number, theta: number): void {
  const hair = a.hair;
  const earX = 39 * Math.sin(-(Math.PI / 2 + 0.1) + theta);
  const long = a.hairStyle === 'bob' || a.hairStyle === 'long_open';
  const nape = long ? cy + 34 : a.hairStyle === 'short' ? cy + 10 : cy + 16;
  const back = -43;
  g.moveTo(31, cy - 30)
    .quadraticCurveTo(30, cy - 50, 6, cy - 52)
    .bezierCurveTo(-24, cy - 56, back - 2, cy - 36, back, cy - 6)
    .quadraticCurveTo(back + 1, nape - 4, back + 8, nape)
    .quadraticCurveTo((back + earX) / 2, nape + 4, earX - 9, long ? nape - 4 : cy + 8)
    .quadraticCurveTo(earX - 10, cy - 8, earX - 4, cy - 16)
    .quadraticCurveTo(earX + 6, cy - 20, earX + 12, cy - 10)
    .lineTo(earX + 14, cy - 22)
    .quadraticCurveTo(14, cy - 30, 31, cy - 30)
    .closePath()
    .fill(hair);
  g.moveTo(-6, cy - 48)
    .quadraticCurveTo(-30, cy - 46, -38, cy - 22)
    .stroke({ width: 3, color: lighten(hair, 0.3), alpha: 0.35 });
  if (a.feminine) {
    // Hair swept back from the forehead.
    g.moveTo(28, cy - 36)
      .quadraticCurveTo(8, cy - 44, -14, cy - 40)
      .stroke({ width: 1.6, color: darken(hair, 0.3), alpha: 0.6 });
  }
}
