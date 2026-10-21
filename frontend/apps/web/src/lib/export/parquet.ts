/**
 * Parquet writer (hyparquet-writer, pure JS, Snappy). Column types are declared or inferred; every
 * file carries provenance key/value metadata (source, generator, export time, and anything the
 * caller adds such as snapshot id or algorithm version).
 */
import { parquetWriteBuffer } from 'hyparquet-writer';
import { type ExportColumn, type ExportColumnType, type ExportValue, inferType } from './tabular';

export interface ParquetOptions {
  /** Extra key/value metadata (provenance). */
  readonly metadata?: Readonly<Record<string, string>>;
  readonly now?: Date;
}

type ParquetBasicType = 'STRING' | 'DOUBLE' | 'INT32' | 'BOOLEAN' | 'TIMESTAMP';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function basicType(type: ExportColumnType, values: readonly ExportValue[]): ParquetBasicType {
  switch (type) {
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'integer':
      return values.every(
        (v) =>
          v === null ||
          v === undefined ||
          (typeof v === 'number' && v >= INT32_MIN && v <= INT32_MAX),
      )
        ? 'INT32'
        : 'DOUBLE';
    case 'number':
      return 'DOUBLE';
    default:
      return 'STRING';
  }
}

function coerce(
  value: ExportValue,
  type: ParquetBasicType,
): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'STRING':
      return value instanceof Date ? value.toISOString() : String(value);
    case 'DOUBLE':
    case 'INT32': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : value === 'true';
    case 'TIMESTAMP': {
      const d = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
}

export function toParquet<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  options: ParquetOptions = {},
): ArrayBuffer {
  if (columns.length === 0) throw new Error('A Parquet export needs at least one column.');
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.key)) throw new Error(`Duplicate export column "${c.key}"`);
    seen.add(c.key);
  }
  const columnData = columns.map((column) => {
    const raw = rows.map((r) => column.value(r));
    const type = basicType(column.type ?? inferType(raw), raw);
    return { name: column.key, data: raw.map((v) => coerce(v, type)), type };
  });
  const metadata: Record<string, string> = {
    'shriii.generator': 'frontend/apps/web export',
    'shriii.exported_at': (options.now ?? new Date()).toISOString(),
    'shriii.row_count': String(rows.length),
    ...options.metadata,
  };
  return parquetWriteBuffer({
    columnData,
    kvMetadata: Object.entries(metadata).map(([key, value]) => ({ key, value })),
    createdBy: 'shriii-web',
  });
}
