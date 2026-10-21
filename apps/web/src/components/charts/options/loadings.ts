/**
 * Factor-loading plot: items × factors on a diverging scale with loadings printed in each cell.
 * Loadings at or above the salience cut-off (passed in from the analysis config, never assumed)
 * are emphasised; items salient on more than one factor are flagged as cross-loading.
 */
import type { EChartsOption } from 'echarts';
import { formatCoefficient } from '@/lib/format';
import type { ChartTokens } from '../tokens';
import { heatmapOption } from './heatmap';
import { type ChartTable, round } from './table';

export interface LoadingPlotInput {
  readonly items: readonly string[];
  readonly factors: readonly string[];
  /** loadings[item][factor] */
  readonly loadings: readonly (readonly (number | null)[])[];
  /** |λ| emphasis cut-off from the registered analysis plan; omit for no emphasis. */
  readonly salience?: number;
  /** Communalities h² per item (optional, shown in the table). */
  readonly communalities?: readonly (number | null)[];
}

export function crossLoadingItems(input: LoadingPlotInput): string[] {
  if (input.salience === undefined) return [];
  const cut = input.salience;
  return input.items.filter(
    (_, i) => (input.loadings[i] ?? []).filter((v) => v !== null && Math.abs(v) >= cut).length > 1,
  );
}

export function loadingPlotOption(input: LoadingPlotInput, tokens: ChartTokens): EChartsOption {
  const base = heatmapOption(
    {
      rows: input.items,
      columns: input.factors,
      values: input.loadings,
      domain: [-1, 1],
      scale: 'diverging',
      cellLabels: true,
      valueLabel: 'λ',
    },
    tokens,
  );
  const cut = input.salience;
  const series = (base.series as Record<string, unknown>[]).map((s) => ({
    ...s,
    label: {
      show: true,
      fontSize: 11,
      rich: {
        strong: { color: tokens.ink, fontWeight: 600, fontSize: 11 },
        weak: { color: tokens.inkMuted, fontSize: 11 },
      },
      formatter: (params: unknown) => {
        const v = (params as { value: [number, number, number] }).value[2];
        if (!Number.isFinite(v)) return '';
        const text = formatCoefficient(v, 2);
        return cut === undefined || Math.abs(v) >= cut ? `{strong|${text}}` : `{weak|${text}}`;
      },
    },
  }));
  const flagged = new Set(crossLoadingItems(input));
  return {
    ...base,
    aria: {
      enabled: true,
      label: {
        description: `Factor loadings for ${input.items.length} items on ${input.factors.length} factors.${
          flagged.size ? ` Cross-loading items: ${[...flagged].join(', ')}.` : ''
        }`,
      },
    },
    yAxis: {
      ...(base.yAxis as object),
      axisLabel: {
        color: tokens.inkSecondary,
        fontSize: 11,
        interval: 0,
        formatter: (label: string) => (flagged.has(label) ? `${label} ⚑` : label),
      },
    },
    series: series as NonNullable<EChartsOption['series']>,
  };
}

export function loadingTable(input: LoadingPlotInput): ChartTable {
  const flagged = new Set(crossLoadingItems(input));
  return {
    columns: [
      { key: 'item', header: 'Item' },
      ...input.factors.map((f, i) => ({ key: `f${i}`, header: f, numeric: true })),
      ...(input.communalities ? [{ key: 'h2', header: 'h²', numeric: true }] : []),
      ...(input.salience === undefined ? [] : [{ key: 'cross', header: 'Cross-loading' }]),
    ],
    rows: input.items.map((item, r) => {
      const row: Record<string, string | number | null> = { item };
      input.factors.forEach((_, c) => {
        row[`f${c}`] = round(input.loadings[r]?.[c] ?? null);
      });
      if (input.communalities) row.h2 = round(input.communalities[r] ?? null);
      if (input.salience !== undefined) row.cross = flagged.has(item) ? 'yes' : 'no';
      return row;
    }),
  };
}
