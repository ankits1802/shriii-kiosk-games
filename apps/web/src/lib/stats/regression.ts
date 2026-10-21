/**
 * Simple OLS fit and the confidence band for the mean response, for scatter charts.
 * Band: ŷ(x) ± t(1−α/2, n−2) · s · sqrt(1/n + (x − x̄)² / Sxx).
 */
import { normalQuantile, tCritical } from './distributions';

export interface XY {
  readonly x: number;
  readonly y: number;
}

export interface OlsFit {
  readonly n: number;
  readonly slope: number;
  readonly intercept: number;
  /** Pearson r. */
  readonly r: number;
  readonly r2: number;
  /** Residual standard error s (df = n − 2). */
  readonly residualSE: number;
  readonly xMean: number;
  readonly sxx: number;
}

export function olsFit(points: readonly XY[]): OlsFit | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const xMean = sx / n;
  const yMean = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const sse = Math.max(0, syy - slope * sxy);
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  return {
    n,
    slope,
    intercept,
    r,
    r2: r * r,
    residualSE: Math.sqrt(sse / (n - 2)),
    xMean,
    sxx,
  };
}

export interface BandPoint {
  readonly x: number;
  readonly fit: number;
  readonly lower: number;
  readonly upper: number;
}

/** Mean-response confidence band sampled at `steps` evenly spaced x values over [xMin, xMax]. */
export function meanResponseBand(
  fit: OlsFit,
  xMin: number,
  xMax: number,
  level = 0.95,
  steps = 40,
): BandPoint[] {
  const t = tCritical(level, fit.n - 2);
  const out: BandPoint[] = [];
  const count = Math.max(2, steps);
  for (let i = 0; i < count; i++) {
    const x = xMin + ((xMax - xMin) * i) / (count - 1);
    const yHat = fit.intercept + fit.slope * x;
    const se = fit.residualSE * Math.sqrt(1 / fit.n + (x - fit.xMean) ** 2 / fit.sxx);
    out.push({ x, fit: yHat, lower: yHat - t * se, upper: yHat + t * se });
  }
  return out;
}

/** Fisher-z confidence interval for a Pearson correlation. */
export function correlationCI(r: number, n: number, level = 0.95): [number, number] | null {
  if (n < 4 || !(Math.abs(r) < 1)) return null;
  const z = Math.atanh(r);
  const se = 1 / Math.sqrt(n - 3);
  const crit = normalQuantile(1 - (1 - level) / 2);
  return [Math.tanh(z - crit * se), Math.tanh(z + crit * se)];
}
