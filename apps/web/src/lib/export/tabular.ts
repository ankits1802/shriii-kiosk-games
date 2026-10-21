/**
 * Column specification shared by the CSV and Parquet writers and by `DataTable` exports.
 */

export type ExportValue = string | number | boolean | Date | null | undefined;

export type ExportColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'timestamp';

export interface ExportColumn<T> {
  /** Machine column name (Parquet field / CSV header when `header` is omitted). */
  readonly key: string;
  /** Human header for CSV. */
  readonly header?: string;
  readonly value: (row: T) => ExportValue;
  /** Declared type; inferred from the first non-null value when omitted. */
  readonly type?: ExportColumnType;
}

export function inferType(values: readonly ExportValue[]): ExportColumnType {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean') return 'boolean';
    if (v instanceof Date) return 'timestamp';
    if (typeof v === 'number') {
      return values.every(
        (x) => x === null || x === undefined || (typeof x === 'number' && Number.isInteger(x)),
      )
        ? 'integer'
        : 'number';
    }
    return 'string';
  }
  return 'string';
}

/** Build columns from plain objects (keys of the first row), for quick exports of API rows. */
export function columnsFromRecords<T extends Record<string, unknown>>(
  rows: readonly T[],
): ExportColumn<T>[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const k of Object.keys(row)) keys.add(k);
  return [...keys].map((key) => ({
    key,
    value: (row: T) => {
      const v = row[key];
      if (v === null || v === undefined) return null;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      if (v instanceof Date) return v;
      return JSON.stringify(v);
    },
  }));
}

/** `shriii_<dataset>_<yyyymmdd>T<hhmm>Z.<ext>`; dataset is slugged to [a-z0-9_-]. */
export function exportFileName(
  dataset: string,
  extension: 'csv' | 'parquet',
  at = new Date(),
): string {
  const slug =
    dataset
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'export';
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}T${iso.slice(11, 16).replace(':', '')}Z`;
  return `shriii_${slug}_${stamp}.${extension}`;
}
