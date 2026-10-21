/**
 * Bland–Altman agreement statistics for test–retest plots (Bland & Altman 1986; CIs per
 * Bland & Altman 1999: SE(bias) = s/√n, SE(LoA) ≈ s·√(3/n)).
 */

import { mean, sd } from './describe';
import { normalQuantile, tCritical } from './distributions';

export interface PairedValue {
  readonly id?: string;
  readonly first: number;
  readonly second: number;
}

export interface BlandAltmanPoint {
  readonly id?: string;
  readonly mean: number;
  readonly difference: number;
}

export interface Interval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
}

export interface BlandAltmanResult {
  readonly n: number;
  readonly points: readonly BlandAltmanPoint[];
  readonly sdDifference: number;
  readonly bias: Interval;
  readonly lowerLimit: Interval;
  readonly upperLimit: Interval;
  /** Multiplier used for the limits (≈1.96 for 95 %). */
  readonly limitMultiplier: number;
}

/**
 * Differences are `second − first` (retest minus test), so a positive bias means scores rose at
 * retest (practice effect).
 */
export function blandAltman(pairs: readonly PairedValue[], level = 0.95): BlandAltmanResult | null {
  const valid = pairs.filter((p) => Number.isFinite(p.first) && Number.isFinite(p.second));
  const n = valid.length;
  if (n < 3) return null;
  const points: BlandAltmanPoint[] = valid.map((p) => ({
    ...(p.id === undefined ? {} : { id: p.id }),
    mean: (p.first + p.second) / 2,
    difference: p.second - p.first,
  }));
  const diffs = points.map((p) => p.difference);
  const bias = mean(diffs);
  const s = sd(diffs);
  const z = normalQuantile(1 - (1 - level) / 2);
  const t = tCritical(level, n - 1);
  const seBias = s / Math.sqrt(n);
  const seLoa = s * Math.sqrt(3 / n);
  const lo = bias - z * s;
  const hi = bias + z * s;
  return {
    n,
    points,
    sdDifference: s,
    limitMultiplier: z,
    bias: { estimate: bias, lower: bias - t * seBias, upper: bias + t * seBias },
    lowerLimit: { estimate: lo, lower: lo - t * seLoa, upper: lo + t * seLoa },
    upperLimit: { estimate: hi, lower: hi - t * seLoa, upper: hi + t * seLoa },
  };
}
