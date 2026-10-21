'use client';

/**
 * Research chart primitives. Each one: a pure option builder (options/*.ts, unit-tested) + the
 * figure frame (title, chart/table toggle, CSV of the plotted values, provenance) + ECharts.
 */
import type { EChartsOption } from 'echarts';
import { useMemo } from 'react';
import { ChartFrame, type Provenance } from './chart-frame';
import { EChart } from './echart';
import { type BarCiInput, barCiOption, barCiTable } from './options/bar-ci';
import { type BlandAltmanInput, blandAltmanOption, blandAltmanTable } from './options/bland-altman';
import {
  type DistributionInput,
  distributionOption,
  distributionTable,
} from './options/distribution';
import { type ForestPlotInput, forestPlotOption, forestTable } from './options/forest';
import { type HeatmapInput, heatmapOption, heatmapTable } from './options/heatmap';
import { type LoadingPlotInput, loadingPlotOption, loadingTable } from './options/loadings';
import {
  type ScatterRegressionInput,
  scatterRegressionOption,
  scatterTable,
} from './options/scatter';
import type { ChartTable } from './options/table';
import type { ChartTokens } from './tokens';
import { useChartTokens } from './use-chart-tokens';

export interface FigureProps {
  readonly title: string;
  readonly description?: string;
  readonly provenance?: Provenance;
  readonly synthetic?: boolean;
  readonly height?: number;
  readonly className?: string;
  readonly exportName?: string;
}

function Figure<I>({
  input,
  build,
  tabulate,
  figure,
  defaultHeight,
}: {
  readonly input: I;
  readonly build: (input: I, tokens: ChartTokens) => EChartsOption;
  readonly tabulate: (input: I) => ChartTable;
  readonly figure: FigureProps;
  readonly defaultHeight: number;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => build(input, tokens), [build, input, tokens]);
  const table = useMemo(() => tabulate(input), [tabulate, input]);
  return (
    <ChartFrame
      title={figure.title}
      table={table}
      {...(figure.description ? { description: figure.description } : {})}
      {...(figure.provenance ? { provenance: figure.provenance } : {})}
      {...(figure.synthetic ? { synthetic: true } : {})}
      {...(figure.className ? { className: figure.className } : {})}
      {...(figure.exportName ? { exportName: figure.exportName } : {})}
    >
      {(ariaLabel) => (
        <EChart option={option} height={figure.height ?? defaultHeight} ariaLabel={ariaLabel} />
      )}
    </ChartFrame>
  );
}

export function HeatmapChart({ data, ...figure }: FigureProps & { readonly data: HeatmapInput }) {
  const height = figure.height ?? Math.max(280, 48 + data.rows.length * 32 + 64);
  return (
    <Figure
      input={data}
      build={heatmapOption}
      tabulate={heatmapTable}
      figure={{ ...figure, height }}
      defaultHeight={height}
    />
  );
}

export function ScatterRegressionChart({
  data,
  ...figure
}: FigureProps & { readonly data: ScatterRegressionInput }) {
  return (
    <Figure
      input={data}
      build={scatterRegressionOption}
      tabulate={scatterTable}
      figure={figure}
      defaultHeight={340}
    />
  );
}

export function ForestPlot({ data, ...figure }: FigureProps & { readonly data: ForestPlotInput }) {
  const height = figure.height ?? Math.max(200, 64 + data.rows.length * 28);
  return (
    <Figure
      input={data}
      build={forestPlotOption}
      tabulate={forestTable}
      figure={{ ...figure, height }}
      defaultHeight={height}
    />
  );
}

export function BarCiChart({ data, ...figure }: FigureProps & { readonly data: BarCiInput }) {
  return (
    <Figure
      input={data}
      build={barCiOption}
      tabulate={barCiTable}
      figure={figure}
      defaultHeight={320}
    />
  );
}

export function DistributionChart({
  data,
  ...figure
}: FigureProps & { readonly data: DistributionInput }) {
  return (
    <Figure
      input={data}
      build={distributionOption}
      tabulate={distributionTable}
      figure={figure}
      defaultHeight={300}
    />
  );
}

export function LoadingPlot({
  data,
  ...figure
}: FigureProps & { readonly data: LoadingPlotInput }) {
  const height = figure.height ?? Math.max(280, 48 + data.items.length * 28 + 64);
  return (
    <Figure
      input={data}
      build={loadingPlotOption}
      tabulate={loadingTable}
      figure={{ ...figure, height }}
      defaultHeight={height}
    />
  );
}

export function BlandAltmanPlot({
  data,
  ...figure
}: FigureProps & { readonly data: BlandAltmanInput }) {
  return (
    <Figure
      input={data}
      build={blandAltmanOption}
      tabulate={blandAltmanTable}
      figure={figure}
      defaultHeight={340}
    />
  );
}
