/**
 * Procedural walk and run cycles.
 *
 * One cycle = two steps. Phase 0 is the left-leg CONTACT pose (left heel strikes in front, right leg
 * trails behind with the toes pushing off); phase 0.25 is the PASSING pose (the right leg swings past
 * the straight left support leg, body at its highest); 0.5 is the right-leg contact and 0.75 the second
 * passing pose. The vertical bob is not keyed: the rig locks the lowest foot to the ground, so the hips
 * drop naturally when the legs are spread (contact/down) and rise on the straight support leg (passing).
 * Arms swing opposite to the legs, the pelvis shifts weight over the support foot and the torso leans
 * into the motion. Running adds a flight phase, a deeper knee drive and bent, pumping arms.
 */
import type { Pose } from './pose.ts';

export type Gait = 'walk' | 'run';

export interface GaitParams {
  /** Cycles per second (two steps per cycle). */
  readonly cadence: number;
  /** Peak hip flexion (stride amplitude). */
  readonly hipAmp: number;
  /** Knee flexion at mid-swing. */
  readonly kneeSwing: number;
  /** Knee flexion just after contact (loading response). */
  readonly kneeLoad: number;
  /** Shoulder swing amplitude. */
  readonly armAmp: number;
  /** Base elbow bend. */
  readonly elbowBase: number;
  /** Extra elbow bend on the forward swing. */
  readonly elbowSwing: number;
  /** Forward torso lean. */
  readonly lean: number;
  /** Lateral weight shift (front/three-quarter views). */
  readonly pelvisShift: number;
  /** Flight height (rig units) for running. */
  readonly flight: number;
}

export const GAITS: Readonly<Record<Gait, GaitParams>> = {
  walk: {
    cadence: 0.95,
    hipAmp: 0.4,
    kneeSwing: 1.05,
    kneeLoad: 0.16,
    armAmp: 0.36,
    elbowBase: 0.28,
    elbowSwing: 0.3,
    lean: 0.035,
    pelvisShift: 3.2,
    flight: 0,
  },
  run: {
    cadence: 1.45,
    hipAmp: 0.66,
    kneeSwing: 1.75,
    kneeLoad: 0.32,
    armAmp: 0.75,
    elbowBase: 1.45,
    elbowSwing: 0.2,
    lean: 0.12,
    pelvisShift: 1.6,
    flight: 9,
  },
};

const TAU = Math.PI * 2;

/** Periodic Gaussian bump centred at `c` (phase units) with width `w`. */
function bump(p: number, c: number, w: number): number {
  let d = Math.abs(p - c) % 1;
  if (d > 0.5) d = 1 - d;
  return Math.exp(-(d * d) / (2 * w * w));
}

/** Leg angles for one leg at its own phase (0 = this leg's contact). */
export function legAt(
  phase: number,
  g: GaitParams,
): { hip: number; knee: number; ankle: number; flex01: number } {
  const p = ((phase % 1) + 1) % 1;
  // Stance (0..0.5 walk, shorter for run) sweeps the thigh back; swing returns it faster.
  const stance = g.flight > 0 ? 0.42 : 0.5;
  let hip: number;
  if (p < stance) {
    const s = p / stance;
    hip = g.hipAmp * Math.cos(Math.PI * s);
  } else {
    const s = (p - stance) / (1 - stance);
    hip = -g.hipAmp * Math.cos(Math.PI * s);
  }
  const kneePeak = stance + (1 - stance) * 0.4;
  const knee =
    0.04 + g.kneeLoad * bump(p, 0.1, 0.06) + g.kneeSwing * bump(p, kneePeak, (1 - stance) * 0.28);
  const ankle =
    0.22 * bump(p, 0, 0.04) -
    0.42 * bump(p, stance - 0.02, 0.05) +
    0.16 * bump(p, kneePeak + 0.12, 0.08);
  return { hip, knee, ankle, flex01: hip / g.hipAmp };
}

/**
 * Write the locomotion channels for `phase` into `out` (legs, arm swing, pelvis, lean, flight).
 * Arm channels are only written when `arms` is true (a gesture such as pushing a cart may own them).
 */
export function locomotionPose(
  out: Pose,
  phase: number,
  gait: Gait,
  weight = 1,
  arms = true,
): Pose {
  const g = GAITS[gait];
  const L = legAt(phase, g);
  const R = legAt(phase + 0.5, g);
  const mix = (cur: number, v: number): number => cur + (v - cur) * weight;
  out.lHip = mix(out.lHip, L.hip);
  out.lKnee = mix(out.lKnee, L.knee);
  out.lAnkle = mix(out.lAnkle, L.ankle);
  out.rHip = mix(out.rHip, R.hip);
  out.rKnee = mix(out.rKnee, R.knee);
  out.rAnkle = mix(out.rAnkle, R.ankle);
  out.lHipAbd = mix(out.lHipAbd, 0.015);
  out.rHipAbd = mix(out.rHipAbd, 0.015);
  if (arms) {
    // Each arm swings with the opposite leg.
    const lSwing = -L.flex01;
    const rSwing = -R.flex01;
    out.lFlex = mix(out.lFlex, g.armAmp * lSwing);
    out.rFlex = mix(out.rFlex, g.armAmp * rSwing);
    out.lAbd = mix(out.lAbd, 0.1);
    out.rAbd = mix(out.rAbd, 0.1);
    out.lTwist = mix(out.lTwist, -0.15);
    out.rTwist = mix(out.rTwist, -0.15);
    out.lElbow = mix(out.lElbow, g.elbowBase + g.elbowSwing * Math.max(0, lSwing));
    out.rElbow = mix(out.rElbow, g.elbowBase + g.elbowSwing * Math.max(0, rSwing));
  }
  const p = ((phase % 1) + 1) % 1;
  out.pelvisShift = mix(out.pelvisShift, g.pelvisShift * Math.sin(TAU * p + Math.PI / 2));
  out.pelvisTilt = mix(out.pelvisTilt, 0.025 * Math.sin(TAU * p + Math.PI / 2));
  out.spine = mix(out.spine, g.lean);
  out.headNod = mix(out.headNod, -g.lean * 0.4 + 0.012 * Math.cos(TAU * 2 * p));
  if (g.flight > 0) {
    // Airborne shortly after each toe-off.
    const air = Math.max(0, Math.sin(TAU * 2 * (p - 0.42)));
    out.rootY = mix(out.rootY, -g.flight * air * air);
  }
  return out;
}

/**
 * Ground speed (rig units per second) that keeps the stance foot planted: the stride measured from the
 * contact pose in side view times two steps per cycle.
 */
export function gaitSpeed(gait: Gait, thighLen: number, shinLen: number): number {
  const g = GAITS[gait];
  const front = legAt(0, g);
  const back = legAt(0.5, g);
  const ankleX = (hip: number, knee: number): number =>
    thighLen * Math.sin(hip) + shinLen * Math.sin(hip - knee);
  const step = ankleX(front.hip, front.knee) - ankleX(back.hip, back.knee);
  return step * 2 * g.cadence;
}
