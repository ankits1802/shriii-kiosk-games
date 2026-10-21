/**
 * Bland–Altman plot for test–retest agreement: mean of the two occasions vs their difference
 * (retest − test), with the bias line and 95 % limits of agreement, each with its CI as a wash.
 */
import type { EChartsOption, MarkAreaComponentOption } from 'echarts';
import { formatNumber } from '@/lib/format';
import { type BlandAltmanResult, blandAltman, type PairedValue } from '@/lib/stats/agreement';
import type { ChartTokens } from '../tokens';
import { baseOption, valueAxis } from './base';
import { type ChartTable, round } from './table';

export interface BlandAltmanInput {
  readonly pairs: readonly PairedValue[];
  /** Name of the measure, e.g. "Commission error rate". */
  readonly measure: string;
  readonly level?: number;
  /** Server-computed statistics to draw instead of the client computation. */
  readonly resultOverride?: BlandAltmanResult;
}

export function blandAltmanResult(input: BlandAltmanInput): BlandAltmanResult | null {
  return input.resultOverride ?? blandAltman(input.pairs, input.level ?? 0.95);
}

export function blandAltmanOption(input: BlandAltmanInput, tokens: ChartTokens): EChartsOption {
  const result = blandAltmanResult(input);
  const points = result?.points ?? [];
  const pct = Math.round((input.level ?? 0.95) * 100);
  const line = (value: number, label: string, strong: boolean) => ({
    yAxis: value,
    name: label,
    label: {
      formatter: `${label} ${formatNumber(value, 2)}`,
      color: tokens.inkSecondary,
      fontSize: 11,
      position: 'insideEndTop' as const,
    },
    lineStyle: {
      color: strong ? tokens.ink : tokens.inkSecondary,
      width: strong ? 1.5 : 1,
      type: 'solid' as const,
    },
  });
  const area = (lower: number, upper: number) =>
    [{ yAxis: lower }, { yAxis: upper }] as [{ yAxis: number }, { yAxis: number }];
  const markArea: MarkAreaComponentOption | undefined = result
    ? {
        silent: true,
        itemStyle: { color: tokens.series[0], opacity: 0.08 },
        data: [
          area(result.bias.lower, result.bias.upper),
          area(result.lowerLimit.lower, result.lowerLimit.upper),
          area(result.upperLimit.lower, result.upperLimit.upper),
        ],
      }
    : undefined;
  return {
    ...baseOption(
      tokens,
      result
        ? `Bland–Altman plot for ${input.measure}, n = ${result.n}. Bias ${formatNumber(result.bias.estimate, 2)}, ${pct}% limits of agreement ${formatNumber(result.lowerLimit.estimate, 2)} to ${formatNumber(result.upperLimit.estimate, 2)}.`
        : `Bland–Altman plot for ${input.measure}: not enough pairs.`,
    ),
    grid: { left: 16, right: 24, top: 16, bottom: 40, containLabel: true },
    xAxis: valueAxis(tokens, `Mean of test and retest (${input.measure})`, { nameGap: 28 }),
    yAxis: valueAxis(tokens, 'Retest − test', { nameGap: 40 }),
    tooltip: {
      ...(baseOption(tokens, '').tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { name: string; value: [number, number] };
        return `${p.name ? `${p.name}<br/>` : ''}Mean: ${formatNumber(p.value[0], 2)}<br/>Difference: ${formatNumber(p.value[1], 2)}`;
      },
    },
    series: [
      {
        type: 'scatter',
        name: 'Pairs',
        symbolSize: 8,
        itemStyle: {
          color: tokens.series[0],
          borderColor: tokens.surface,
          borderWidth: 2,
          opacity: 0.85,
        },
        data: points.map((p) => ({ value: [p.mean, p.difference], name: p.id ?? '' })),
        ...(result
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                animation: false,
                data: [
                  line(result.bias.estimate, 'Bias', true),
                  line(result.lowerLimit.estimate, `Lower ${pct}% LoA`, false),
                  line(result.upperLimit.estimate, `Upper ${pct}% LoA`, false),
                ],
              },
              ...(markArea ? { markArea } : {}),
            }
          : {}),
      },
    ],
  };
}

export function blandAltmanTable(input: BlandAltmanInput): ChartTable {
  const hasIds = input.pairs.some((p) => p.id);
  return {
    columns: [
      ...(hasIds ? [{ key: 'id', header: 'ID' }] : []),
      { key: 'first', header: 'Test', numeric: true },
      { key: 'second', header: 'Retest', numeric: true },
      { key: 'mean', header: 'Mean', numeric: true },
      { key: 'difference', header: 'Retest − test', numeric: true },
    ],
    rows: input.pairs.map((p) => ({
      ...(hasIds ? { id: p.id ?? null } : {}),
      first: round(p.first, 4),
      second: round(p.second, 4),
      mean: round((p.first + p.second) / 2, 4),
      difference: round(p.second - p.first, 4),
    })),
  };
}
