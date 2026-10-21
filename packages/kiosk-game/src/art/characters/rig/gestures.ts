/**
 * Gesture library: keyframed partial poses on the rig channels.
 *
 * Keys name arm and leg channels by role rather than side: `m` = the MAIN limb (screen-right arm in the
 * front view, the near arm in three-quarter and side views, or the hand the caller asks for) and `o` =
 * the other limb. Body channels (spine, head...) are used as is. A gesture starts from the current base
 * pose (an implicit key at t = 0), interpolates each channel through the keys that mention it, holds the
 * last value and blends back out after `duration`. `hold` gestures (fold arms, carry on head, push cart,
 * steer, hold lantern, foot tap) loop the `[loop.from, loop.to]` window until they are stopped.
 *
 * `retarget` gestures were authored "towards screen-right" for the front view and are re-solved per view
 * so a wave, point or hand-over reads the same in profile (see `retargetArm`).
 */
import type { ExtendedExpression } from '../expressions.ts';
import {
  type ArmPart,
  angleDelta,
  type HandShape,
  type LegPart,
  type LimbSide,
  limbKey,
  type Pose,
  type PoseKey,
} from './pose.ts';

export type GestureName =
  | 'wave'
  | 'point'
  | 'beckon'
  | 'hand_over'
  | 'receive'
  | 'place_on_scale'
  | 'shrug'
  | 'fold_arms'
  | 'foot_tap'
  | 'clap'
  | 'namaste'
  | 'carry_on_head'
  | 'push_cart'
  | 'steer_cart'
  | 'hold_lantern'
  | 'nod'
  | 'celebrate'
  | 'head_shake';

export const GESTURE_NAMES: readonly GestureName[] = [
  'wave',
  'point',
  'beckon',
  'hand_over',
  'receive',
  'place_on_scale',
  'shrug',
  'fold_arms',
  'foot_tap',
  'clap',
  'namaste',
  'carry_on_head',
  'push_cart',
  'steer_cart',
  'hold_lantern',
  'nod',
  'celebrate',
  'head_shake',
];

type BodyKey =
  | 'rootX'
  | 'rootY'
  | 'lean'
  | 'pelvisShift'
  | 'pelvisTilt'
  | 'spine'
  | 'shoulderLift'
  | 'headTilt'
  | 'headNod'
  | 'headTurn'
  | 'squash';

/** Channel names usable in gesture keys. */
export type GestureChannel = BodyKey | `${'m' | 'o'}${ArmPart}` | `${'m' | 'o'}${LegPart}`;

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'back' | 'snap';

export interface GestureKey {
  /** Seconds from the gesture start. */
  readonly t: number;
  readonly pose: Readonly<Partial<Record<GestureChannel, number>>>;
  /** Easing of the segment arriving at this key (default `inOut`). */
  readonly ease?: Ease;
  /** Hand shapes from this key on. */
  readonly hands?: { readonly m?: HandShape; readonly o?: HandShape };
}

export interface GestureDef {
  readonly name: GestureName;
  /** End of the keyed motion (s); the blend-out follows. */
  readonly duration: number;
  readonly blendOut: number;
  readonly keys: readonly GestureKey[];
  /** Hold gestures loop this window until stopped. */
  readonly loop?: { readonly from: number; readonly to: number };
  /** Retarget the main arm per view (screen-directed gestures). */
  readonly retarget?: boolean;
  /**
   * Additive angle deltas applied in profile (before any retargeting), where the big cartoon head would
   * otherwise sit in the way of a raised hand (a wave is pushed forward, raised arms go slightly back).
   */
  readonly profile?: Readonly<Partial<Record<GestureChannel, number>>>;
  /** Feet stay planted (default true). Seated poses release the ground lock. */
  readonly grounded?: boolean;
  /** Named moments (e.g. `give` when a hand-over item should change hands). */
  readonly events?: readonly { readonly t: number; readonly name: string }[];
  /** Expression the face takes during the gesture (transient). */
  readonly expression?: ExtendedExpression;
  /** Symbol flash. */
  readonly sparkle?: boolean;
  /** The gesture holds an item in the main hand (hand-over, place on scale, lantern...). */
  readonly holdsItem?: boolean;
}

const k = (
  t: number,
  pose: GestureKey['pose'],
  ease?: Ease,
  hands?: GestureKey['hands'],
): GestureKey => ({
  t,
  pose,
  ...(ease ? { ease } : {}),
  ...(hands ? { hands } : {}),
});

/** Arm helper: five main-arm channels. */
function m(abd: number, flex: number, twist: number, elbow: number, wrist = 0): GestureKey['pose'] {
  return { mAbd: abd, mFlex: flex, mTwist: twist, mElbow: elbow, mWrist: wrist };
}
function o(abd: number, flex: number, twist: number, elbow: number, wrist = 0): GestureKey['pose'] {
  return { oAbd: abd, oFlex: flex, oTwist: twist, oElbow: elbow, oWrist: wrist };
}
function both(
  abd: number,
  flex: number,
  twist: number,
  elbow: number,
  wrist = 0,
): GestureKey['pose'] {
  return { ...m(abd, flex, twist, elbow, wrist), ...o(abd, flex, twist, elbow, wrist) };
}

const WAVE_UP = m(1.95, 0.12, 1.57, 0.75, 0.1);

export const GESTURES: Readonly<Record<GestureName, GestureDef>> = {
  wave: {
    name: 'wave',
    duration: 1.55,
    blendOut: 0.35,
    retarget: true,
    profile: { mAbd: -0.45, mElbow: -0.25 },
    expression: 'pleased',
    keys: [
      k(0.28, { ...WAVE_UP, headTilt: 0.08 }, 'back', { m: 'open' }),
      k(0.45, { mElbow: 0.45, mWrist: -0.2 }),
      k(0.62, { mElbow: 1.0, mWrist: 0.25 }),
      k(0.79, { mElbow: 0.45, mWrist: -0.2 }),
      k(0.96, { mElbow: 1.0, mWrist: 0.25 }),
      k(1.13, { mElbow: 0.45, mWrist: -0.2 }),
      k(1.3, { mElbow: 0.75, mWrist: 0.1, headTilt: 0.06 }),
      k(1.55, { headTilt: 0 }),
    ],
  },
  point: {
    name: 'point',
    duration: 1.6,
    blendOut: 0.35,
    retarget: true,
    keys: [
      k(0.3, { ...m(1.42, 0.22, 0, 0.08, 0), lean: 0.02, headTurn: 0.18 }, 'back', {
        m: 'point',
      }),
      k(0.55, { mAbd: 1.36 }),
      k(0.8, { mAbd: 1.44 }),
      k(1.05, { mAbd: 1.37 }),
      k(1.3, { mAbd: 1.42 }),
      k(1.6, { lean: 0, headTurn: 0 }),
    ],
  },
  beckon: {
    name: 'beckon',
    duration: 1.7,
    blendOut: 0.35,
    retarget: true,
    profile: { mAbd: 0.25, mElbow: -0.2 },
    expression: 'pleased',
    keys: [
      k(0.3, { ...m(0.85, 0.5, 1.05, 0.6, 0.3), headTilt: 0.06 }, 'out', { m: 'open' }),
      k(0.52, { mElbow: 1.3, mWrist: 0.75 }),
      k(0.74, { mElbow: 0.6, mWrist: 0.2 }),
      k(0.96, { mElbow: 1.3, mWrist: 0.75 }),
      k(1.18, { mElbow: 0.6, mWrist: 0.2 }),
      k(1.4, { mElbow: 1.3, mWrist: 0.75 }),
      k(1.7, { headTilt: 0 }),
    ],
  },
  hand_over: {
    name: 'hand_over',
    duration: 1.5,
    blendOut: 0.4,
    retarget: true,
    holdsItem: true,
    events: [{ t: 0.75, name: 'give' }],
    keys: [
      k(0.2, { ...m(0.55, 0.5, -0.4, 1.25, 0), spine: 0.02 }, 'inOut', { m: 'grip' }),
      k(0.6, { ...m(1.2, 0.42, -0.15, 0.32, 0.1), spine: 0.08, lean: 0.03 }, 'out'),
      k(0.95, { ...m(1.22, 0.42, -0.15, 0.3, 0.12) }, 'linear', { m: 'open' }),
      k(1.5, { ...m(0.3, 0.2, -0.3, 0.6, 0), spine: 0, lean: 0 }),
    ],
  },
  receive: {
    name: 'receive',
    duration: 1.6,
    blendOut: 0.4,
    retarget: true,
    holdsItem: true,
    events: [{ t: 0.7, name: 'take' }],
    keys: [
      k(
        0.5,
        { ...m(1.12, 0.45, 0.3, 0.42, -0.2), ...o(0.25, 0.85, -0.7, 0.85), spine: 0.07 },
        'out',
        { m: 'open', o: 'open' },
      ),
      k(0.75, { mElbow: 0.5 }, 'inOut', { m: 'grip' }),
      k(1.3, { ...m(0.45, 0.55, -1.0, 1.55, 0), ...o(0.15, 0.5, -1.2, 1.4), spine: 0 }),
      k(1.6, { ...m(0.35, 0.35, -0.9, 1.3, 0) }),
    ],
  },
  place_on_scale: {
    name: 'place_on_scale',
    duration: 1.7,
    blendOut: 0.45,
    retarget: true,
    holdsItem: true,
    events: [{ t: 0.85, name: 'place' }],
    keys: [
      k(0.3, { ...m(0.7, 0.7, -0.6, 1.35, 0), spine: 0.05 }, 'inOut', { m: 'grip' }),
      k(0.75, { ...m(1.05, 0.62, -0.3, 0.55, -0.35), spine: 0.22, lean: 0.05, headNod: 0.18 }),
      k(0.9, { mAbd: 1.0, mWrist: -0.5 }, 'linear', { m: 'open' }),
      k(1.35, { ...m(0.45, 0.3, -0.3, 0.7, 0), spine: 0.04, lean: 0, headNod: 0.05 }),
      k(1.7, { spine: 0, headNod: 0 }),
    ],
  },
  shrug: {
    name: 'shrug',
    duration: 1.25,
    blendOut: 0.35,
    expression: 'thinking',
    keys: [
      k(0.25, { ...both(0.42, 0.42, 0.75, 1.45, 0.3), shoulderLift: 7, headTilt: -0.14 }, 'back', {
        m: 'open',
        o: 'open',
      }),
      k(0.85, { shoulderLift: 6, headTilt: -0.12 }),
      k(1.25, { ...both(0.2, 0.15, 0, 0.4), shoulderLift: 0, headTilt: 0 }),
    ],
  },
  fold_arms: {
    name: 'fold_arms',
    duration: 1.4,
    blendOut: 0.4,
    loop: { from: 0.6, to: 1.4 },
    keys: [
      k(
        0.45,
        {
          ...m(0.18, 0.42, -1.5, 1.82),
          ...o(0.16, 0.36, -1.48, 1.62),
          headTilt: -0.03,
        },
        'inOut',
        { m: 'fist', o: 'fist' },
      ),
      k(1.0, { headTilt: -0.05, shoulderLift: 1.5 }),
      k(1.4, { headTilt: -0.03, shoulderLift: 0 }),
    ],
  },
  foot_tap: {
    name: 'foot_tap',
    duration: 1.2,
    blendOut: 0.3,
    loop: { from: 0.4, to: 1.2 },
    expression: 'impatient',
    keys: [
      k(0.2, { mHip: 0.12, mKnee: 0.18, mHipAbd: 0.06, pelvisShift: -2.5 }),
      k(0.4, { mAnkle: 0.45 }, 'out'),
      k(0.6, { mAnkle: 0 }, 'in'),
      k(0.8, { mAnkle: 0.45 }, 'out'),
      k(1.0, { mAnkle: 0 }, 'in'),
      k(1.2, { mAnkle: 0.45 }, 'out'),
    ],
  },
  clap: {
    name: 'clap',
    duration: 1.75,
    blendOut: 0.35,
    expression: 'delighted',
    keys: [
      k(0.25, both(0.12, 0.95, -1.05, 1.1, 0), 'out', { m: 'flat', o: 'flat' }),
      k(0.45, { mTwist: -1.55, oTwist: -1.55, mElbow: 1.42, oElbow: 1.42 }, 'snap'),
      k(0.65, { mTwist: -1.05, oTwist: -1.05, mElbow: 1.1, oElbow: 1.1 }),
      k(0.85, { mTwist: -1.55, oTwist: -1.55, mElbow: 1.42, oElbow: 1.42 }, 'snap'),
      k(1.05, { mTwist: -1.05, oTwist: -1.05, mElbow: 1.1, oElbow: 1.1 }),
      k(1.25, { mTwist: -1.55, oTwist: -1.55, mElbow: 1.42, oElbow: 1.42 }, 'snap'),
      k(1.45, { mTwist: -1.05, oTwist: -1.05, mElbow: 1.1, oElbow: 1.1 }),
      k(1.75, { mTwist: -1.55, oTwist: -1.55, mElbow: 1.42, oElbow: 1.42 }, 'snap'),
    ],
  },
  namaste: {
    name: 'namaste',
    duration: 1.9,
    blendOut: 0.45,
    expression: 'calm',
    keys: [
      k(0.45, { ...both(0.25, 0.4, -1.5, 2.05, 1.3), headNod: 0.05 }, 'inOut', {
        m: 'flat',
        o: 'flat',
      }),
      k(0.85, { spine: 0.16, headNod: 0.24 }),
      k(1.35, { spine: 0.14, headNod: 0.2 }),
      k(1.7, { spine: 0, headNod: 0.02 }),
      k(1.9, { headNod: 0 }),
    ],
  },
  carry_on_head: {
    name: 'carry_on_head',
    duration: 1.6,
    blendOut: 0.45,
    loop: { from: 0.6, to: 1.6 },
    keys: [
      k(0.6, { ...m(2.95, 0.06, 1.5, 0.75, 0.5), spine: -0.02 }, 'inOut', { m: 'open' }),
      k(1.1, { mElbow: 0.8, headTilt: 0.01 }),
      k(1.6, { mElbow: 0.75, headTilt: 0 }),
    ],
  },
  push_cart: {
    name: 'push_cart',
    duration: 1.2,
    blendOut: 0.4,
    loop: { from: 0.5, to: 1.2 },
    keys: [
      k(0.5, { ...both(0.1, 1.1, -0.2, 0.45, 0.2), spine: 0.22, lean: 0.05 }, 'inOut', {
        m: 'grip',
        o: 'grip',
      }),
      k(0.85, { spine: 0.24, mElbow: 0.5, oElbow: 0.5 }),
      k(1.2, { spine: 0.22, mElbow: 0.45, oElbow: 0.45 }),
    ],
  },
  steer_cart: {
    name: 'steer_cart',
    duration: 2.4,
    blendOut: 0.4,
    grounded: false,
    loop: { from: 0.6, to: 2.4 },
    keys: [
      k(
        0.6,
        {
          mHip: 1.48,
          oHip: 1.48,
          mKnee: 1.45,
          oKnee: 1.45,
          mHipAbd: 0.08,
          oHipAbd: 0.08,
          ...both(0.12, 0.85, -0.3, 0.95, 0.15),
          spine: 0.06,
        },
        'inOut',
        { m: 'grip', o: 'grip' },
      ),
      k(1.4, { mElbow: 0.95, oElbow: 0.95 }),
      k(1.6, { mElbow: 0.55, oElbow: 0.6, mFlex: 1.05, oFlex: 1.0 }, 'snap'),
      k(1.9, { mElbow: 0.95, oElbow: 0.95, mFlex: 0.85, oFlex: 0.85 }),
      k(2.4, { mKnee: 1.5, oKnee: 1.4 }),
    ],
  },
  hold_lantern: {
    name: 'hold_lantern',
    duration: 1.8,
    blendOut: 0.4,
    loop: { from: 0.4, to: 1.8 },
    holdsItem: true,
    keys: [
      k(0.4, m(0.32, 0.55, -0.2, 1.05, 0.1), 'inOut', { m: 'grip' }),
      k(1.1, { mElbow: 1.0, mFlex: 0.58 }),
      k(1.8, { mElbow: 1.05, mFlex: 0.55 }),
    ],
  },
  nod: {
    name: 'nod',
    duration: 0.75,
    blendOut: 0.15,
    keys: [
      k(0.16, { headNod: 0.16 }),
      k(0.34, { headNod: -0.04 }),
      k(0.5, { headNod: 0.14 }),
      k(0.75, { headNod: 0 }, 'out'),
    ],
  },
  head_shake: {
    name: 'head_shake',
    duration: 0.9,
    blendOut: 0.15,
    keys: [
      k(0.15, { headTurn: 0.22, headTilt: 0.02 }),
      k(0.35, { headTurn: -0.22, headTilt: -0.02 }),
      k(0.55, { headTurn: 0.18 }),
      k(0.75, { headTurn: -0.12 }),
      k(0.9, { headTurn: 0, headTilt: 0 }, 'out'),
    ],
  },
  celebrate: {
    name: 'celebrate',
    duration: 1.35,
    blendOut: 0.35,
    profile: { mFlex: 0.45, oFlex: 0.45 },
    grounded: true,
    expression: 'delighted',
    sparkle: true,
    keys: [
      k(0.22, { ...both(2.45, 0.2, 0, 0.25, 0.2), squash: 0.05, rootY: 0 }, 'back', {
        m: 'open',
        o: 'open',
      }),
      k(0.42, { rootY: -24, squash: -0.04 }, 'out'),
      k(0.62, { rootY: 0, squash: 0.05 }, 'in'),
      k(0.8, { rootY: -16, squash: -0.03 }, 'out'),
      k(0.98, { rootY: 0, squash: 0.03 }, 'in'),
      k(1.15, { squash: 0 }),
      k(1.35, both(0.3, 0.2, 0, 0.4)),
    ],
  },
};

/* ================================================================================================ */

function ease(e: Ease | undefined, t: number): number {
  switch (e ?? 'inOut') {
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'inOut':
      return t * t * (3 - 2 * t);
    case 'back': {
      const c = 1.6;
      const u = t - 1;
      return 1 + (c + 1) * u * u * u + c * u * u;
    }
    case 'snap':
      return t < 1 ? 1 - (1 - t) ** 3 : 1;
  }
}

/** Resolve a gesture channel to a pose key for a main-limb side. */
export function resolveChannel(ch: GestureChannel, main: LimbSide): PoseKey {
  const first = ch.charAt(0);
  const second = ch.charAt(1);
  if ((first === 'm' || first === 'o') && second >= 'A' && second <= 'Z') {
    const side: LimbSide = first === 'm' ? main : main === 'l' ? 'r' : 'l';
    return limbKey(side, ch.slice(1) as ArmPart | LegPart);
  }
  return ch as PoseKey;
}

interface TrackKey {
  readonly t: number;
  readonly v: number;
  readonly ease: Ease | undefined;
}

/** A gesture compiled for one main side: per-channel key tracks. */
export interface CompiledGesture {
  readonly def: GestureDef;
  readonly main: LimbSide;
  readonly tracks: ReadonlyMap<PoseKey, readonly TrackKey[]>;
}

const compiled = new Map<string, CompiledGesture>();

/** Compile (and cache) a gesture for a main side. */
export function compileGesture(def: GestureDef, main: LimbSide): CompiledGesture {
  const id = main === 'l' ? def.name : `${def.name}:r`;
  const hit = compiled.get(id);
  if (hit && hit.def === def) return hit;
  const tracks = new Map<PoseKey, TrackKey[]>();
  for (const kf of def.keys) {
    for (const ch of Object.keys(kf.pose) as GestureChannel[]) {
      const v = kf.pose[ch];
      if (v === undefined) continue;
      const key = resolveChannel(ch, main);
      let tr = tracks.get(key);
      if (!tr) {
        tr = [];
        tracks.set(key, tr);
      }
      tr.push({ t: kf.t, v, ease: kf.ease });
    }
  }
  const c: CompiledGesture = { def, main, tracks };
  compiled.set(id, c);
  return c;
}

/** All pose keys a gesture drives (for a main side). */
export function gestureKeys(def: GestureDef, main: LimbSide): Set<PoseKey> {
  return new Set(compileGesture(def, main).tracks.keys());
}

/** Whether a pose key is angular (interpolated along the shortest arc). */
function isAngle(key: PoseKey): boolean {
  return key !== 'rootX' && key !== 'rootY' && key !== 'shoulderLift' && key !== 'pelvisShift';
}

export interface GestureSample {
  /** Blend weight of the gesture over the base (1 while playing, falls to 0 during blend-out). */
  readonly weight: number;
  /** True once the blend-out has finished. */
  readonly done: boolean;
  /** Hand shapes active at this time (undefined = keep the base hand). */
  readonly hands: { m?: HandShape; o?: HandShape };
}

/** Map a running clock onto keyed time, looping hold gestures while `holding`. */
export function gestureLocalTime(def: GestureDef, elapsed: number, holding: boolean): number {
  if (!def.loop || !holding || elapsed <= def.loop.to) return elapsed;
  const span = def.loop.to - def.loop.from;
  if (span <= 0) return def.loop.to;
  return def.loop.from + ((elapsed - def.loop.from) % span);
}

/** Value of one track at keyed time `t` starting from `base` (implicit key at t = 0). */
function trackValue(track: readonly TrackKey[], t: number, base: number, angular: boolean): number {
  let prevT = 0;
  let prevV = base;
  for (const kf of track) {
    if (t <= kf.t) {
      const span = kf.t - prevT;
      const u = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - prevT) / span));
      const e = ease(kf.ease, u);
      return angular ? prevV + angleDelta(prevV, kf.v) * e : prevV + (kf.v - prevV) * e;
    }
    prevT = kf.t;
    prevV = kf.v;
  }
  return prevV;
}

/**
 * Sample a gesture into `out` (which holds the base pose on entry). `t` is keyed time (see
 * {@link gestureLocalTime}); `releaseT` is the time spent blending out after a hold was released.
 */
export function sampleGesture(
  def: GestureDef,
  t: number,
  main: LimbSide,
  base: Readonly<Pose>,
  out: Pose,
  releaseT = 0,
): GestureSample {
  const c = compileGesture(def, main);
  const blendOut = Math.max(0.01, def.blendOut);
  const playedOut = !def.loop && t > def.duration ? t - def.duration : releaseT;
  const weight = Math.max(0, 1 - playedOut / blendOut);
  const smoothW = weight * weight * (3 - 2 * weight);
  const kt = Math.min(t, def.duration);
  for (const [key, track] of c.tracks) {
    const v = trackValue(track, kt, base[key], isAngle(key));
    out[key] = base[key] + (v - base[key]) * smoothW;
  }
  const hands: { m?: HandShape; o?: HandShape } = {};
  if (weight > 0.35)
    for (const kf of def.keys) {
      if (kf.t - 0.12 > kt) break;
      if (kf.hands?.m) hands.m = kf.hands.m;
      if (kf.hands?.o) hands.o = kf.hands.o;
    }
  return { weight: smoothW, done: weight <= 0, hands };
}

/** Events crossed while keyed time moved from `t0` to `t1` (exclusive/inclusive). */
export function eventsBetween(def: GestureDef, t0: number, t1: number): string[] {
  if (!def.events) return [];
  return def.events.filter((e) => e.t > t0 && e.t <= t1).map((e) => e.name);
}
