'use client';

import type { EChartsOption } from 'echarts';
import { BarChart, CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { type EChartsType, init, use } from 'echarts/core';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

// Tree-shaken registration: only what the chart primitives use.
use([
  BarChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export interface EChartProps {
  readonly option: EChartsOption;
  readonly height?: number;
  /** SVG (default) is crisp and printable; canvas is faster for many thousands of points. */
  readonly renderer?: 'svg' | 'canvas';
  readonly className?: string;
  readonly ariaLabel: string;
  readonly onReady?: (chart: EChartsType) => void;
}

/** Thin ECharts wrapper: init once, `setOption(notMerge)` on change, resize with the container. */
export function EChart({
  option,
  height = 320,
  renderer = 'svg',
  className,
  ariaLabel,
  onReady,
}: EChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = init(host, undefined, { renderer });
    chartRef.current = chart;
    onReadyRef.current?.(chart);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={ariaLabel}
      data-slot="echart"
      className={cn('w-full', className)}
      style={{ height }}
    />
  );
}
