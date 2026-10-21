/**
 * Facial expression model. Every expression is a set of continuous parameters (brow angle and height,
 * eye openness, smile curve, mouth opening...) plus non-colour cues (posture, symbols such as a sweat
 * drop, an anger mark or steam puffs) so that expression is readable without relying on colour
 * (KSK-06). Expressions tween smoothly by interpolating parameters.
 *
 * The Stall's customer tone uses {@link toneExpression}: level 0 calm, 1 impatient, 2 annoyed,
 * 3 angry, 4 angry at the highest intensity. Tone is a stimulus property, never player sensing.
 */
import type { Expression } from '../../core/contracts.ts';

/** Contract expressions plus the extra states the art kit supports. */
export type ExtendedExpression = Expression | 'pleased' | 'impatient' | 'delighted';

/** Every expression, in a calm-to-hostile display order (gallery, tests). */
export const EXPRESSION_LIST: readonly ExtendedExpression[] = [
  'neutral',
  'calm',
  'pleased',
  'happy',
  'delighted',
  'thinking',
  'surprised',
  'impatient',
  'annoyed',
  'angry',
];

export type ExpressionSymbol = 'none' | 'sweat' | 'vein' | 'steam' | 'sparkle' | 'thought' | 'sigh';
export type ArmPose = 'relaxed' | 'hips' | 'crossed' | 'chin' | 'open' | 'fist';

export interface ExpressionParams {
  /** Inner-brow angle: + = angry (inner ends down), - = worried/sad. Radians. */
  readonly browAngle: number;
  /** Brow lift (px at scale 1): + raised. */
  readonly browLift: number;
  /** Asymmetric brow raise for thinking. */
  readonly browAsym: number;
  /** Eye openness 0 (closed) .. 1.25 (wide). */
  readonly eyeOpen: number;
  /** Lower-lid lift (smiling eyes) 0..1. */
  readonly eyeSmile: number;
  /** Pupil scale (small pupils read as anger/shock). */
  readonly pupil: number;
  /** Mouth curve -1 (frown) .. 1 (big smile). */
  readonly smile: number;
  /** Mouth opening 0..1. */
  readonly mouthOpen: number;
  /** Mouth width factor. */
  readonly mouthWidth: number;
  /** Show teeth (shouting / big grin). */
  readonly teeth: number;
  /** Cheek blush 0..1 (a cue in addition to the shapes, never alone). */
  readonly blush: number;
  /** Face flush 0..1 (anger). */
  readonly flush: number;
  /** Head tilt radians. */
  readonly tilt: number;
  /** Body lean (- back, + forward). */
  readonly lean: number;
  /** Gaze offset -1..1 (x) and -1..1 (y). */
  readonly gazeX: number;
  readonly gazeY: number;
}

export interface ExpressionDef {
  readonly params: ExpressionParams;
  readonly symbol: ExpressionSymbol;
  readonly arms: ArmPose;
  /** Idle micro-motion style. */
  readonly fidget: 'none' | 'foot_tap' | 'bounce' | 'shake';
}

const BASE: ExpressionParams = {
  browAngle: 0,
  browLift: 0,
  browAsym: 0,
  eyeOpen: 1,
  eyeSmile: 0,
  pupil: 1,
  smile: 0.25,
  mouthOpen: 0,
  mouthWidth: 1,
  teeth: 0,
  blush: 0.15,
  flush: 0,
  tilt: 0,
  lean: 0,
  gazeX: 0,
  gazeY: 0,
};

/** Expression library. */
export const EXPRESSIONS: Readonly<Record<ExtendedExpression, ExpressionDef>> = {
  neutral: { params: BASE, symbol: 'none', arms: 'relaxed', fidget: 'none' },
  calm: {
    params: {
      ...BASE,
      browLift: 1.5,
      eyeOpen: 0.82,
      eyeSmile: 0.25,
      smile: 0.45,
      blush: 0.25,
      tilt: 0.04,
    },
    symbol: 'none',
    arms: 'relaxed',
    fidget: 'none',
  },
  happy: {
    params: {
      ...BASE,
      browLift: 3,
      eyeOpen: 0.95,
      eyeSmile: 0.75,
      smile: 1,
      mouthOpen: 0.45,
      mouthWidth: 1.2,
      teeth: 0.6,
      blush: 0.55,
      tilt: 0.06,
    },
    symbol: 'sparkle',
    arms: 'open',
    fidget: 'bounce',
  },
  pleased: {
    params: {
      ...BASE,
      browLift: 2.5,
      eyeOpen: 0.9,
      eyeSmile: 0.55,
      smile: 0.8,
      mouthOpen: 0.15,
      mouthWidth: 1.1,
      blush: 0.45,
      tilt: 0.05,
    },
    symbol: 'none',
    arms: 'relaxed',
    fidget: 'none',
  },
  delighted: {
    params: {
      ...BASE,
      browLift: 4.5,
      eyeOpen: 0.1,
      eyeSmile: 1,
      smile: 1,
      mouthOpen: 0.7,
      mouthWidth: 1.28,
      teeth: 0.8,
      blush: 0.75,
      tilt: 0.08,
      lean: -0.02,
    },
    symbol: 'sparkle',
    arms: 'open',
    fidget: 'bounce',
  },
  thinking: {
    params: {
      ...BASE,
      browAsym: 4,
      eyeOpen: 0.9,
      smile: 0.05,
      mouthWidth: 0.7,
      gazeX: 0.6,
      gazeY: -0.6,
      tilt: -0.07,
    },
    symbol: 'thought',
    arms: 'chin',
    fidget: 'none',
  },
  surprised: {
    params: {
      ...BASE,
      browLift: 7,
      eyeOpen: 1.25,
      pupil: 0.8,
      smile: 0,
      mouthOpen: 0.75,
      mouthWidth: 0.55,
      blush: 0.2,
      lean: -0.04,
    },
    symbol: 'none',
    arms: 'open',
    fidget: 'none',
  },
  impatient: {
    params: {
      ...BASE,
      browAngle: 0.12,
      browLift: -1,
      eyeOpen: 0.62,
      smile: -0.25,
      mouthWidth: 0.85,
      gazeX: -0.7,
      tilt: -0.05,
    },
    symbol: 'sigh',
    arms: 'hips',
    fidget: 'foot_tap',
  },
  annoyed: {
    params: {
      ...BASE,
      browAngle: 0.3,
      browLift: -2.5,
      eyeOpen: 0.55,
      pupil: 0.9,
      smile: -0.55,
      mouthWidth: 0.9,
      blush: 0,
      flush: 0.25,
      tilt: -0.08,
      lean: -0.02,
    },
    symbol: 'vein',
    arms: 'crossed',
    fidget: 'foot_tap',
  },
  angry: {
    params: {
      ...BASE,
      browAngle: 0.48,
      browLift: -4,
      eyeOpen: 0.6,
      pupil: 0.7,
      smile: -0.85,
      mouthOpen: 0.55,
      mouthWidth: 1.15,
      teeth: 1,
      blush: 0,
      flush: 0.55,
      lean: 0.06,
    },
    symbol: 'steam',
    arms: 'fist',
    fidget: 'shake',
  },
};

/** Linear interpolation of expression parameters. */
export function lerpParams(a: ExpressionParams, b: ExpressionParams, t: number): ExpressionParams {
  const out: Record<string, number> = {};
  for (const k of Object.keys(a) as (keyof ExpressionParams)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out as unknown as ExpressionParams;
}

/** Customer tone level (stimulus property) to expression and intensity. */
export function toneExpression(level: 0 | 1 | 2 | 3 | 4): {
  expression: ExtendedExpression;
  intensity: 0 | 1 | 2 | 3;
} {
  switch (level) {
    case 0:
      return { expression: 'calm', intensity: 0 };
    case 1:
      return { expression: 'impatient', intensity: 1 };
    case 2:
      return { expression: 'annoyed', intensity: 1 };
    case 3:
      return { expression: 'angry', intensity: 2 };
    case 4:
      return { expression: 'angry', intensity: 3 };
  }
}

/**
 * The Stall's anger ladder (0 calm, 1 impatient, 2 annoyed, 3 angry). Level 3 is the hostile end of the
 * customer tone scale (tone 4). A stimulus property only; never derived from the player.
 */
export const ANGER_LEVELS: readonly {
  readonly expression: ExtendedExpression;
  readonly intensity: 1 | 2 | 3;
  readonly tone: 0 | 1 | 2 | 3 | 4;
}[] = [
  { expression: 'calm', intensity: 1, tone: 0 },
  { expression: 'impatient', intensity: 1, tone: 1 },
  { expression: 'annoyed', intensity: 1, tone: 2 },
  { expression: 'angry', intensity: 3, tone: 4 },
];

/** Expressions whose parameters scale with intensity. */
export function isIntensifiable(e: ExtendedExpression): boolean {
  return e === 'angry' || e === 'annoyed' || e === 'impatient';
}

/** Scale an angry/annoyed expression by intensity 1..3 (exaggerates brows, mouth, lean, symbols). */
export function intensify(p: ExpressionParams, intensity: number): ExpressionParams {
  if (intensity <= 1) return p;
  const k = 1 + (intensity - 1) * 0.28;
  return {
    ...p,
    browAngle: p.browAngle * k,
    browLift: p.browLift * k,
    eyeOpen: Math.max(0.45, p.eyeOpen / k),
    smile: Math.max(-1, p.smile * k),
    mouthOpen: Math.min(1, p.mouthOpen * k),
    flush: Math.min(1, p.flush * k),
    lean: p.lean * k,
  };
}
