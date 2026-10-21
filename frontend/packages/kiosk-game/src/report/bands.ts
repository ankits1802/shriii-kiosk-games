/**
 * REP-01 kiosk band evaluator (consumes the release pack produced by the Python reference).
 *
 * composite = sum(w_i * z_i) / sum(|w_i|) with z_i = (x_i - mean_i) / sd_i, sign-flipped for negative
 * indicators (unit-weighted z). Bands: pole_a below the lower cut, pole_b above the upper cut, centre in
 * between. "Not enough to say" (gates.yaml sem_rule): the SEM-based CI overlaps more band boundaries than
 * allowed, or the centre band is narrower than `minBandWidthSem` SEMs. Missing indicators -> unavailable.
 *
 * Parity with the Python reference (10k golden sessions, 1e-8) is tracked by REP-01; these functions
 * are deliberately small and pure so the parity harness can call them directly.
 */
import type { CompositeParameters, NormTable } from '@shriii/contracts';
import type { BandCode } from '../core/contracts.ts';
import { SEM_RULE } from './rules/rules.generated.ts';
import type { SemRule } from './rules/types.ts';

export type BandOutcome = BandCode | 'not_enough_to_say' | 'unavailable';

/** Unit-weighted z composite, or null when any indicator is missing/non-finite or a sd is not positive. */
export function compositeScore(
  params: CompositeParameters,
  values: ReadonlyMap<string, number>,
): number | null {
  let num = 0;
  let den = 0;
  for (const ind of params.indicators) {
    const x = values.get(ind.indicator_id);
    if (x === undefined || !Number.isFinite(x) || !(ind.sd > 0)) return null;
    const z = ((x - ind.mean) / ind.sd) * (ind.direction === 'negative' ? -1 : 1);
    num += ind.weight * z;
    den += Math.abs(ind.weight);
  }
  return den > 0 ? num / den : null;
}

/** Inverse standard normal CDF: Acklam's approximation refined by one Halley step (abs. error ~1e-7, ample for CI widths). */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('inverseNormalCdf: p must be in (0, 1)');
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const at = (arr: number[], i: number): number => arr[i] ?? 0;
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q +
        at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r +
        at(a, 5)) *
        q) /
      (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(
        ((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q +
        at(c, 5)
      ) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }
  // One Halley refinement step using erfc for high precision.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Complementary error function (Chebyshev-fitted erfcc, fractional error < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Map a composite to a band through a norm table, applying the "not enough to say" rule. */
export function bandForComposite(
  composite: number | null,
  norm: NormTable,
  rule: SemRule = SEM_RULE,
): BandOutcome {
  if (composite === null || !Number.isFinite(composite)) return 'unavailable';
  const [lo, hi] = norm.cut_points;
  if (!(hi > lo) || !(norm.sem > 0)) return 'unavailable';
  if (hi - lo < rule.minBandWidthSem * norm.sem) return 'not_enough_to_say';
  const half = inverseNormalCdf((1 + rule.ciLevel) / 2) * norm.sem;
  const ciLo = composite - half;
  const ciHi = composite + half;
  const overlapped = [lo, hi].filter((cut) => ciLo < cut && ciHi > cut).length;
  if (overlapped > rule.maxBandBoundariesOverlapped) return 'not_enough_to_say';
  if (composite < lo) return 'pole_a';
  if (composite > hi) return 'pole_b';
  return 'centre';
}
