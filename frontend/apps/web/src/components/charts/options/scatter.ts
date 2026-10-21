/**
 * Scatter with OLS regression line and confidence band for the mean response (indicator vs
 * criterion). Group colours cap at 3 (all-pairs CVD rule); further groups fold into "Other".
 */
import type { CustomSeriesRenderItemAPI, EChartsOption, SeriesOption } from 'echarts';
import { formatCoefficient, formatNumber } from '@/lib/format';
import { extent } from '@/lib/stats/describe';
import { type BandPoint, meanResponseBand, type OlsFit, olsFit } from '@/lib/stats/regression';
import { assignGroupColors, type ChartTokens, SCATTER_SERIES_CAP } from '../tokens';
import { baseOption, type ReferenceLine, referenceMarkLines, valueAxis } from './base';
import { type ChartTable, round } from './table';

export interface ScatterPoint {
  readonly x: number;
  readonly y: number;
  readonly id?: string;
  readonly group?: string;
}

export interface ScatterRegressionInput {
  readonly points: readonly ScatterPoint[];
  readonly xLabel: string;
  readonly yLabel: string;
  /** Draw the OLS line (default true). */
  readonly regression?: boolean;
  /** Draw the confidence band (default true). */
  readonly band?: boolean;
  /** Confidence level for the band (default 0.95). */
  readonly level?: number;
  /** Server-computed band to draw instead of the client OLS band. */
  readonly bandOverride?: readonly BandPoint[];
  readonly referenceLinesX?: readonly ReferenceLine[];
  readonly referenceLinesY?: readonly ReferenceLine[];
}

export interface ScatterSummary {
  readonly fit: OlsFit | null;
  readonly band: readonly BandPoint[];
}

export function scatterSummary(input: ScatterRegressionInput): ScatterSummary {
  const fit = input.regression === false ? null : olsFit(input.points);
  if (input.bandOverride) return { fit, band: input.bandOverride };
  if (!fit || input.band === false) return { fit, band: [] };
  const [lo, hi] = extent(input.points.map((p) => p.x));
  return { fit, band: meanResponseBand(fit, lo, hi, input.level ?? 0.95) };
}

export function scatterRegressionOption(
  input: ScatterRegressionInput,
  tokens: ChartTokens,
): EChartsOption {
  const { fit, band } = scatterSummary(input);
  const groups = input.points.map((p) => p.group ?? '');
  const hasGroups = groups.some((g) => g !== '');
  const { color, folded } = assignGroupColors(groups, tokens, hasGroups ? SCATTER_SERIES_CAP : 1);
  const seriesNames = [...new Set(groups.map((g) => (folded.has(g) ? 'Other' : g)))];

  const pointSeries: SeriesOption[] = seriesNames.map((name) => ({
    type: 'scatter',
    name: name || input.yLabel,
    symbolSize: 8,
    itemStyle: {
      color: name === 'Other' ? tokens.inkMuted : (color.get(name) ?? tokens.series[0]),
      borderColor: tokens.surface,
      borderWidth: 2,
      opacity: 0.85,
    },
    emphasis: { scale: 1.4 },
    data: input.points
      .filter((p) => {
        const g = p.group ?? '';
        return (folded.has(g) ? 'Other' : g) === name;
      })
      .map((p) => ({ value: [p.x, p.y], name: p.id ?? '' })),
    z: 3,
  }));

  const series: SeriesOption[] = [];
  if (band.length > 1) {
    const polygon = [
      ...band.map((b) => [b.x, b.upper] as const),
      ...[...band].reverse().map((b) => [b.x, b.lower] as const),
    ];
    series.push({
      type: 'custom',
      name: `${Math.round((input.level ?? 0.95) * 100)}% CI`,
      silent: true,
      z: 1,
      data: [0],
      renderItem: (_params: unknown, api: CustomSeriesRenderItemAPI) => ({
        type: 'polygon',
        shape: { points: polygon.map(([x, y]) => api.coord([x, y])) },
        style: { fill: tokens.series[0], opacity: 0.12 },
      }),
      tooltip: { show: false },
    } as SeriesOption);
  }
  if (fit && band.length > 1) {
    series.push({
      type: 'line',
      name: 'OLS fit',
      silent: true,
      showSymbol: false,
      z: 2,
      lineStyle: { color: tokens.series[0], width: 2, cap: 'round', join: 'round' },
      data: band.map((b) => [b.x, b.fit]),
      tooltip: { show: false },
    });
  }
  series.push(...pointSeries);
  const first = series[series.length - 1] as Record<string, unknown> | undefined;
  if (first) {
    const markX = referenceMarkLines(tokens, input.referenceLinesX ?? [], 'x');
    const markY = referenceMarkLines(tokens, input.referenceLinesY ?? [], 'y');
    const data = [
      ...((markX?.data as unknown[] | undefined) ?? []),
      ...((markY?.data as unknown[] | undefined) ?? []),
    ];
    if (data.length) first.markLine = { ...(markX ?? markY), data };
  }

  const subtitle = fit
    ? `n = ${fit.n}, r = ${formatCoefficient(fit.r)}, slope = ${formatNumber(fit.slope, 3)}`
    : `n = ${input.points.length}`;
  return {
    ...baseOption(tokens, `Scatter plot of ${input.yLabel} against ${input.xLabel}. ${subtitle}.`),
    grid: { left: 16, right: 24, top: hasGroups ? 36 : 16, bottom: 40, containLabel: true },
    legend: hasGroups
      ? {
          top: 0,
          left: 0,
          icon: 'circle',
          itemWidth: 8,
          itemHeight: 8,
          textStyle: { color: tokens.inkSecondary, fontSize: 12 },
          data: seriesNames,
        }
      : { show: false },
    xAxis: valueAxis(tokens, input.xLabel, { nameGap: 28 }),
    yAxis: valueAxis(tokens, input.yLabel, { nameGap: 40 }),
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { name: string; seriesName: string; value: [number, number] };
        const id = p.name ? `${p.name}<br/>` : '';
        const group = hasGroups ? `${p.seriesName}<br/>` : '';
        return `${id}${group}${input.xLabel}: ${formatNumber(p.value[0], 2)}<br/>${input.yLabel}: ${formatNumber(p.value[1], 2)}`;
      },
    },
    series,
  };
}

export function scatterTable(input: ScatterRegressionInput): ChartTable {
  const hasGroups = input.points.some((p) => p.group);
  const hasIds = input.points.some((p) => p.id);
  return {
    columns: [
      ...(hasIds ? [{ key: 'id', header: 'ID' }] : []),
      ...(hasGroups ? [{ key: 'group', header: 'Group' }] : []),
      { key: 'x', header: input.xLabel, numeric: true },
      { key: 'y', header: input.yLabel, numeric: true },
    ],
    rows: input.points.map((p) => ({
      ...(hasIds ? { id: p.id ?? null } : {}),
      ...(hasGroups ? { group: p.group ?? null } : {}),
      x: round(p.x, 4),
      y: round(p.y, 4),
    })),
  };
}
