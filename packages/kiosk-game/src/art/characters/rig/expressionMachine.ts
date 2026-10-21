/**
 * Expression state machine.
 *
 * States are the expressions of {@link EXPRESSIONS}. The machine holds a BASE expression (with an
 * intensity for the negative ones) and an optional TRANSIENT reaction (e.g. a surprised flash or a
 * delighted burst) that returns to the base after its hold. Every change crossfades the continuous face
 * parameters over a transition time chosen per edge: reactions are fast (surprise 0.12 s), warming up is
 * moderate, escalating anger is brisk and calming down is deliberately slower. Posture, symbol and
 * fidget switch when the crossfade passes its midpoint so body language and face change together.
 *
 * The Stall's anger ladder ({@link ANGER_LEVELS}) maps levels 0..3 to calm, impatient, annoyed and angry
 * at rising intensity. This is a stimulus property set by the episode script, never player sensing.
 */
import {
  ANGER_LEVELS,
  type ArmPose,
  EXPRESSIONS,
  type ExpressionParams,
  type ExpressionSymbol,
  type ExtendedExpression,
  intensify,
  isIntensifiable,
  lerpParams,
  toneExpression,
} from '../expressions.ts';

export type Fidget = 'none' | 'foot_tap' | 'bounce' | 'shake';

export interface ExpressionFrame {
  /** Effective expression (the transient while one plays). */
  readonly expression: ExtendedExpression;
  readonly params: ExpressionParams;
  readonly symbol: ExpressionSymbol;
  readonly posture: ArmPose;
  readonly fidget: Fidget;
  readonly intensity: number;
  /** Crossfade progress of the current transition (1 = settled). */
  readonly progress: number;
  /** True on the frame the effective expression changed (e.g. to trigger a blink). */
  readonly changed: boolean;
}

/** Negativity rank used to decide escalation vs. calming. */
const VALENCE: Readonly<Record<ExtendedExpression, number>> = {
  delighted: -3,
  happy: -2,
  pleased: -1.5,
  calm: -1,
  neutral: 0,
  thinking: 0,
  surprised: 0.5,
  impatient: 1,
  annoyed: 2,
  angry: 3,
};

/** Crossfade duration (s) for a transition. */
export function transitionTime(
  from: ExtendedExpression,
  to: ExtendedExpression,
  fromIntensity = 1,
  toIntensity = 1,
): number {
  if (from === to && fromIntensity === toIntensity) return 0;
  if (to === 'surprised') return 0.12;
  if (from === 'surprised') return 0.35;
  if (to === 'delighted' || to === 'happy') return 0.2;
  const dv = VALENCE[to] + toIntensity * 0.1 - (VALENCE[from] + fromIntensity * 0.1);
  if (dv > 0.05) return VALENCE[to] >= 1 ? 0.3 : 0.28; // escalation is brisk
  if (dv < -0.05) return VALENCE[from] >= 1 ? 0.65 : 0.4; // calming down takes longer
  return 0.3;
}

function targetParams(e: ExtendedExpression, intensity: number): ExpressionParams {
  const p = EXPRESSIONS[e].params;
  return isIntensifiable(e) ? intensify(p, intensity) : p;
}

function symbolFor(e: ExtendedExpression, intensity: number): ExpressionSymbol {
  if ((e === 'annoyed' || e === 'impatient') && intensity >= 3) return 'steam';
  return EXPRESSIONS[e].symbol;
}

export class ExpressionMachine {
  private base: ExtendedExpression;
  private baseIntensity: number;
  private transient: { expr: ExtendedExpression; remaining: number } | null = null;
  private from: ExpressionParams;
  private to: ExpressionParams;
  private elapsed = 0;
  private duration = 0;
  private current: ExtendedExpression;
  private currentIntensity: number;
  private prevVisible: { expr: ExtendedExpression; intensity: number };
  private params: ExpressionParams;
  private changedFlag = false;

  constructor(initial: ExtendedExpression = 'neutral', intensity = 1) {
    this.base = initial;
    this.baseIntensity = intensity;
    this.current = initial;
    this.currentIntensity = intensity;
    this.prevVisible = { expr: initial, intensity };
    this.params = targetParams(initial, intensity);
    this.from = this.params;
    this.to = this.params;
  }

  get expression(): ExtendedExpression {
    return this.current;
  }

  get baseExpression(): ExtendedExpression {
    return this.base;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  /** Set the base expression (cancels a transient). `durationS` overrides the edge's crossfade. */
  set(
    expr: ExtendedExpression,
    options: { readonly intensity?: number; readonly durationS?: number } = {},
  ): void {
    this.base = expr;
    this.baseIntensity = clampIntensity(
      options.intensity ?? (isIntensifiable(expr) ? this.baseIntensity : 1),
    );
    this.transient = null;
    this.goTo(expr, this.baseIntensity, options.durationS);
  }

  /** Change the intensity (1..3) of the current base expression. */
  setIntensity(intensity: number): void {
    this.set(this.base, { intensity });
  }

  /** Customer tone (0 calm .. 4 hostile). */
  setTone(level: 0 | 1 | 2 | 3 | 4): void {
    const t = toneExpression(level);
    this.set(t.expression, { intensity: Math.max(1, t.intensity) });
  }

  /** The Stall's anger ladder (0..3). */
  setAnger(level: 0 | 1 | 2 | 3): void {
    const l = ANGER_LEVELS[level] ?? ANGER_LEVELS[0];
    if (!l) return;
    this.set(l.expression, { intensity: l.intensity });
  }

  /** Brief reaction that returns to the base after `holdS`. */
  flash(expr: ExtendedExpression, holdS = 0.9): void {
    this.transient = { expr, remaining: Math.max(0, holdS) };
    this.goTo(expr, 1);
  }

  /** Jump to the target immediately (no crossfade). */
  settle(): void {
    this.elapsed = this.duration;
    this.params = this.to;
  }

  update(dt: number): ExpressionFrame {
    const step = Math.max(0, dt);
    if (this.transient) {
      this.transient.remaining -= step;
      if (this.transient.remaining <= 0) {
        this.transient = null;
        this.goTo(this.base, this.baseIntensity);
      }
    }
    this.elapsed = Math.min(this.duration, this.elapsed + step);
    const u = this.duration <= 0 ? 1 : this.elapsed / this.duration;
    const e = u * u * (3 - 2 * u);
    this.params = u >= 1 ? this.to : lerpParams(this.from, this.to, e);
    const visible =
      u >= 0.5 ? { expr: this.current, intensity: this.currentIntensity } : this.prevVisible;
    const def = EXPRESSIONS[visible.expr];
    const changed = this.changedFlag;
    this.changedFlag = false;
    return {
      expression: this.current,
      params: this.params,
      symbol: symbolFor(visible.expr, visible.intensity),
      posture: def.arms,
      fidget: def.fidget,
      intensity: visible.intensity,
      progress: u,
      changed,
    };
  }

  private goTo(expr: ExtendedExpression, intensity: number, durationS?: number): void {
    const prev = this.current;
    const prevI = this.currentIntensity;
    if (prev !== expr || prevI !== intensity) this.changedFlag = true;
    // The posture/symbol switch at mid-fade refers to what is visible now.
    const u = this.duration <= 0 ? 1 : this.elapsed / this.duration;
    if (u >= 0.5) this.prevVisible = { expr: prev, intensity: prevI };
    this.from = this.params;
    this.to = targetParams(expr, intensity);
    this.current = expr;
    this.currentIntensity = intensity;
    this.duration = durationS ?? transitionTime(prev, expr, prevI, intensity);
    this.elapsed = 0;
    if (this.duration <= 0) {
      this.params = this.to;
      this.prevVisible = { expr, intensity };
    }
  }
}

function clampIntensity(v: number): number {
  return Math.max(1, Math.min(3, Math.round(v)));
}
