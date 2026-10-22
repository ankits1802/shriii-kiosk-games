/**
 * Histogram with an optional kernel-density overlay on the same count axis (density × n × bin
 * width), so there is one y-axis. Group comparisons overlay density curves only (≤ 3 colours).
 */
import type { CustomSeriesRenderItemAPI, EChartsOption, SeriesOption } from 'echarts';
import { formatInteger, formatNumber } from '@/lib/format';
import { histogram, kernelDensity } from '@/lib/stats/density';
import { extent, finite } from '@/lib/stats/describe';
import { type ChartTokens, SCATTER_SERIES_CAP, seriesColor } from '../tokens';
import {
  baseOption,
  type ReferenceLine,
  referenceMarkLines,
  valueAxis,
  withMarkLine,
} from './base';
import { type ChartTable, round } from './table';

export interface DistributionGroup {
  readonly name: string;
  readonly values: readonly (number | null | undefined)[];
}

export interface DistributionInput {
  readonly values: readonly (number | null | undefined)[];
  readonly xLabel: string;
  readonly bins?: number;
  /** Overlay a KDE curve (default true when n ≥ 10). */
  readonly density?: boolean;
  readonly bandwidth?: number;
  /** Optional per-group density overlays (e.g. by language); colours capped at 3. */
  readonly groups?: readonly DistributionGroup[];
  readonly referenceLines?: readonly ReferenceLine[];
}

/** Overlay colours skip slot 1 (the histogram fill), so the cap is 3 overlays + 1. */
const SERIES_OVERLAY_CAP = SCATTER_SERIES_CAP + 1;

export function distributionOption(input: DistributionInput, tokens: ChartTokens): EChartsOption {
  const values = finite(input.values);
  const domain = values.length ? extent(values) : ([0, 1] as [number, number]);
  const bins = histogram(values, {
    ...(input.bins === undefined ? {} : { bins: input.bins }),
    domain,
  });
  const firstBin = bins[0];
  const binWidth = firstBin ? firstBin.x1 - firstBin.x0 : 1;
  const series: SeriesOption[] = [
    {
      type: 'custom',
      name: 'Count',
      data: bins.map((b) => [b.x0, b.x1, b.count]),
      encode: { x: [0, 1], y: 2 },
      renderItem: (_params: unknown, api: CustomSeriesRenderItemAPI) => {
        const start = api.coord([api.value(0), api.value(2)]) as number[];
        const end = api.coord([api.value(1), 0]) as number[];
        const x = (start[0] ?? 0) + 1; // 1px each side = 2px surface gap between bins
        const width = Math.max(1, (end[0] ?? 0) - (start[0] ?? 0) - 2);
        const height = (end[1] ?? 0) - (start[1] ?? 0);
        return {
          type: 'rect',
          shape: {
            x,
            y: start[1],
            width,
            height,
            r: [Math.min(4, width / 2), Math.min(4, width / 2), 0, 0],
          },
          style: { fill: tokens.series[0], opacity: input.groups?.length ? 0.35 : 1 },
        };
      },
      ...withMarkLine(referenceMarkLines(tokens, input.referenceLines ?? [], 'x')),
      z: 2,
    } as SeriesOption,
  ];

  const showDensity = input.density ?? values.length >= 10;
  const densitySources: { name: string; values: number[]; color: string }[] = input.groups?.length
    ? input.groups.slice(0, SCATTER_SERIES_CAP).map((g, i) => ({
        name: g.name,
        values: finite(g.values),
        color: seriesColor(tokens, i + 1, SERIES_OVERLAY_CAP),
      }))
    : showDensity
      ? [{ name: 'Density', values, color: tokens.ink }]
      : [];
  for (const src of densitySources) {
    if (src.values.length < 2) continue;
    const kde = kernelDensity(src.values, {
      points: 120,
      domain,
      ...(input.bandwidth === undefined ? {} : { bandwidth: input.bandwidth }),
    });
    const scale = src.values.length * binWidth;
    series.push({
      type: 'line',
      name: src.name,
      showSymbol: false,
      smooth: false,
      lineStyle: { color: src.color, width: 2, cap: 'round', join: 'round' },
      itemStyle: { color: src.color },
      data: kde.map((p) => [p.x, p.density * scale]),
      z: 3,
      tooltip: { show: false },
    });
  }

  const hasLegend = (input.groups?.length ?? 0) > 1;
  return {
    ...baseOption(tokens, `Histogram of ${input.xLabel}, n = ${values.length}.`),
    grid: {
      left: 16,
      right: 16,
      top: hasLegend ? 36 : 16,
      bottom: 8,
      outerBoundsMode: 'same',
      outerBoundsContain: 'all',
    },
    legend: hasLegend
      ? {
          top: 0,
          left: 0,
          textStyle: { color: tokens.inkSecondary, fontSize: 12 },
          data: densitySources.map((d) => d.name),
        }
      : { show: false },
    xAxis: valueAxis(tokens, input.xLabel, {
      nameGap: 28,
      min: domain[0],
      max: domain[1],
      scale: false,
    }),
    yAxis: valueAxis(tokens, 'Count', { nameGap: 44, scale: false, minInterval: 1 }),
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { value: [number, number, number]; seriesName: string };
        if (p.seriesName !== 'Count') return '';
        return `${formatNumber(p.value[0], 2)} – ${formatNumber(p.value[1], 2)}<br/>Count: ${formatInteger(p.value[2])}`;
      },
    },
    series,
  };
}

export function distributionTable(input: DistributionInput): ChartTable {
  const values = finite(input.values);
  const bins = histogram(values, input.bins === undefined ? {} : { bins: input.bins });
  return {
    columns: [
      { key: 'from', header: `${input.xLabel} from`, numeric: true },
      { key: 'to', header: `${input.xLabel} to`, numeric: true },
      { key: 'count', header: 'Count', numeric: true, digits: 0 },
    ],
    rows: bins.map((b) => ({ from: round(b.x0, 4), to: round(b.x1, 4), count: b.count })),
  };
}
