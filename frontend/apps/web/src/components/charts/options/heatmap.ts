/**
 * Matrix heatmap (criterion correlation matrices, MTMM blocks). Diverging blue <-> red through a
 * neutral gray midpoint for signed values; single-hue sequential for magnitudes.
 */
import type { EChartsOption } from 'echarts';
import { formatCoefficient, formatNumber } from '@/lib/format';
import type { ChartTokens } from '../tokens';
import { baseOption, categoryAxis } from './base';
import { type ChartTable, round } from './table';

export interface HeatmapInput {
  readonly rows: readonly string[];
  readonly columns: readonly string[];
  /** values[row][column]; null = not estimable / not applicable. */
  readonly values: readonly (readonly (number | null)[])[];
  /** Optional pairwise N, same shape as `values`. */
  readonly n?: readonly (readonly (number | null)[])[];
  /** Colour scale domain (default [-1, 1] for diverging, data extent for sequential). */
  readonly domain?: readonly [number, number];
  readonly scale?: 'diverging' | 'sequential';
  /** Print the value in each cell (default true when the matrix is at most 12 × 12). */
  readonly cellLabels?: boolean;
  /** Coefficient style (".34") vs plain numbers. */
  readonly valueStyle?: 'coefficient' | 'number';
  readonly digits?: number;
  readonly valueLabel?: string;
}

export function validateMatrix(input: HeatmapInput): void {
  if (input.values.length !== input.rows.length) {
    throw new Error(
      `heatmap: ${input.values.length} value rows for ${input.rows.length} row labels`,
    );
  }
  for (const row of input.values) {
    if (row.length !== input.columns.length) {
      throw new Error('heatmap: every value row must have one entry per column label');
    }
  }
}

function fmt(input: HeatmapInput, v: number | null): string {
  if (v === null) return '—';
  return input.valueStyle === 'number'
    ? formatNumber(v, input.digits ?? 2)
    : formatCoefficient(v, input.digits ?? 2);
}

export function heatmapOption(input: HeatmapInput, tokens: ChartTokens): EChartsOption {
  validateMatrix(input);
  const diverging = (input.scale ?? 'diverging') === 'diverging';
  const flat: number[] = [];
  const data: [number, number, number | null][] = [];
  input.values.forEach((row, r) => {
    row.forEach((v, c) => {
      data.push([c, r, v]);
      if (v !== null && Number.isFinite(v)) flat.push(v);
    });
  });
  const domain: readonly [number, number] =
    input.domain ??
    (diverging ? [-1, 1] : flat.length ? [Math.min(...flat), Math.max(...flat)] : [0, 1]);
  const showLabels = input.cellLabels ?? (input.rows.length <= 12 && input.columns.length <= 12);
  const valueLabel = input.valueLabel ?? (diverging ? 'r' : 'value');
  return {
    ...baseOption(
      tokens,
      `Heatmap of ${valueLabel} for ${input.rows.length} rows by ${input.columns.length} columns.`,
    ),
    grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
    xAxis: categoryAxis(tokens, input.columns, {
      axisLabel: {
        color: tokens.inkSecondary,
        fontSize: 11,
        rotate: input.columns.length > 6 ? 35 : 0,
        interval: 0,
      },
      splitArea: { show: false },
    }),
    yAxis: categoryAxis(tokens, input.rows, {
      inverse: true,
      axisLabel: { color: tokens.inkSecondary, fontSize: 11, interval: 0 },
    }),
    visualMap: {
      type: 'continuous',
      min: domain[0],
      max: domain[1],
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 160,
      text: [fmt(input, domain[1]), fmt(input, domain[0])],
      textStyle: { color: tokens.inkMuted, fontSize: 11 },
      inRange: {
        color: diverging
          ? [tokens.divergingNeg, tokens.divergingMid, tokens.divergingPos]
          : [tokens.seqLow, tokens.seqHigh],
      },
      outOfRange: { color: [tokens.grid] },
    },
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { value: [number, number, number | null] };
        const [c, r, v] = p.value;
        const n = input.n?.[r]?.[c];
        return `${input.rows[r]} × ${input.columns[c]}<br/>${valueLabel} = ${fmt(input, v)}${
          n === undefined || n === null ? '' : ` · n = ${n}`
        }`;
      },
    },
    series: [
      {
        type: 'heatmap',
        data: data.map(([c, r, v]) => ({ value: [c, r, v ?? Number.NaN] })),
        itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 2 },
        label: {
          show: showLabels,
          color: tokens.ink,
          fontSize: 11,
          formatter: (params: unknown) => {
            const p = params as { value: [number, number, number] };
            return Number.isFinite(p.value[2]) ? fmt(input, p.value[2]) : '';
          },
        },
        emphasis: { itemStyle: { borderColor: tokens.ink, borderWidth: 1 } },
      },
    ],
  };
}

export function heatmapTable(input: HeatmapInput): ChartTable {
  return {
    columns: [
      { key: 'row', header: 'Row' },
      ...input.columns.map((c, i) => ({ key: `c${i}`, header: c, numeric: true })),
    ],
    rows: input.rows.map((label, r) => {
      const out: Record<string, string | number | null> = { row: label };
      input.columns.forEach((_, c) => {
        out[`c${c}`] = round(input.values[r]?.[c] ?? null);
      });
      return out;
    }),
  };
}
