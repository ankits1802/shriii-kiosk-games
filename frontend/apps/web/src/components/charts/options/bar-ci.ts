/**
 * Bar chart with confidence-interval whiskers (e.g. cross-construct comparison of criterion r and
 * retest r). Bars ≤ 20px thick, 4px rounded data end, 2px surface gap between grouped bars.
 */
import type { CustomSeriesRenderItemAPI, EChartsOption, SeriesOption } from 'echarts';
import { formatCoefficient, formatNumber } from '@/lib/format';
import { type ChartTokens, seriesColor } from '../tokens';
import {
  baseOption,
  categoryAxis,
  type ReferenceLine,
  referenceMarkLines,
  valueAxis,
  withMarkLine,
} from './base';
import { type ChartTable, type ChartTableColumn, round } from './table';

export interface BarValue {
  readonly value: number | null;
  readonly lower?: number | null;
  readonly upper?: number | null;
  readonly n?: number | null;
}

export interface BarSeries {
  readonly name: string;
  /** One entry per category, aligned with `categories`. */
  readonly values: readonly BarValue[];
}

export interface BarCiInput {
  readonly categories: readonly string[];
  readonly series: readonly BarSeries[];
  readonly valueLabel: string;
  readonly referenceLines?: readonly ReferenceLine[];
  readonly valueStyle?: 'coefficient' | 'number';
  readonly digits?: number;
  readonly domain?: readonly [number, number];
}

export const BAR_WIDTH = 20;
export const BAR_GAP_PX = 2;

/** Pixel offset of series `i` of `k` from the category centre. */
export function barOffset(i: number, k: number): number {
  return (i - (k - 1) / 2) * (BAR_WIDTH + BAR_GAP_PX);
}

export function barCiOption(input: BarCiInput, tokens: ChartTokens): EChartsOption {
  for (const s of input.series) {
    if (s.values.length !== input.categories.length) {
      throw new Error(`bar chart: series "${s.name}" needs one value per category`);
    }
  }
  const k = input.series.length;
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined
      ? '—'
      : input.valueStyle === 'number'
        ? formatNumber(v, input.digits ?? 2)
        : formatCoefficient(v, input.digits ?? 2);

  const series: SeriesOption[] = [];
  input.series.forEach((s, i) => {
    const fill = seriesColor(tokens, i);
    series.push({
      type: 'bar',
      name: s.name,
      barWidth: BAR_WIDTH,
      barGap: `${(BAR_GAP_PX / BAR_WIDTH) * 100}%`,
      itemStyle: { color: fill, borderRadius: [4, 4, 0, 0] },
      data: s.values.map((v) => v.value),
      z: 2,
      ...(i === 0
        ? { ...withMarkLine(referenceMarkLines(tokens, input.referenceLines ?? [], 'y')) }
        : {}),
    } as SeriesOption);
    series.push({
      type: 'custom',
      name: s.name,
      silent: true,
      z: 3,
      data: s.values.map((v, c) => [c, v.lower ?? null, v.upper ?? null]),
      renderItem: (_params: unknown, api: CustomSeriesRenderItemAPI) => {
        const lower = api.value(1);
        const upper = api.value(2);
        if (
          typeof lower !== 'number' ||
          typeof upper !== 'number' ||
          Number.isNaN(lower) ||
          Number.isNaN(upper)
        ) {
          return null;
        }
        const c = api.value(0) as number;
        const lo = api.coord([c, lower]) as number[];
        const hi = api.coord([c, upper]) as number[];
        const x = (lo[0] ?? 0) + barOffset(i, k);
        const cap = 5;
        const style = { stroke: tokens.ink, lineWidth: 1.25 };
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: x, y1: lo[1], x2: x, y2: hi[1] }, style },
            { type: 'line', shape: { x1: x - cap, y1: lo[1], x2: x + cap, y2: lo[1] }, style },
            { type: 'line', shape: { x1: x - cap, y1: hi[1], x2: x + cap, y2: hi[1] }, style },
          ],
        };
      },
      tooltip: { show: false },
    } as SeriesOption);
  });

  return {
    ...baseOption(
      tokens,
      `Bar chart of ${input.valueLabel} across ${input.categories.length} categories with confidence intervals.`,
    ),
    grid: { left: 16, right: 16, top: k > 1 ? 36 : 16, bottom: 24, containLabel: true },
    legend:
      k > 1
        ? {
            top: 0,
            left: 0,
            itemWidth: 10,
            itemHeight: 10,
            textStyle: { color: tokens.inkSecondary, fontSize: 12 },
            data: input.series.map((s) => s.name),
          }
        : { show: false },
    xAxis: categoryAxis(tokens, input.categories, {
      axisLabel: {
        color: tokens.inkSecondary,
        fontSize: 11,
        interval: 0,
        rotate: input.categories.length > 8 ? 30 : 0,
      },
    }),
    yAxis: valueAxis(tokens, input.valueLabel, {
      nameGap: 40,
      scale: false,
      ...(input.domain ? { min: input.domain[0], max: input.domain[1] } : {}),
    }),
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: tokens.grid, opacity: 0.4 } },
      formatter: (params: unknown) => {
        const list = (params as { dataIndex: number; seriesType: string }[]).filter(
          (p) => p.seriesType === 'bar',
        );
        const c = list[0]?.dataIndex ?? 0;
        const lines = input.series.map((s) => {
          const v = s.values[c];
          const ci =
            v && v.lower != null && v.upper != null ? ` [${fmt(v.lower)}, ${fmt(v.upper)}]` : '';
          const n = v?.n != null ? ` · n = ${v.n}` : '';
          return `${s.name}: ${fmt(v?.value)}${ci}${n}`;
        });
        return `${input.categories[c]}<br/>${lines.join('<br/>')}`;
      },
    },
    series,
  };
}

export function barCiTable(input: BarCiInput): ChartTable {
  const columns: ChartTableColumn[] = [{ key: 'category', header: 'Category' }];
  for (const [i, s] of input.series.entries()) {
    columns.push(
      { key: `s${i}`, header: s.name, numeric: true },
      { key: `s${i}_lo`, header: `${s.name} CI lower`, numeric: true },
      { key: `s${i}_hi`, header: `${s.name} CI upper`, numeric: true },
    );
  }
  return {
    columns,
    rows: input.categories.map((category, c) => {
      const row: Record<string, string | number | null> = { category };
      input.series.forEach((s, i) => {
        const v = s.values[c];
        row[`s${i}`] = round(v?.value ?? null);
        row[`s${i}_lo`] = round(v?.lower ?? null);
        row[`s${i}_hi`] = round(v?.upper ?? null);
      });
      return row;
    }),
  };
}
