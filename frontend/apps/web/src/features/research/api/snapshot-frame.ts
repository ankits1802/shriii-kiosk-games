'use client';

/**
 * Row-level analysis data for figures that need individual points (scatter with regression,
 * Bland–Altman, distributions, trajectories). The source is the de-identified snapshot Parquet the
 * validation engine itself analyses (`GET /validation/datasets/{id}/download`, audited server-side):
 * research ids only, never pids or identity fields. The backend writes it with zstd compression.
 */
import { useQuery } from '@tanstack/react-query';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { toApiError } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { hasPermission } from '@/lib/auth/principal';
import type { DatasetOut } from './types';

export type FrameValue = string | number | boolean | null;
export type FrameRow = Readonly<Record<string, FrameValue>>;

export interface SnapshotFrame {
  readonly columns: readonly string[];
  readonly rows: readonly FrameRow[];
  /** `ind__<indicator id>` columns (layer 2). */
  readonly indicatorColumns: readonly string[];
  /** `crit__<instrument>.<scale>` columns (layer 3). */
  readonly criterionColumns: readonly string[];
  readonly designColumns: readonly string[];
}

function normalise(value: unknown): FrameValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Build a frame from parsed row objects (also used by tests and fixtures). */
export function frameFromRows(input: readonly Readonly<Record<string, unknown>>[]): SnapshotFrame {
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows = input.map((r) => {
    const out: Record<string, FrameValue> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
      out[k] = normalise(v);
    }
    return out;
  });
  return {
    columns,
    rows,
    indicatorColumns: columns.filter((c) => c.startsWith('ind__')),
    criterionColumns: columns.filter((c) => c.startsWith('crit__')),
    designColumns: columns.filter((c) => !c.startsWith('ind__') && !c.startsWith('crit__')),
  };
}

export async function parseSnapshotParquet(buffer: ArrayBuffer): Promise<SnapshotFrame> {
  const rows = await parquetReadObjects({ file: buffer, compressors });
  return frameFromRows(rows as Record<string, unknown>[]);
}

export function isSnapshotReadable(snapshot: Pick<DatasetOut, 'status'> | null | undefined) {
  return snapshot?.status === 'ready' || snapshot?.status === 'frozen';
}

export function useSnapshotFrame(snapshot: DatasetOut | null | undefined) {
  const api = useApi();
  const { principal } = useAuth();
  const allowed = hasPermission(principal, 'datasets.read');
  const id = snapshot?.snapshot_id ?? '';
  return useQuery({
    queryKey: ['research', 'snapshot-frame', id, snapshot?.sha256 ?? ''],
    enabled: allowed && isSnapshotReadable(snapshot),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/api/v1/validation/datasets/{snapshot_id}/download',
        { params: { path: { snapshot_id: id } }, parseAs: 'arrayBuffer' },
      );
      if (!response.ok || error !== undefined || !(data instanceof ArrayBuffer)) {
        throw toApiError(response.status, error, response.headers.get('x-request-id'));
      }
      return parseSnapshotParquet(data);
    },
  });
}

/** Finite numeric values of a column. */
export function numericColumn(rows: readonly FrameRow[], column: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[column];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Display label for a frame column (`ind__self_control.x` -> `self_control.x`). */
export function columnLabel(column: string): string {
  return column.replace(/^ind__/, '').replace(/^crit__/, '');
}
