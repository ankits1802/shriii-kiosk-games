'use client';

/**
 * MTMM heatmap with own-versus-discriminant highlighting: the focus construct's validity diagonal
 * (same trait, different method) gets a heavy ink outline, its heterotrait cells a thin outline, and
 * everything else is faded, so the Campbell–Fiske comparison reads at a glance. Colour stays the
 * diverging r scale of the shared heatmap primitive; highlighting uses outlines and opacity only.
 */
import type { EChartsOption } from 'echarts';
import { useMemo } from 'react';
import { ChartFrame, type Provenance } from '@/components/charts/chart-frame';
import { EChart } from '@/components/charts/echart';
import { heatmapOption, heatmapTable } from '@/components/charts/options/heatmap';
import type { ChartTokens } from '@/components/charts/tokens';
import { useChartTokens } from '@/components/charts/use-chart-tokens';
import { type MtmmMatrix, mtmmCellKind, mtmmLabel } from '../lib/results';

export function mtmmHeatmapOption(
  matrix: MtmmMatrix,
  focus: string | null,
  tokens: ChartTokens,
): EChartsOption {
  const labels = matrix.variables.map(mtmmLabel);
  const base = heatmapOption(
    { rows: labels, columns: labels, values: matrix.values, valueLabel: 'r', cellLabels: true },
    tokens,
  );
  const series = (base.series as Record<string, unknown>[])[0] ?? {};
  const data = matrix.variables.flatMap((_, r) =>
    matrix.variables.map((__, c) => {
      const v = matrix.values[r]?.[c] ?? null;
      const a = matrix.variables[r] ?? '';
      const b = matrix.variables[c] ?? '';
      const involves = focus !== null && (matrix.traits[a] === focus || matrix.traits[b] === focus);
      const kind = mtmmCellKind(matrix, r, c);
      const itemStyle: Record<string, unknown> = {};
      if (focus !== null) {
        if (involves && kind === 'validity') {
          Object.assign(itemStyle, { borderColor: tokens.ink, borderWidth: 3 });
        } else if (involves && kind !== 'reliability') {
          Object.assign(itemStyle, {
            borderColor: tokens.inkSecondary,
            borderWidth: 1,
            borderType: 'dashed',
          });
        } else {
          Object.assign(itemStyle, { opacity: 0.35 });
        }
      } else if (kind === 'validity') {
        Object.assign(itemStyle, { borderColor: tokens.ink, borderWidth: 2 });
      }
      return { value: [c, r, v ?? Number.NaN], itemStyle };
    }),
  );
  return {
    ...base,
    grid: { left: 8, right: 16, top: 8, bottom: 72, containLabel: true },
    series: [{ ...series, data }] as NonNullable<EChartsOption['series']>,
  };
}

export function MtmmHeatmap({
  matrix,
  focus,
  provenance,
  synthetic,
}: {
  readonly matrix: MtmmMatrix;
  readonly focus: string | null;
  readonly provenance?: Provenance;
  readonly synthetic?: boolean;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => mtmmHeatmapOption(matrix, focus, tokens), [matrix, focus, tokens]);
  const table = useMemo(() => {
    const labels = matrix.variables.map(mtmmLabel);
    return heatmapTable({ rows: labels, columns: labels, values: matrix.values });
  }, [matrix]);
  const height = Math.max(320, 120 + matrix.variables.length * 40);
  return (
    <ChartFrame
      title={`Multitrait–multimethod matrix${matrix.language ? ` · ${matrix.language}` : ' · pooled'}`}
      description={
        focus
          ? `Heavy outline: ${focus.replaceAll('_', ' ')} validity diagonal (game × self-report). Dashed: its discriminant (heterotrait) correlations. Others faded.`
          : 'Outlined cells are validity diagonals (same trait, different method).'
      }
      table={table}
      exportName="mtmm-matrix"
      {...(provenance ? { provenance } : {})}
      {...(synthetic ? { synthetic: true } : {})}
    >
      {(aria) => <EChart option={option} height={height} ariaLabel={aria} />}
    </ChartFrame>
  );
}
