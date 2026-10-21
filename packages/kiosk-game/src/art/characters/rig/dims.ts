/**
 * Rig proportions derived from an appearance. Units are "rig units": a figure of height factor 1 stands
 * about 330 units tall with its feet at y = 0 (y negative upwards), matching the wave-1 figure so every
 * existing placement (onboarding guide, picture bands, language faces) keeps its framing.
 */
import type { Appearance, LowerGarment } from '../appearance.ts';

export interface RigDims {
  readonly H0: number;
  /** Shoulder half-width. */
  readonly sw: number;
  /** Waist half-width. */
  readonly ww: number;
  /** Hip half-width. */
  readonly hw: number;
  readonly hipY: number;
  readonly waistY: number;
  readonly shoulderY: number;
  readonly neckTop: number;
  readonly headCY: number;
  readonly headRx: number;
  readonly headRy: number;
  /** Shoulder joint (front view, |x|) and height. */
  readonly shoulderX: number;
  readonly shoulderJointY: number;
  readonly hipJointX: number;
  readonly hipJointY: number;
  readonly thigh: number;
  readonly shin: number;
  readonly upperArm: number;
  readonly foreArm: number;
  /** Ankle joint height above the ground (rest). */
  readonly ankleY: number;
  /** Torso depth (front, back) at the chest. */
  readonly chestDepth: number;
  readonly backDepth: number;
  /** Lower garment hides the legs (saree, lehenga, mekhela, mundu). */
  readonly skirt: boolean;
  /** Hem height of the upper garment (kurta length). */
  readonly hemY: number;
  readonly hemHalf: number;
}

export const SKIRTS: ReadonlySet<LowerGarment> = new Set(['sari', 'lehenga', 'mekhela', 'mundu']);

export function rigDims(a: Appearance): RigDims {
  const H0 = 330 * a.height;
  const sw = 37 * a.build;
  const ww = (a.feminine ? 27 : 30) * a.build;
  const hw = (a.feminine ? 35 : 31) * a.build;
  const hipY = -0.46 * H0;
  const waistY = -0.51 * H0;
  const shoulderY = -0.64 * H0 + a.age * 3;
  const neckTop = -0.675 * H0 + a.age * 3;
  const headCY = neckTop - 40;
  const hipJointY = hipY + 8;
  const ankleY = -11;
  const leg = ankleY - hipJointY;
  const armScale = H0 / 330;
  let hemY = waistY + 4;
  let hemHalf = ww * 1.04;
  if (a.upper === 'kurta') {
    hemY = hipY + 46;
    hemHalf = hw * 1.18;
  } else if (a.upper === 'kurta_long' || a.upper === 'kameez') {
    hemY = -72 * (H0 / 330);
    hemHalf = hw * (a.upper === 'kameez' ? 1.38 : 1.25);
  } else if (a.upper === 'shirt' || a.upper === 'vest_shirt') {
    hemY = hipY + 14;
    hemHalf = hw * 1.06;
  }
  return {
    H0,
    sw,
    ww,
    hw,
    hipY,
    waistY,
    shoulderY,
    neckTop,
    headCY,
    headRx: 39,
    headRy: 44,
    shoulderX: sw - 4,
    shoulderJointY: shoulderY + 7,
    hipJointX: 12.5 * a.build,
    hipJointY,
    thigh: leg * 0.51,
    shin: leg * 0.49,
    upperArm: 50 * armScale,
    foreArm: 45 * armScale,
    ankleY,
    chestDepth: sw * (a.feminine ? 0.92 : 0.86) * (0.9 + a.build * 0.1),
    backDepth: sw * 0.64,
    skirt: SKIRTS.has(a.lower),
    hemY,
    hemHalf,
  };
}

/** Torso cross-section at height `y` (half-width, front depth, back depth). */
export function torsoSection(d: RigDims, y: number): { w: number; df: number; db: number } {
  const rows: (readonly [number, number, number, number])[] = [
    [d.shoulderY - 7, d.sw - 13, d.chestDepth * 0.55, d.backDepth * 0.7],
    [d.shoulderY + 6, d.sw + 1, d.chestDepth * 0.85, d.backDepth],
    [d.shoulderY + 30, d.sw * 0.98, d.chestDepth, d.backDepth * 0.95],
    [d.waistY - 12, d.ww * 1.04, d.chestDepth * 0.82, d.backDepth * 0.82],
  ];
  if (d.hemY > d.hipY + 2) {
    rows.push([d.hipY, d.hw, d.chestDepth * 0.8, d.backDepth * 0.95]);
    rows.push([d.hemY, d.hemHalf, d.chestDepth * 0.85, d.backDepth]);
  } else {
    rows.push([Math.max(d.hemY, d.waistY - 11), d.hemHalf, d.chestDepth * 0.8, d.backDepth * 0.85]);
  }
  const first = rows[0];
  if (!first || y <= first[0])
    return { w: first?.[1] ?? 10, df: first?.[2] ?? 8, db: first?.[3] ?? 8 };
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (!a || !b) continue;
    if (y <= b[0]) {
      const u = (y - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const e = u * u * (3 - 2 * u);
      return {
        w: a[1] + (b[1] - a[1]) * e,
        df: a[2] + (b[2] - a[2]) * e,
        db: a[3] + (b[3] - a[3]) * e,
      };
    }
  }
  const last = rows[rows.length - 1];
  return { w: last?.[1] ?? 10, df: last?.[2] ?? 8, db: last?.[3] ?? 8 };
}
