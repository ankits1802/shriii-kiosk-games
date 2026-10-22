/**
 * Shared ECharts option fragments: recessive hairline grid/axes, text tokens (never series colours)
 * for all text, short animation, accessible descriptions.
 */
import type {
  EChartsOption,
  MarkLineComponentOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from 'echarts';
import type { ChartTokens } from '../tokens';

export type AxisOption = XAXisComponentOption & YAXisComponentOption;

export interface ReferenceLine {
  readonly value: number;
  readonly label: string;
  /** Visual weight: `target` lines are dashed-free solid secondary ink; `null` lines are muted. */
  readonly kind?: 'target' | 'null';
}

export function baseOption(tokens: ChartTokens, ariaDescription: string): EChartsOption {
  return {
    backgroundColor: 'transparent',
    animationDuration: 250,
    animationDurationUpdate: 200,
    textStyle: { fontFamily: tokens.fontFamily, color: tokens.inkSecondary, fontSize: 12 },
    aria: { enabled: true, label: { description: ariaDescription } },
    tooltip: {
      backgroundColor: tokens.surface,
      borderColor: tokens.axis,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: tokens.ink, fontSize: 12, fontFamily: tokens.fontFamily },
      extraCssText: 'box-shadow: 0 2px 8px rgba(0,0,0,0.12); border-radius: 6px;',
      confine: true,
    },
  };
}

export function valueAxis(
  tokens: ChartTokens,
  name: string,
  extra: Partial<AxisOption> = {},
): AxisOption {
  return {
    type: 'value',
    name,
    nameLocation: 'middle',
    nameGap: 32,
    nameTextStyle: { color: tokens.inkSecondary, fontSize: 12 },
    axisLine: { show: true, lineStyle: { color: tokens.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: tokens.inkMuted, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: tokens.grid, width: 1, type: 'solid' } },
    scale: true,
    ...extra,
  } as AxisOption;
}

export function categoryAxis(
  tokens: ChartTokens,
  categories: readonly string[],
  extra: Partial<AxisOption> = {},
): AxisOption {
  return {
    type: 'category',
    data: [...categories],
    axisLine: { show: true, lineStyle: { color: tokens.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: tokens.inkSecondary, fontSize: 11 },
    splitLine: { show: false },
    ...extra,
  } as AxisOption;
}

/** Mark lines for reference values (thresholds arrive from YAML/server config, never constants). */
export function referenceMarkLines(
  tokens: ChartTokens,
  lines: readonly ReferenceLine[],
  axis: 'x' | 'y',
): MarkLineComponentOption | undefined {
  if (lines.length === 0) return undefined;
  return {
    silent: true,
    symbol: 'none',
    animation: false,
    // Horizontal lines (y values): label at the left start, above the line, so it never sits on the
    // last bar group. Vertical lines (x values): label at the top end, clear of short tail bars.
    label: {
      color: tokens.inkSecondary,
      fontSize: 11,
      position: axis === 'y' ? 'insideStartTop' : 'insideEndTop',
    },
    data: lines.map((l) => ({
      [axis === 'x' ? 'xAxis' : 'yAxis']: l.value,
      name: l.label,
      label: { formatter: l.label },
      lineStyle: {
        color: l.kind === 'null' ? tokens.inkMuted : tokens.inkSecondary,
        width: 1,
        type: 'solid',
      },
    })),
  } as MarkLineComponentOption;
}

/** Spread helper: `{ markLine }` only when there is one (exactOptionalPropertyTypes-safe). */
export function withMarkLine(markLine: MarkLineComponentOption | undefined): {
  markLine?: MarkLineComponentOption;
} {
  return markLine ? { markLine } : {};
}
