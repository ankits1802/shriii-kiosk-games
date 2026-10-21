/** The data-table view every chart offers (accessibility + exact values + CSV export). */

export interface ChartTableColumn {
  readonly key: string;
  readonly header: string;
  /** Right-align and format numerically. */
  readonly numeric?: boolean;
  readonly digits?: number;
}

export type ChartTableCell = string | number | null;

export interface ChartTable {
  readonly columns: readonly ChartTableColumn[];
  readonly rows: readonly Readonly<Record<string, ChartTableCell>>[];
}

export function round(value: number | null | undefined, digits = 3): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
