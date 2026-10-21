import { describe, expect, it } from 'vitest';
import { blandAltman } from './agreement';
import { histogram, kernelDensity, silvermanBandwidth, suggestedBinCount } from './density';
import { mean, quantileSorted, sd } from './describe';
import {
  normalQuantile,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTQuantile,
  tCritical,
} from './distributions';
import { correlationCI, meanResponseBand, olsFit } from './regression';

describe('distributions (reference values from SciPy stats.t / stats.norm)', () => {
  it.each([
    [0.975, 1, 12.706204736],
    [0.975, 2, 4.30265273],
    [0.975, 10, 2.228138852],
    [0.975, 30, 2.042272456],
    [0.95, 5, 2.015048373],
    [0.995, 20, 2.84533971],
    [0.025, 10, -2.228138852],
  ])('qt(%f, %i)', (p, df, expected) => {
    expect(studentTQuantile(p, df)).toBeCloseTo(expected, 7);
  });

  it('pt matches', () => {
    expect(studentTCdf(2.228138852, 10)).toBeCloseTo(0.975, 9);
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(-1.5, 3)).toBeCloseTo(0.1152919326, 9);
  });

  it.each([
    [0.975, 1.959963985],
    [0.5, 0],
    [0.001, -3.090232306],
    [0.9999, 3.719016485],
  ])('qnorm(%f)', (p, expected) => {
    expect(normalQuantile(p)).toBeCloseTo(expected, 7);
  });

  it('incomplete beta symmetry and t critical values', () => {
    expect(regularizedIncompleteBeta(0.3, 2, 5) + regularizedIncompleteBeta(0.7, 5, 2)).toBeCloseTo(
      1,
      12,
    );
    expect(regularizedIncompleteBeta(0.5, 1, 1)).toBeCloseTo(0.5, 12);
    expect(tCritical(0.95, 10)).toBeCloseTo(2.228138852, 7);
    expect(() => tCritical(1, 10)).toThrow();
  });
});

describe('describe', () => {
  it('mean, sd, quantile (type 7)', () => {
    const v = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(v)).toBe(5);
    expect(sd(v)).toBeCloseTo(2.13809, 5);
    expect(quantileSorted(v, 0.25)).toBe(4);
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe('OLS and confidence band', () => {
  // Reference: scipy.stats.linregress(1..10, y)
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1, 18.0, 20.2];
  const pts = x.map((xi, i) => ({ x: xi, y: y[i] as number }));

  it('matches lm()', () => {
    const fit = olsFit(pts);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.slope).toBeCloseTo(2.0072727, 6);
    expect(fit.intercept).toBeCloseTo(0.0, 0);
    expect(fit.r).toBeCloseTo(0.9996697884, 9);
  });

  it('band equals predict(interval = "confidence") at the mean and widens away from it', () => {
    const fit = olsFit(pts);
    if (!fit) throw new Error('no fit');
    const band = meanResponseBand(fit, 1, 10, 0.95, 10);
    const half = (b: { upper: number; lower: number }) => (b.upper - b.lower) / 2;
    // At x = x̄ the half-width is t * s / sqrt(n).
    const atMean = meanResponseBand(fit, fit.xMean, fit.xMean, 0.95, 2)[0];
    expect(atMean && half(atMean)).toBeCloseTo(
      (tCritical(0.95, 8) * fit.residualSE) / Math.sqrt(10),
      10,
    );
    expect(half(band[0] as never)).toBeGreaterThan(half(atMean as never));
    expect(band[0]?.fit).toBeCloseTo(fit.intercept + fit.slope, 10);
  });

  it('needs at least 3 points with x variance', () => {
    expect(
      olsFit([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    ).toBeNull();
    expect(
      olsFit([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
      ]),
    ).toBeNull();
  });

  it('Fisher-z CI for r', () => {
    // r = .30, n = 100: [.1101, .4688]
    const ci = correlationCI(0.3, 100);
    expect(ci?.[0]).toBeCloseTo(0.1101, 3);
    expect(ci?.[1]).toBeCloseTo(0.4688, 3);
    expect(correlationCI(0.3, 3)).toBeNull();
  });
});

describe('histogram and density', () => {
  it('bins all finite values with the last bin closed', () => {
    const bins = histogram([0, 1, 2, 3, 4, 5, Number.NaN, null], { bins: 5 });
    expect(bins).toHaveLength(5);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(6);
    expect(bins[4]?.count).toBe(2);
    expect(histogram([])).toEqual([]);
    expect(histogram([3, 3, 3])).toEqual([{ x0: 2.5, x1: 3.5, count: 3 }]);
  });

  it('suggests a sensible bin count and bandwidth', () => {
    const v = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 10 + i / 10);
    expect(suggestedBinCount(v)).toBeGreaterThan(5);
    expect(silvermanBandwidth(v)).toBeGreaterThan(0);
  });

  it('KDE integrates to ~1', () => {
    const v = Array.from({ length: 100 }, (_, i) => (i % 10) - 5);
    const kde = kernelDensity(v, { points: 400 });
    const dx = (kde[1]?.x ?? 0) - (kde[0]?.x ?? 0);
    expect(kde.reduce((s, p) => s + p.density * dx, 0)).toBeCloseTo(1, 2);
  });
});

describe('Bland–Altman', () => {
  it('computes bias, limits and CIs', () => {
    const pairs = [
      { first: 10, second: 11 },
      { first: 12, second: 12.5 },
      { first: 9, second: 10.2 },
      { first: 14, second: 13.6 },
      { first: 11, second: 12.1 },
    ];
    const res = blandAltman(pairs);
    expect(res).not.toBeNull();
    if (!res) return;
    const diffs = [1, 0.5, 1.2, -0.4, 1.1];
    expect(res.bias.estimate).toBeCloseTo(mean(diffs), 12);
    expect(res.sdDifference).toBeCloseTo(sd(diffs), 12);
    expect(res.upperLimit.estimate - res.bias.estimate).toBeCloseTo(1.959964 * sd(diffs), 5);
    expect(res.bias.upper - res.bias.estimate).toBeCloseTo(
      (tCritical(0.95, 4) * sd(diffs)) / Math.sqrt(5),
      10,
    );
    expect(blandAltman(pairs.slice(0, 2))).toBeNull();
  });
});
