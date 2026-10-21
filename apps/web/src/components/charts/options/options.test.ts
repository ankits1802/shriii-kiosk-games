import type { EChartsOption } from 'echarts';
import { describe, expect, it } from 'vitest';
import { assignGroupColors, LIGHT_TOKENS, SCATTER_SERIES_CAP, seriesColor } from '../tokens';
import { BAR_GAP_PX, BAR_WIDTH, barCiOption, barCiTable, barOffset } from './bar-ci';
import { blandAltmanOption, blandAltmanTable } from './bland-altman';
import { distributionOption, distributionTable } from './distribution';
import { forestPlotOption, forestTable, validateForestRows } from './forest';
import { heatmapOption, heatmapTable, validateMatrix } from './heatmap';
import { crossLoadingItems, loadingPlotOption, loadingTable } from './loadings';
import { scatterRegressionOption, scatterSummary, scatterTable } from './scatter';

const t = LIGHT_TOKENS;

function seriesOf(option: EChartsOption): Record<string, unknown>[] {
  const s = option.series;
  return (Array.isArray(s) ? s : s ? [s] : []) as Record<string, unknown>[];
}

describe('palette rules', () => {
  it('uses categorical slots in fixed order and folds overflow into muted "Other"', () => {
    expect(seriesColor(t, 0)).toBe(t.series[0]);
    expect(seriesColor(t, 8)).toBe(t.inkMuted);
    const { color, folded } = assignGroupColors(
      ['a', 'b', 'a', 'c', 'd', 'e'],
      t,
      SCATTER_SERIES_CAP,
    );
    expect(color.get('a')).toBe(t.series[0]);
    expect(color.get('c')).toBe(t.series[2]);
    expect(color.get('d')).toBe(t.inkMuted);
    expect([...folded]).toEqual(['d', 'e']);
  });
});

describe('heatmap', () => {
  const input = {
    rows: ['A', 'B'],
    columns: ['X', 'Y', 'Z'],
    values: [
      [0.3, -0.1, null],
      [0.05, 0.42, 0.2],
    ],
  };

  it('validates matrix shape', () => {
    expect(() => validateMatrix({ ...input, values: [[1, 2, 3]] })).toThrow();
    expect(() => validateMatrix({ ...input, values: [[1], [2]] })).toThrow();
  });

  it('uses a diverging [-1, 1] scale with a neutral midpoint by default', () => {
    const o = heatmapOption(input, t);
    const vm = o.visualMap as { min: number; max: number; inRange: { color: string[] } };
    expect([vm.min, vm.max]).toEqual([-1, 1]);
    expect(vm.inRange.color).toEqual([t.divergingNeg, t.divergingMid, t.divergingPos]);
    expect(seriesOf(o)[0]?.data).toHaveLength(6);
  });

  it('tabulates values', () => {
    const table = heatmapTable(input);
    expect(table.rows[0]).toEqual({ row: 'A', c0: 0.3, c1: -0.1, c2: null });
  });
});

describe('scatter with regression', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({
    x: i,
    y: 2 * i + ((i * 7) % 5) - 2,
    group: ['hi', 'mr', 'ta', 'en'][i % 4] as string,
  }));

  it('adds band polygon + fit line + point series; caps groups at 3 colours', () => {
    const o = scatterRegressionOption({ points, xLabel: 'x', yLabel: 'y' }, t);
    const types = seriesOf(o).map((s) => s.type);
    expect(types.slice(0, 2)).toEqual(['custom', 'line']);
    const names = seriesOf(o)
      .filter((s) => s.type === 'scatter')
      .map((s) => s.name);
    expect(names).toEqual(['hi', 'mr', 'ta', 'Other']);
    const summary = scatterSummary({ points, xLabel: 'x', yLabel: 'y' });
    expect(summary.fit?.slope).toBeGreaterThan(1.8);
    expect(summary.band.every((b) => b.lower <= b.fit && b.fit <= b.upper)).toBe(true);
  });

  it('can draw points only, and tabulates', () => {
    const o = scatterRegressionOption({ points, xLabel: 'x', yLabel: 'y', regression: false }, t);
    expect(seriesOf(o).every((s) => s.type === 'scatter')).toBe(true);
    expect(scatterTable({ points, xLabel: 'x', yLabel: 'y' }).columns.map((c) => c.key)).toEqual([
      'group',
      'x',
      'y',
    ]);
  });

  it('places reference lines from config', () => {
    const o = scatterRegressionOption(
      { points, xLabel: 'x', yLabel: 'y', referenceLinesY: [{ value: 10, label: 'target' }] },
      t,
    );
    const withMark = seriesOf(o).find((s) => s.markLine);
    const markLine = withMark?.markLine as { data: { yAxis: number }[] } | undefined;
    expect(markLine?.data[0]?.yAxis).toBe(10);
  });
});

describe('forest plot', () => {
  const rows = [
    { label: 'hi-IN', estimate: 0.3, lower: 0.15, upper: 0.44, n: 300 },
    { label: 'ta-IN', estimate: 0.18, lower: 0.02, upper: 0.33, n: 280 },
  ];
  it('validates intervals', () => {
    expect(() =>
      validateForestRows([{ label: 'x', estimate: 0.5, lower: 0.6, upper: 0.7 }]),
    ).toThrow();
    expect(() =>
      validateForestRows([{ label: 'x', estimate: Number.NaN, lower: 0, upper: 1 }]),
    ).toThrow();
  });
  it('draws a null line and tabulates', () => {
    const o = forestPlotOption({ rows, xLabel: 'r', nullValue: 0 }, t);
    const ml = seriesOf(o)[0]?.markLine as { data: { xAxis: number }[] };
    expect(ml.data[0]?.xAxis).toBe(0);
    expect(forestTable({ rows, xLabel: 'r' }).rows[1]).toMatchObject({
      label: 'ta-IN',
      estimate: 0.18,
      n: 280,
    });
  });
});

describe('bar chart with CI whiskers', () => {
  const input = {
    categories: ['A', 'B'],
    series: [
      { name: 'criterion r', values: [{ value: 0.2, lower: 0.1, upper: 0.3 }, { value: 0.25 }] },
      {
        name: 'retest r',
        values: [
          { value: 0.6, lower: 0.5, upper: 0.7 },
          { value: 0.7, lower: 0.6, upper: 0.8 },
        ],
      },
    ],
    valueLabel: 'r',
  };
  it('pairs each bar series with an error-bar series and keeps bars thin with a 2px gap', () => {
    const s = seriesOf(barCiOption(input, t));
    expect(s.map((x) => x.type)).toEqual(['bar', 'custom', 'bar', 'custom']);
    expect(s[0]?.barWidth).toBe(BAR_WIDTH);
    expect(BAR_WIDTH).toBeLessThanOrEqual(24);
    expect(barOffset(0, 2)).toBe(-(BAR_WIDTH + BAR_GAP_PX) / 2);
    expect(barOffset(1, 2)).toBe((BAR_WIDTH + BAR_GAP_PX) / 2);
  });
  it('rejects misaligned series and tabulates', () => {
    expect(() =>
      barCiOption({ ...input, series: [{ name: 'x', values: [{ value: 1 }] }] }, t),
    ).toThrow();
    expect(barCiTable(input).rows[1]).toMatchObject({
      category: 'B',
      s0: 0.25,
      s0_lo: null,
      s1_hi: 0.8,
    });
  });
});

describe('distribution', () => {
  it('draws bins and a density overlay on one count axis', () => {
    const values = Array.from({ length: 50 }, (_, i) => i % 10);
    const o = distributionOption({ values, xLabel: 'RT' }, t);
    expect(seriesOf(o).map((s) => s.type)).toEqual(['custom', 'line']);
    expect(Array.isArray(o.yAxis)).toBe(false);
    const table = distributionTable({ values, xLabel: 'RT', bins: 5 });
    expect(table.rows.reduce((sum, r) => sum + (r.count as number), 0)).toBe(50);
  });
});

describe('loading plot', () => {
  const input = {
    items: ['i1', 'i2', 'i3'],
    factors: ['F1', 'F2'],
    loadings: [
      [0.7, 0.1],
      [0.45, 0.42],
      [0.05, 0.8],
    ],
    salience: 0.4,
  };
  it('flags cross-loading items using the configured salience', () => {
    expect(crossLoadingItems(input)).toEqual(['i2']);
    expect(
      crossLoadingItems({ items: input.items, factors: input.factors, loadings: input.loadings }),
    ).toEqual([]);
    expect(loadingTable(input).rows.map((r) => r.cross)).toEqual(['no', 'yes', 'no']);
  });
  it('renders strong/weak cell labels', () => {
    const o = loadingPlotOption(input, t);
    const label = seriesOf(o)[0]?.label as { formatter: (p: unknown) => string };
    expect(label.formatter({ value: [0, 0, 0.7] })).toBe('{strong|.70}');
    expect(label.formatter({ value: [1, 0, 0.1] })).toBe('{weak|.10}');
  });
});

describe('Bland–Altman plot', () => {
  const pairs = Array.from({ length: 20 }, (_, i) => ({
    id: `P${i}`,
    first: i,
    second: i + 0.5 + ((i % 3) - 1) * 0.2,
  }));
  it('marks bias and limits of agreement with CI washes', () => {
    const s = seriesOf(blandAltmanOption({ pairs, measure: 'm' }, t))[0] as Record<string, unknown>;
    expect((s.markLine as { data: unknown[] }).data).toHaveLength(3);
    expect((s.markArea as { data: unknown[] }).data).toHaveLength(3);
    expect(blandAltmanTable({ pairs, measure: 'm' }).rows[0]).toMatchObject({
      id: 'P0',
      mean: 0.15,
      difference: 0.3,
    });
  });
  it('degrades gracefully with too few pairs', () => {
    const s = seriesOf(
      blandAltmanOption({ pairs: pairs.slice(0, 2), measure: 'm' }, t),
    )[0] as Record<string, unknown>;
    expect(s.markLine).toBeUndefined();
  });
});
