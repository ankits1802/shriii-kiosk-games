/**
 * Exploratory and longitudinal helpers over the snapshot frame (spec section 7: feature
 * distributions and outliers, game-version comparisons, retest trajectories). Everything here is
 * labelled exploratory in the UI; confirmatory numbers come from the validation engine.
 */
import { finite, mean, quantileSorted, sd } from '@/lib/stats/describe';
import { normalQuantile, tCritical } from '@/lib/stats/distributions';
import type { FrameRow, FrameValue } from '../api/snapshot-frame';

export interface OutlierSummary {
  readonly n: number;
  readonly missing: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly lowerFence: number;
  readonly upperFence: number;
  /** Values outside Tukey's 1.5 IQR fences. */
  readonly tukey: number;
  /** |robust z| > cutoff using the MAD (scaled by 1.4826). */
  readonly robust: number;
  readonly robustCutoff: number;
  readonly flaggedIds: readonly string[];
}

/** Tukey fences and robust-z outliers for one numeric column. */
export function outliers(
  rows: readonly FrameRow[],
  column: string,
  idColumn = 'research_id',
  robustCutoff = 3.5,
): OutlierSummary | null {
  const pairs: { id: string; v: number }[] = [];
  let missing = 0;
  for (const r of rows) {
    const v = r[column];
    if (typeof v === 'number' && Number.isFinite(v))
      pairs.push({ id: String(r[idColumn] ?? ''), v });
    else missing += 1;
  }
  if (pairs.length < 4) return null;
  const sorted = pairs.map((p) => p.v).sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const median = quantileSorted(sorted, 0.5);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = quantileSorted(deviations, 0.5) * 1.4826;
  const flagged = new Set<string>();
  let tukey = 0;
  let robust = 0;
  for (const p of pairs) {
    if (p.v < lowerFence || p.v > upperFence) {
      tukey += 1;
      flagged.add(p.id);
    }
    if (mad > 0 && Math.abs(p.v - median) / mad > robustCutoff) {
      robust += 1;
      flagged.add(p.id);
    }
  }
  return {
    n: pairs.length,
    missing,
    q1,
    median,
    q3,
    lowerFence,
    upperFence,
    tukey,
    robust,
    robustCutoff,
    flaggedIds: [...flagged].sort(),
  };
}

export interface GroupMean {
  readonly group: string;
  readonly n: number;
  readonly mean: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly sd: number | null;
}

/** Mean with a t confidence interval per group (groups sorted by label). */
export function groupMeans(
  rows: readonly FrameRow[],
  column: string,
  groupColumn: string,
  level = 0.95,
): GroupMean[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const v = r[column];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const g = r[groupColumn];
    const key = g === null || g === undefined || g === '' ? 'not recorded' : String(g);
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, values]) => {
      const n = values.length;
      const m = n ? mean(values) : Number.NaN;
      const s = n > 1 ? sd(values) : Number.NaN;
      const half = n > 1 ? tCritical(level, n - 1) * (s / Math.sqrt(n)) : Number.NaN;
      return {
        group,
        n,
        mean: Number.isFinite(m) ? m : null,
        sd: Number.isFinite(s) ? s : null,
        lower: Number.isFinite(half) ? m - half : null,
        upper: Number.isFinite(half) ? m + half : null,
      };
    });
}

export interface StandardisedDifference {
  readonly reference: string;
  readonly focal: string;
  /** Hedges' g (focal − reference) with an approximate CI. */
  readonly g: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly nReference: number;
  readonly nFocal: number;
}

/** Hedges' g between two groups with the large-sample normal CI. */
export function hedgesG(
  a: readonly number[],
  b: readonly number[],
  level = 0.95,
): {
  g: number | null;
  lower: number | null;
  upper: number | null;
} {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { g: null, lower: null, upper: null };
  const pooled = Math.sqrt(((n1 - 1) * sd(a) ** 2 + (n2 - 1) * sd(b) ** 2) / (n1 + n2 - 2));
  if (!(pooled > 0)) return { g: null, lower: null, upper: null };
  const d = (mean(b) - mean(a)) / pooled;
  const j = 1 - 3 / (4 * (n1 + n2) - 9);
  const g = d * j;
  const se = Math.sqrt((n1 + n2) / (n1 * n2) + (g * g) / (2 * (n1 + n2)));
  const z = normalQuantile(1 - (1 - level) / 2);
  return { g, lower: g - z * se, upper: g + z * se };
}

/** Standardised difference of every focal group against the first (reference) group. */
export function versionComparison(
  rows: readonly FrameRow[],
  column: string,
  groupColumn: string,
  level = 0.95,
): StandardisedDifference[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const v = r[column];
    const g = r[groupColumn];
    if (typeof v !== 'number' || !Number.isFinite(v) || g === null || g === undefined) continue;
    const list = groups.get(String(g)) ?? [];
    list.push(v);
    groups.set(String(g), list);
  }
  const keys = [...groups.keys()].sort();
  const reference = keys[0];
  if (reference === undefined) return [];
  const ref = groups.get(reference) ?? [];
  return keys.slice(1).map((focal) => {
    const f = groups.get(focal) ?? [];
    return {
      reference,
      focal,
      nReference: ref.length,
      nFocal: f.length,
      ...hedgesG(ref, f, level),
    };
  });
}

export interface PairedValue {
  readonly id: string;
  readonly first: number;
  readonly second: number;
  readonly group: string | null;
}

/** Participants measured on both occasions, keyed by research id. */
export function pairedOccasions(
  rows: readonly FrameRow[],
  column: string,
  firstOccasion: string,
  secondOccasion: string,
  groupColumn?: string,
): PairedValue[] {
  const first = new Map<string, { v: number; g: FrameValue }>();
  const second = new Map<string, number>();
  for (const r of rows) {
    const v = r[column];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const id = String(r.research_id ?? '');
    if (!id) continue;
    if (r.occasion_id === firstOccasion)
      first.set(id, { v, g: groupColumn ? (r[groupColumn] ?? null) : null });
    else if (r.occasion_id === secondOccasion) second.set(id, v);
  }
  const out: PairedValue[] = [];
  for (const [id, a] of first) {
    const b = second.get(id);
    if (b !== undefined)
      out.push({ id, first: a.v, second: b, group: a.g === null ? null : String(a.g) });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

export interface TrajectorySummary {
  readonly n: number;
  readonly meanChange: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  /** Standardised mean change (d_z): mean change / SD of change. */
  readonly dz: number | null;
  readonly improved: number;
  readonly declined: number;
}

export function trajectorySummary(pairs: readonly PairedValue[], level = 0.95): TrajectorySummary {
  const diffs = pairs.map((p) => p.second - p.first);
  const n = diffs.length;
  if (n < 2) {
    return {
      n,
      meanChange: n ? (diffs[0] ?? null) : null,
      lower: null,
      upper: null,
      dz: null,
      improved: 0,
      declined: 0,
    };
  }
  const m = mean(diffs);
  const s = sd(diffs);
  const half = tCritical(level, n - 1) * (s / Math.sqrt(n));
  return {
    n,
    meanChange: m,
    lower: m - half,
    upper: m + half,
    dz: s > 0 ? m / s : null,
    improved: diffs.filter((d) => d > 0).length,
    declined: diffs.filter((d) => d < 0).length,
  };
}

/**
 * Display-only construct composite: mean of z-scored indicator columns, sign-keyed so higher means
 * more of the construct (`direction: higher_less` indicators are reversed). Requires at least half
 * of the indicators per row. Figures that use it say so; engine composites feed every estimate.
 */
export function keyedComposite(
  rows: readonly FrameRow[],
  columns: readonly { column: string; reverse: boolean }[],
): (number | null)[] {
  const stats = columns.map(({ column }) => {
    const values = finite(
      rows.map((r) => (typeof r[column] === 'number' ? (r[column] as number) : null)),
    );
    return { m: mean(values), s: sd(values) };
  });
  const minPresent = Math.max(1, Math.ceil(columns.length / 2));
  return rows.map((r) => {
    let sum = 0;
    let k = 0;
    columns.forEach(({ column, reverse }, i) => {
      const v = r[column];
      const st = stats[i];
      if (typeof v !== 'number' || !Number.isFinite(v) || !st || !(st.s > 0)) return;
      const z = (v - st.m) / st.s;
      sum += reverse ? -z : z;
      k += 1;
    });
    return k >= minPresent ? sum / k : null;
  });
}

/** Distinct non-null values of a design column, sorted. */
export function levels(rows: readonly FrameRow[], column: string): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const v = r[column];
    if (v !== null && v !== undefined && v !== '') out.add(String(v));
  }
  return [...out].sort();
}
