/**
 * Pose model of the articulated character rig.
 *
 * A pose is a flat record of joint channels in anatomical terms (radians unless noted), so poses can
 * be blended channel by channel and projected into any view (front, three-quarter, side) by the
 * kinematics module. Arm and leg channels are named by body side in the FRONT view: `l` is the limb on
 * the viewer's left (side -1) and `r` the limb on the viewer's right (side +1).
 *
 * Arm channels: `Abd` raises the arm out to the side (0 = hanging, pi/2 = horizontal), `Flex` swings it
 * forward (towards the facing direction), `Twist` rotates the elbow bend plane about the upper arm
 * (negative bends the forearm towards the body centre), `Elbow` bends the forearm (0 = straight) and
 * `Wrist` tilts the hand in the image plane. Leg channels: `Hip` swings the thigh forward, `HipAbd`
 * spreads it, `Knee` bends the shin backwards and `Ankle` lifts the toes (+) or points them (-).
 */

export const POSE_KEYS = [
  'rootX',
  'rootY',
  'lean',
  'pelvisShift',
  'pelvisTilt',
  'spine',
  'shoulderLift',
  'headTilt',
  'headNod',
  'headTurn',
  'squash',
  'lAbd',
  'lFlex',
  'lTwist',
  'lElbow',
  'lWrist',
  'rAbd',
  'rFlex',
  'rTwist',
  'rElbow',
  'rWrist',
  'lHip',
  'lHipAbd',
  'lKnee',
  'lAnkle',
  'rHip',
  'rHipAbd',
  'rKnee',
  'rAnkle',
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;
export type PartialPose = Partial<Pose>;

export type ArmPart = 'Abd' | 'Flex' | 'Twist' | 'Elbow' | 'Wrist';
export type LegPart = 'Hip' | 'HipAbd' | 'Knee' | 'Ankle';
export type LimbSide = 'l' | 'r';

export const ARM_PARTS: readonly ArmPart[] = ['Abd', 'Flex', 'Twist', 'Elbow', 'Wrist'];
export const LEG_PARTS: readonly LegPart[] = ['Hip', 'HipAbd', 'Knee', 'Ankle'];

/** Hand shapes (baked per character). */
export type HandShape = 'relaxed' | 'open' | 'fist' | 'point' | 'grip' | 'flat';

/** Angles of one arm. */
export interface ArmAngles {
  abd: number;
  flex: number;
  twist: number;
  elbow: number;
  wrist: number;
}

/** Angles of one leg. */
export interface LegAngles {
  hip: number;
  hipAbd: number;
  knee: number;
  ankle: number;
}

/** Neutral standing pose: arms hang with a soft elbow, legs straight. */
export const STAND: Readonly<Pose> = Object.freeze({
  rootX: 0,
  rootY: 0,
  lean: 0,
  pelvisShift: 0,
  pelvisTilt: 0,
  spine: 0,
  shoulderLift: 0,
  headTilt: 0,
  headNod: 0,
  headTurn: 0,
  squash: 0,
  lAbd: 0.13,
  lFlex: 0.04,
  lTwist: -0.25,
  lElbow: 0.22,
  lWrist: 0,
  rAbd: 0.13,
  rFlex: 0.04,
  rTwist: -0.25,
  rElbow: 0.22,
  rWrist: 0,
  lHip: 0,
  lHipAbd: 0.02,
  lKnee: 0.02,
  lAnkle: 0,
  rHip: 0,
  rHipAbd: 0.02,
  rKnee: 0.02,
  rAnkle: 0,
});

/** A fresh mutable copy of a pose (defaults to {@link STAND}). */
export function createPose(from: Readonly<Pose> = STAND): Pose {
  return { ...from };
}

/** Copy `src` into `out`. */
export function copyPose(out: Pose, src: Readonly<Pose>): Pose {
  for (const k of POSE_KEYS) out[k] = src[k];
  return out;
}

/** Overwrite the channels present in `partial`. */
export function applyPartial(out: Pose, partial: Readonly<PartialPose>): Pose {
  for (const k of POSE_KEYS) {
    const v = partial[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** `out = a + (b - a) * t` for every channel. */
export function lerpPose(out: Pose, a: Readonly<Pose>, b: Readonly<Pose>, t: number): Pose {
  for (const k of POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

/** Blend only the channels present in `partial` towards it by weight `t`. */
export function blendPartial(out: Pose, partial: Readonly<PartialPose>, t: number): Pose {
  for (const k of POSE_KEYS) {
    const v = partial[k];
    if (v !== undefined) out[k] += (v - out[k]) * t;
  }
  return out;
}

/** Read one arm's angles. */
export function armOf(p: Readonly<Pose>, side: LimbSide): ArmAngles {
  return side === 'l'
    ? { abd: p.lAbd, flex: p.lFlex, twist: p.lTwist, elbow: p.lElbow, wrist: p.lWrist }
    : { abd: p.rAbd, flex: p.rFlex, twist: p.rTwist, elbow: p.rElbow, wrist: p.rWrist };
}

/** Write one arm's angles. */
export function setArm(p: Pose, side: LimbSide, a: Readonly<ArmAngles>): void {
  if (side === 'l') {
    p.lAbd = a.abd;
    p.lFlex = a.flex;
    p.lTwist = a.twist;
    p.lElbow = a.elbow;
    p.lWrist = a.wrist;
  } else {
    p.rAbd = a.abd;
    p.rFlex = a.flex;
    p.rTwist = a.twist;
    p.rElbow = a.elbow;
    p.rWrist = a.wrist;
  }
}

/** Read one leg's angles. */
export function legOf(p: Readonly<Pose>, side: LimbSide): LegAngles {
  return side === 'l'
    ? { hip: p.lHip, hipAbd: p.lHipAbd, knee: p.lKnee, ankle: p.lAnkle }
    : { hip: p.rHip, hipAbd: p.rHipAbd, knee: p.rKnee, ankle: p.rAnkle };
}

/** Pose channel of `part` on limb `side` (e.g. `('r', 'Abd')` -> `'rAbd'`). */
export function limbKey(side: LimbSide, part: ArmPart | LegPart): PoseKey {
  return `${side}${part}` as PoseKey;
}

/** Shortest signed difference between two angles. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Expression postures (body language that accompanies a facial expression, a non-colour cue). Arms are
 * symmetric unless a `main`/`off` split matters (thinking: chin hand + supporting arm; fist: one fist
 * raised, the other on the hip). Postures are applied in front-view terms with `r` as the main arm.
 */
export type Posture = 'relaxed' | 'hips' | 'crossed' | 'chin' | 'open' | 'fist';

const HIPS_ARM: ArmAngles = { abd: 0.95, flex: -0.12, twist: -1.45, elbow: 1.95, wrist: 0.25 };

export const POSTURES: Readonly<Record<Posture, PartialPose>> = {
  relaxed: {},
  hips: armsPartial(HIPS_ARM, HIPS_ARM),
  crossed: armsPartial(
    { abd: 0.18, flex: 0.42, twist: -1.5, elbow: 1.82, wrist: 0 },
    { abd: 0.16, flex: 0.36, twist: -1.48, elbow: 1.62, wrist: 0 },
  ),
  chin: {
    ...armsPartial(
      { abd: 0.15, flex: 0.9, twist: -0.9, elbow: 2.35, wrist: 0.5 },
      { abd: 0.12, flex: 0.38, twist: -1.5, elbow: 1.7, wrist: 0 },
    ),
    headTilt: -0.05,
  },
  open: armsPartial(
    { abd: 0.62, flex: 0.32, twist: 0.25, elbow: 0.55, wrist: 0.15 },
    { abd: 0.62, flex: 0.32, twist: 0.25, elbow: 0.55, wrist: 0.15 },
  ),
  fist: armsPartial({ abd: 1.05, flex: 0.25, twist: 1.35, elbow: 2.0, wrist: 0 }, HIPS_ARM),
};

/** Hand shapes per posture (`main`, `off`). */
export const POSTURE_HANDS: Readonly<Record<Posture, readonly [HandShape, HandShape]>> = {
  relaxed: ['relaxed', 'relaxed'],
  hips: ['fist', 'fist'],
  crossed: ['fist', 'fist'],
  chin: ['fist', 'fist'],
  open: ['open', 'open'],
  fist: ['fist', 'fist'],
};

function armsPartial(main: ArmAngles, off: ArmAngles): PartialPose {
  return {
    rAbd: main.abd,
    rFlex: main.flex,
    rTwist: main.twist,
    rElbow: main.elbow,
    rWrist: main.wrist,
    lAbd: off.abd,
    lFlex: off.flex,
    lTwist: off.twist,
    lElbow: off.elbow,
    lWrist: off.wrist,
  };
}
