/**
 * Forest plot: point estimates with confidence intervals per row (indicator-criterion correlations
 * by language group, reliability by subgroup, DIF effects). A vertical null line (e.g. 0) and
 * optional reference lines (thresholds from YAML) anchor the reading.
 */
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  EChartsOption,
} from 'echarts';
import { formatCoefficient, formatNumber } from '@/lib/format';
import { assignGroupColors, type ChartTokens, SCATTER_SERIES_CAP } from '../tokens';
import {
  baseOption,
  categoryAxis,
  type ReferenceLine,
  referenceMarkLines,
  valueAxis,
  withMarkLine,
} from './base';
import { type ChartTable, round } from './table';

export interface ForestRow {
  readonly label: string;
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly n?: number;
  readonly group?: string;
}

export interface ForestPlotInput {
  readonly rows: readonly ForestRow[];
  readonly xLabel: string;
  /** Null-effect line (e.g. 0 for correlations, 1 for ratios); omit for none. */
  readonly nullValue?: number;
  readonly referenceLines?: readonly ReferenceLine[];
  readonly valueStyle?: 'coefficient' | 'number';
  readonly digits?: number;
  /** Fixed x domain (e.g. [-1, 1] for correlations). */
  readonly domain?: readonly [number, number];
}

export function validateForestRows(rows: readonly ForestRow[]): void {
  for (const r of rows) {
    if (![r.estimate, r.lower, r.upper].every(Number.isFinite)) {
      throw new Error(`forest plot: row "${r.label}" has a non-finite estimate or bound`);
    }
    if (r.lower > r.estimate || r.estimate > r.upper) {
      throw new Error(`forest plot: row "${r.label}" must satisfy lower <= estimate <= upper`);
    }
  }
}

function markerSize(n: number | undefined, nMax: number): number {
  if (!n || nMax <= 0) return 9;
  return 8 + 6 * Math.sqrt(n / nMax);
}

export function forestPlotOption(input: ForestPlotInput, tokens: ChartTokens): EChartsOption {
  validateForestRows(input.rows);
  const fmt = (v: number) =>
    input.valueStyle === 'number'
      ? formatNumber(v, input.digits ?? 2)
      : formatCoefficient(v, input.digits ?? 2);
  const labels = input.rows.map((r) => r.label);
  const groups = input.rows.map((r) => r.group ?? '');
  const hasGroups = groups.some((g) => g !== '');
  const { color } = assignGroupColors(groups, tokens, hasGroups ? SCATTER_SERIES_CAP : 1);
  const nMax = Math.max(0, ...input.rows.map((r) => r.n ?? 0));
  const reference: ReferenceLine[] = [
    ...(input.nullValue === undefined
      ? []
      : [{ value: input.nullValue, label: '', kind: 'null' as const }]),
    ...(input.referenceLines ?? []),
  ];

  return {
    ...baseOption(
      tokens,
      `Forest plot of ${input.xLabel} for ${input.rows.length} rows with confidence intervals.`,
    ),
    grid: {
      left: 8,
      right: 24,
      top: 12,
      bottom: 8,
      outerBoundsMode: 'same',
      outerBoundsContain: 'all',
    },
    xAxis: valueAxis(tokens, input.xLabel, {
      nameGap: 28,
      ...(input.domain ? { min: input.domain[0], max: input.domain[1], scale: false } : {}),
    }),
    yAxis: categoryAxis(tokens, labels, {
      inverse: true,
      axisLine: { show: false },
      axisLabel: { color: tokens.inkSecondary, fontSize: 12, interval: 0 },
    }),
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { dataIndex: number };
        const r = input.rows[p.dataIndex];
        if (!r) return '';
        return `${r.label}${r.group ? ` · ${r.group}` : ''}<br/>${fmt(r.estimate)} [${fmt(r.lower)}, ${fmt(r.upper)}]${
          r.n === undefined ? '' : `<br/>n = ${r.n}`
        }`;
      },
    },
    series: [
      {
        type: 'custom',
        name: input.xLabel,
        data: input.rows.map((r, i) => [r.lower, r.upper, i, r.estimate, r.n ?? 0]),
        encode: { x: [0, 1, 3], y: 2 },
        renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
          const row = input.rows[params.dataIndex as number];
          const fill = color.get(row?.group ?? '') ?? tokens.series[0];
          const y = api.value(2) as number;
          const [loX = 0, loY = 0] = api.coord([api.value(0), y]) as number[];
          const [hiX = 0, hiY = 0] = api.coord([api.value(1), y]) as number[];
          const [estX = 0, estY = 0] = api.coord([api.value(3), y]) as number[];
          const size = markerSize(api.value(4) as number, nMax);
          const cap = 4;
          const stroke = { stroke: tokens.inkSecondary, lineWidth: 1.5 };
          return {
            type: 'group',
            children: [
              { type: 'line', shape: { x1: loX, y1: loY, x2: hiX, y2: hiY }, style: stroke },
              {
                type: 'line',
                shape: { x1: loX, y1: loY - cap, x2: loX, y2: loY + cap },
                style: stroke,
              },
              {
                type: 'line',
                shape: { x1: hiX, y1: hiY - cap, x2: hiX, y2: hiY + cap },
                style: stroke,
              },
              {
                type: 'rect',
                shape: { x: estX - size / 2, y: estY - size / 2, width: size, height: size, r: 1 },
                style: { fill, stroke: tokens.surface, lineWidth: 2 },
              },
            ],
          };
        },
        ...withMarkLine(referenceMarkLines(tokens, reference, 'x')),
      },
    ],
  };
}

export function forestTable(input: ForestPlotInput): ChartTable {
  const hasGroups = input.rows.some((r) => r.group);
  const hasN = input.rows.some((r) => r.n !== undefined);
  return {
    columns: [
      { key: 'label', header: 'Row' },
      ...(hasGroups ? [{ key: 'group', header: 'Group' }] : []),
      { key: 'estimate', header: 'Estimate', numeric: true },
      { key: 'lower', header: 'CI lower', numeric: true },
      { key: 'upper', header: 'CI upper', numeric: true },
      ...(hasN ? [{ key: 'n', header: 'n', numeric: true, digits: 0 }] : []),
    ],
    rows: input.rows.map((r) => ({
      label: r.label,
      ...(hasGroups ? { group: r.group ?? null } : {}),
      estimate: round(r.estimate),
      lower: round(r.lower),
      upper: round(r.upper),
      ...(hasN ? { n: r.n ?? null } : {}),
    })),
  };
}
