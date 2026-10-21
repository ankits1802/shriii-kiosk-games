/**
 * Forward kinematics and view projection for the character rig.
 *
 * Body space: x to the viewer's right in the front view, y down, z towards the viewer. A view is a
 * rotation of the body about the vertical axis by yaw `theta` (0 = front, pi/2 = side profile facing
 * screen-right; facing left is a mirror applied by the character's container). Points project
 * orthographically: `x_img = x cos(theta) + z sin(theta)`, `y_img = y`, and their depth towards the
 * viewer is `z cos(theta) - x sin(theta)` (used for draw order: far limbs go behind the body).
 *
 * Limb segments are drawn pointing down from their joint; a segment's image rotation and foreshortened
 * length follow from its 3-D direction ({@link segmentOf}).
 */
import type { ArmAngles, LegAngles } from './pose.ts';

export type RigView = 'front' | 'three_quarter' | 'side';
export type Side = -1 | 1;

export const RIG_VIEWS: readonly RigView[] = ['front', 'three_quarter', 'side'];

/** Body yaw of each view (radians). */
export const VIEW_YAW: Readonly<Record<RigView, number>> = {
  front: 0,
  three_quarter: 0.62,
  side: Math.PI / 2,
};

/** Nearest discrete view for a yaw magnitude. */
export function viewForYaw(yaw: number): RigView {
  const a = Math.abs(yaw);
  if (a < 0.31) return 'front';
  if (a < 1.1) return 'three_quarter';
  return 'side';
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A projected limb segment: image rotation (Pixi convention, a down-pointing segment) and length factor. */
export interface Segment {
  /** Rotation to apply to a segment drawn from (0,0) down to (0,L). */
  rotation: number;
  /** Projected length / true length (0..1). */
  scale: number;
  /** Image-space unit-length end offset (multiply by segment length). */
  dx: number;
  dy: number;
  /** Depth of the direction towards the viewer (+ = towards). */
  depth: number;
}

/** Upper-arm (or thigh) direction from abduction and flexion. */
export function limbDirection(side: Side, abd: number, flex: number): Vec3 {
  const ca = Math.cos(abd);
  return { x: side * Math.sin(abd), y: ca * Math.cos(flex), z: ca * Math.sin(flex) };
}

/**
 * Rotate a vector given in the upper-limb frame (local y along the upper limb, local z forward,
 * local x outward for side +1) into body space. Frame = Rx(flex) * Rz(-side*abd).
 */
export function toBodyFrame(side: Side, abd: number, flex: number, v: Vec3): Vec3 {
  const phi = -side * abd;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const x1 = v.x * cp - v.y * sp;
  const y1 = v.x * sp + v.y * cp;
  const z1 = v.z;
  const cf = Math.cos(flex);
  const sf = Math.sin(flex);
  return { x: x1, y: y1 * cf - z1 * sf, z: y1 * sf + z1 * cf };
}

/** Inverse of {@link toBodyFrame}. */
export function fromBodyFrame(side: Side, abd: number, flex: number, v: Vec3): Vec3 {
  const cf = Math.cos(flex);
  const sf = Math.sin(flex);
  const y1 = v.y * cf + v.z * sf;
  const z1 = -v.y * sf + v.z * cf;
  const phi = -side * abd;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  return { x: v.x * cp + y1 * sp, y: -v.x * sp + y1 * cp, z: z1 };
}

/** Forearm direction in body space. Elbow flexes forward; twist rotates the bend towards outward (+). */
export function forearmDirection(side: Side, a: Readonly<ArmAngles>): Vec3 {
  const se = Math.sin(a.elbow);
  const local: Vec3 = {
    x: side * se * Math.sin(a.twist),
    y: Math.cos(a.elbow),
    z: se * Math.cos(a.twist),
  };
  return toBodyFrame(side, a.abd, a.flex, local);
}

/** Shin direction in body space (the knee bends the shin backwards). */
export function shinDirection(side: Side, l: Readonly<LegAngles>): Vec3 {
  const local: Vec3 = { x: 0, y: Math.cos(l.knee), z: -Math.sin(l.knee) };
  return toBodyFrame(side, l.hipAbd, l.hip, local);
}

/** Project a body-space direction into the image for yaw `theta`. */
export function segmentOf(dir: Readonly<Vec3>, theta: number): Segment {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = dir.x * c + dir.z * s;
  const dy = dir.y;
  const len = Math.hypot(dx, dy);
  return {
    rotation: Math.atan2(-dx, dy),
    scale: Math.min(1, len),
    dx,
    dy,
    depth: dir.z * c - dir.x * s,
  };
}

/** Project a body-space point (x, z) horizontally for yaw `theta`: returns image x and depth. */
export function projectPoint(x: number, z: number, theta: number): { x: number; depth: number } {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: x * c + z * s, depth: z * c - x * s };
}

/** Image-space chain of a whole arm (joint offsets relative to the shoulder, in rig units). */
export interface ArmChain {
  readonly upper: Segment;
  readonly fore: Segment;
  readonly elbow: { x: number; y: number };
  readonly wrist: { x: number; y: number };
  /** Depth of the hand (relative to the shoulder) towards the viewer. */
  readonly handDepth: number;
}

/** Solve an arm chain. */
export function solveArm(
  side: Side,
  a: Readonly<ArmAngles>,
  theta: number,
  upperLen: number,
  foreLen: number,
): ArmChain {
  const u = limbDirection(side, a.abd, a.flex);
  const f = forearmDirection(side, a);
  const upper = segmentOf(u, theta);
  const fore = segmentOf(f, theta);
  const elbow = { x: upper.dx * upperLen, y: upper.dy * upperLen };
  const wrist = { x: elbow.x + fore.dx * foreLen, y: elbow.y + fore.dy * foreLen };
  return { upper, fore, elbow, wrist, handDepth: upper.depth * upperLen + fore.depth * foreLen };
}

/** Image-space chain of a leg (offsets relative to the hip joint). */
export interface LegChain {
  readonly thigh: Segment;
  readonly shin: Segment;
  readonly knee: { x: number; y: number };
  readonly ankle: { x: number; y: number };
}

/** Solve a leg chain. */
export function solveLeg(
  side: Side,
  l: Readonly<LegAngles>,
  theta: number,
  thighLen: number,
  shinLen: number,
): LegChain {
  const t = segmentOf(limbDirection(side, l.hipAbd, l.hip), theta);
  const s = segmentOf(shinDirection(side, l), theta);
  const knee = { x: t.dx * thighLen, y: t.dy * thighLen };
  return {
    thigh: t,
    shin: s,
    knee,
    ankle: { x: knee.x + s.dx * shinLen, y: knee.y + s.dy * shinLen },
  };
}

/** Clamp to [-1, 1]. */
function unit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Find a unit body-space direction whose projection at yaw `theta` matches the image direction
 * (dx, dy) of a front-view direction. The free depth is chosen to point forward/outward (natural).
 */
function directionForImage(dx: number, dy: number, side: Side, theta: number): Vec3 {
  const y = unit(dy);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  if (r < 1e-6) return { x: 0, y, z: 0 };
  const base = Math.acos(unit(dx / r));
  let best: Vec3 = { x: 0, y, z: 0 };
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const sign of [-1, 1]) {
    const beta = theta + sign * base;
    const x = r * Math.cos(beta);
    const z = r * Math.sin(beta);
    const score = z + side * x * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y, z };
    }
  }
  return best;
}

/**
 * Retarget arm angles authored for the main arm in the front view (side +1, yaw 0) to another view and
 * arm so that the arm reads the same on screen (a wave or point keeps pointing screen-right, i.e. the
 * facing direction, instead of foreshortening towards the viewer).
 */
export function retargetArm(src: Readonly<ArmAngles>, targetSide: Side, theta: number): ArmAngles {
  const uSrc = limbDirection(1, src.abd, src.flex);
  const fSrc = forearmDirection(1, src);
  const u = directionForImage(uSrc.x, uSrc.y, targetSide, theta);
  const f = directionForImage(fSrc.x, fSrc.y, targetSide, theta);
  const abd = Math.asin(unit(targetSide * u.x));
  const ca = Math.cos(abd);
  const flex = ca > 1e-4 ? Math.atan2(u.z, u.y) : src.flex;
  const local = fromBodyFrame(targetSide, abd, flex, f);
  const elbow = Math.acos(unit(local.y));
  const twist = Math.sin(elbow) > 1e-4 ? Math.atan2(targetSide * local.x, local.z) : src.twist;
  return { abd, flex, twist, elbow, wrist: src.wrist };
}

/**
 * Horizontal "wrap" projection for features on a rounded surface (head or torso). A feature at front-view
 * offset `x` on an ellipse of half-width `w` and depth `d` sits at angle phi = asin(x / w); at yaw
 * `theta` it projects to `w sin(phi) cos(theta) + d cos(phi) sin(theta)` and faces the viewer with
 * `cos(phi + theta)`. Points that have turned away are clamped to the silhouette edge (phi <= pi/2 -
 * theta) so drawn bands wrap around the edge instead of showing through the body.
 */
export function wrapX(
  x: number,
  w: number,
  d: number,
  theta: number,
): { x: number; facing: number } {
  const raw = Math.asin(unit(x / w));
  const phi = Math.min(raw, Math.PI / 2 - theta);
  return {
    x: w * Math.sin(phi) * Math.cos(theta) + d * Math.cos(phi) * Math.sin(theta),
    facing: Math.cos(raw + theta),
  };
}

/** Silhouette extents of an elliptical cross-section (half-width `w`, front depth `df`, back depth `db`). */
export function sectionExtent(
  w: number,
  df: number,
  db: number,
  theta: number,
): { left: number; right: number } {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    right: Math.sqrt(w * w * c * c + df * df * s * s),
    left: -Math.sqrt(w * w * c * c + db * db * s * s),
  };
}
