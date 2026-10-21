/** Histogram binning and Gaussian kernel density for distribution charts. */
import { extent, finite, quantileSorted, sd } from './describe';

export interface Bin {
  readonly x0: number;
  readonly x1: number;
  readonly count: number;
}

/** Freedman–Diaconis bin width, falling back to Sturges when the IQR is zero. */
export function suggestedBinCount(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const [lo, hi] = extent(sorted);
  const range = hi - lo;
  if (range === 0) return 1;
  const sturges = Math.ceil(Math.log2(n) + 1);
  if (iqr === 0) return sturges;
  const width = (2 * iqr) / Math.cbrt(n);
  return Math.min(100, Math.max(sturges, Math.ceil(range / width)));
}

export function histogram(
  input: readonly (number | null | undefined)[],
  options: { bins?: number; domain?: readonly [number, number] } = {},
): Bin[] {
  const values = finite(input);
  if (values.length === 0) return [];
  const [lo, hi] = options.domain ?? extent(values);
  const count = Math.max(1, Math.floor(options.bins ?? suggestedBinCount(values)));
  if (hi === lo) return [{ x0: lo - 0.5, x1: hi + 0.5, count: values.length }];
  const width = (hi - lo) / count;
  const bins = Array.from({ length: count }, (_, i) => ({
    x0: lo + i * width,
    x1: i === count - 1 ? hi : lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    if (v < lo || v > hi) continue;
    const i = Math.min(count - 1, Math.floor((v - lo) / width));
    (bins[i] as { count: number }).count += 1;
  }
  return bins;
}

/** Silverman's rule-of-thumb bandwidth: 0.9 · min(sd, IQR/1.34) · n^(−1/5). */
export function silvermanBandwidth(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const s = sd(values);
  const spread = iqr > 0 ? Math.min(s, iqr / 1.34) : s;
  return spread > 0 ? 0.9 * spread * n ** -0.2 : 1;
}

export interface DensityPoint {
  readonly x: number;
  readonly density: number;
}

/** Gaussian KDE evaluated on `points` evenly spaced x values (range padded by 3 bandwidths). */
export function kernelDensity(
  input: readonly (number | null | undefined)[],
  options: { bandwidth?: number; points?: number; domain?: readonly [number, number] } = {},
): DensityPoint[] {
  const values = finite(input);
  if (values.length === 0) return [];
  const h = options.bandwidth ?? silvermanBandwidth(values);
  const [vLo, vHi] = extent(values);
  const [lo, hi] = options.domain ?? [vLo - 3 * h, vHi + 3 * h];
  const steps = Math.max(2, options.points ?? 100);
  const norm = 1 / (values.length * h * Math.sqrt(2 * Math.PI));
  const out: DensityPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const x = lo + ((hi - lo) * i) / (steps - 1);
    let sum = 0;
    for (const v of values) sum += Math.exp(-0.5 * ((x - v) / h) ** 2);
    out.push({ x, density: sum * norm });
  }
  return out;
}
