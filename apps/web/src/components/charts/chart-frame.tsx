'use client';

import { ChartColumnIcon, TableIcon } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { ExportMenu } from '@/components/data/export-menu';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ExportColumn } from '@/lib/export';
import { formatDateTime, formatInteger, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ChartTable, ChartTableCell } from './options/table';

/**
 * Provenance shown under every statistical figure (definition of done 6: N, uncertainty,
 * exclusions, provenance).
 */
export interface Provenance {
  readonly n?: number;
  readonly exclusions?: number;
  readonly source?: string;
  readonly algorithmVersion?: string;
  readonly snapshotId?: string;
  readonly generatedAt?: string;
  readonly note?: string;
}

export interface ChartFrameProps {
  readonly title: string;
  readonly description?: string;
  readonly table: ChartTable;
  readonly provenance?: Provenance;
  /** Mark figures drawn from synthetic data (gallery, simulator output). */
  readonly synthetic?: boolean;
  /** File/dataset name for the table export. */
  readonly exportName?: string;
  readonly actions?: ReactNode;
  readonly className?: string;
  /** The chart; receives the accessible label. */
  readonly children: (ariaLabel: string) => ReactNode;
}

function cellText(value: ChartTableCell, digits?: number): string {
  if (value === null) return '—';
  if (typeof value === 'number')
    return digits === 0 ? formatInteger(value) : formatNumber(value, digits ?? 3);
  return value;
}

/** Figure shell: title, chart/table toggle, export, provenance footer. */
export function ChartFrame({
  title,
  description,
  table,
  provenance,
  synthetic,
  exportName,
  actions,
  className,
  children,
}: ChartFrameProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const titleId = useId();
  const exportColumns = useMemo<ExportColumn<Readonly<Record<string, ChartTableCell>>>[]>(
    () =>
      table.columns.map((c) => ({
        key: c.key,
        header: c.header,
        value: (row) => row[c.key] ?? null,
        ...(c.numeric ? { type: 'number' as const } : {}),
      })),
    [table.columns],
  );
  const ariaLabel = `${title}${description ? `. ${description}` : ''}`;

  return (
    <figure
      aria-labelledby={titleId}
      data-slot="chart-frame"
      className={cn('flex flex-col gap-3 rounded-lg border bg-chart-surface p-4', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="text-sm font-semibold">
              {title}
            </h3>
            {synthetic && (
              <Badge variant="warning" title="Generated data, not study data">
                Synthetic data
              </Badge>
            )}
          </div>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
          <fieldset aria-label="View" className="inline-flex rounded-md border p-0.5">
            <button
              type="button"
              aria-pressed={view === 'chart'}
              onClick={() => setView('chart')}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs aria-pressed:bg-muted aria-pressed:font-medium"
            >
              <ChartColumnIcon className="size-3.5" aria-hidden="true" />
              Chart
            </button>
            <button
              type="button"
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs aria-pressed:bg-muted aria-pressed:font-medium"
            >
              <TableIcon className="size-3.5" aria-hidden="true" />
              Table
            </button>
          </fieldset>
          <ExportMenu
            dataset={exportName ?? title}
            rows={table.rows}
            columns={exportColumns}
            formats={['csv']}
            label="CSV"
            {...(provenance?.snapshotId
              ? { provenance: { 'shriii.snapshot_id': provenance.snapshotId } }
              : {})}
          />
        </div>
      </div>
      {view === 'chart' ? (
        children(ariaLabel)
      ) : (
        <div className="max-h-[420px] overflow-auto rounded-md border bg-card">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                {table.columns.map((c) => (
                  <TableHead key={c.key} className={c.numeric ? 'text-right' : undefined}>
                    {c.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: chart table rows have no identity
                <TableRow key={i}>
                  {table.columns.map((c) => (
                    <TableCell key={c.key} className={c.numeric ? 'text-right' : undefined}>
                      {cellText(row[c.key] ?? null, c.digits)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {provenance && <ProvenanceLine provenance={provenance} />}
    </figure>
  );
}

export function ProvenanceLine({ provenance }: { readonly provenance: Provenance }) {
  const parts: string[] = [];
  if (provenance.n !== undefined) parts.push(`N = ${formatInteger(provenance.n)}`);
  if (provenance.exclusions !== undefined)
    parts.push(`${formatInteger(provenance.exclusions)} excluded`);
  if (provenance.source) parts.push(provenance.source);
  if (provenance.algorithmVersion) parts.push(`algorithm ${provenance.algorithmVersion}`);
  if (provenance.snapshotId) parts.push(`snapshot ${provenance.snapshotId}`);
  if (provenance.generatedAt) parts.push(`generated ${formatDateTime(provenance.generatedAt)}`);
  return (
    <figcaption className="text-xs text-muted-foreground">
      {parts.join(' · ')}
      {provenance.note && <span className="block">{provenance.note}</span>}
    </figcaption>
  );
}
