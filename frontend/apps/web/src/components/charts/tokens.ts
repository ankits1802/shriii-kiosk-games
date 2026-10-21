/**
 * Chart tokens, read from the CSS custom properties in globals.css so charts follow the light/dark
 * theme. Categorical slots are used in fixed order (the order is the colour-vision-deficiency
 * safety mechanism) and are never cycled: scatter-type charts cap at 3 identity colours and fold
 * the rest into "Other".
 */

export type SeriesPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export interface ChartTokens {
  readonly surface: string;
  readonly ink: string;
  readonly inkSecondary: string;
  readonly inkMuted: string;
  readonly grid: string;
  readonly axis: string;
  /** Eight categorical slots, fixed order. */
  readonly series: SeriesPalette;
  readonly divergingNeg: string;
  readonly divergingMid: string;
  readonly divergingPos: string;
  readonly seqLow: string;
  readonly seqHigh: string;
  readonly statusGood: string;
  readonly statusWarning: string;
  readonly statusSerious: string;
  readonly statusCritical: string;
  readonly fontFamily: string;
}

export const LIGHT_TOKENS: ChartTokens = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  inkMuted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  divergingNeg: '#1c5cab',
  divergingMid: '#f0efec',
  divergingPos: '#c23b3a',
  seqLow: '#cde2fb',
  seqHigh: '#0d366b',
  statusGood: '#0ca30c',
  statusWarning: '#fab219',
  statusSerious: '#ec835a',
  statusCritical: '#d03b3b',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
};

/** Max identity colours on scatter/dot charts (all-pairs CVD validation passes for 3 slots). */
export const SCATTER_SERIES_CAP = 3;
/** Max identity colours on bars/lines (adjacent-pairs validation passes for all 8). */
export const SERIES_CAP = 8;

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

export function readChartTokens(element?: Element): ChartTokens {
  if (typeof window === 'undefined') return LIGHT_TOKENS;
  const style = window.getComputedStyle(element ?? document.documentElement);
  const f = LIGHT_TOKENS;
  return {
    surface: cssVar(style, '--chart-surface', f.surface),
    ink: cssVar(style, '--chart-ink', f.ink),
    inkSecondary: cssVar(style, '--chart-ink-secondary', f.inkSecondary),
    inkMuted: cssVar(style, '--chart-ink-muted', f.inkMuted),
    grid: cssVar(style, '--chart-grid', f.grid),
    axis: cssVar(style, '--chart-axis', f.axis),
    series: f.series.map((fallback, i) =>
      cssVar(style, `--series-${i + 1}`, fallback),
    ) as unknown as SeriesPalette,
    divergingNeg: cssVar(style, '--diverging-neg', f.divergingNeg),
    divergingMid: cssVar(style, '--diverging-mid', f.divergingMid),
    divergingPos: cssVar(style, '--diverging-pos', f.divergingPos),
    seqLow: cssVar(style, '--seq-low', f.seqLow),
    seqHigh: cssVar(style, '--seq-high', f.seqHigh),
    statusGood: cssVar(style, '--status-good', f.statusGood),
    statusWarning: cssVar(style, '--status-warning', f.statusWarning),
    statusSerious: cssVar(style, '--status-serious', f.statusSerious),
    statusCritical: cssVar(style, '--status-critical', f.statusCritical),
    fontFamily: f.fontFamily,
  };
}

/** Colour for the i-th identity (fixed order); beyond `cap` everything is the muted "Other" ink. */
export function seriesColor(tokens: ChartTokens, index: number, cap = SERIES_CAP): string {
  if (index < 0 || index >= Math.min(cap, tokens.series.length)) return tokens.inkMuted;
  return tokens.series[index] as string;
}

/** Map distinct group names to colours in first-seen order, folding overflow into "Other". */
export function assignGroupColors(
  groups: readonly string[],
  tokens: ChartTokens,
  cap: number,
): { readonly color: Map<string, string>; readonly folded: ReadonlySet<string> } {
  const color = new Map<string, string>();
  const folded = new Set<string>();
  let i = 0;
  for (const g of groups) {
    if (color.has(g)) continue;
    if (i < cap) {
      color.set(g, seriesColor(tokens, i, cap));
      i += 1;
    } else {
      color.set(g, tokens.inkMuted);
      folded.add(g);
    }
  }
  return { color, folded };
}
