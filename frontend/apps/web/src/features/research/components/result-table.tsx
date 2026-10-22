'use client';

/**
 * Compact, exportable statistics table for result rows: every row keeps its N and the table carries
 * a CSV/Parquet export of exactly what is shown (audited above the justification threshold).
 */
import { type ReactNode, useState } from 'react';
import { ExportMenu } from '@/components/data/export-menu';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ExportValue } from '@/lib/export';
import { cn } from '@/lib/utils';

export interface ResultColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Export value (omit to leave the column out of exports). */
  readonly value?: (row: T) => ExportValue;
  readonly numeric?: boolean;
  readonly className?: string;
}

export function ResultTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  exportName,
  studyId,
  empty = 'No rows.',
  className,
  title,
  actions,
  pageSize,
}: {
  readonly rows: readonly T[];
  readonly columns: readonly ResultColumn<T>[];
  readonly rowKey: (row: T, index: number) => string;
  readonly caption?: ReactNode;
  readonly exportName?: string;
  readonly studyId?: string | null;
  readonly empty?: ReactNode;
  readonly className?: string;
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  /** Show this many rows per page (exports always contain every row). */
  readonly pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const pages = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = pageSize ? rows.slice(current * pageSize, current * pageSize + pageSize) : rows;
  const exportColumns = columns
    .filter((c) => c.value)
    .map((c) => ({
      key: c.key,
      header: c.header,
      value: c.value as (row: T) => ExportValue,
      ...(c.numeric ? { type: 'number' as const } : {}),
    }));
  return (
    <div className={cn('space-y-2', className)}>
      {(title || exportName || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">{title}</div>
          <div className="flex items-center gap-1.5">
            {actions}
            {exportName && rows.length > 0 && exportColumns.length > 0 && (
              <ExportMenu
                dataset={exportName}
                rows={rows}
                columns={exportColumns}
                studyId={studyId ?? null}
                size="sm"
              />
            )}
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border bg-card">
        <Table>
          {caption && (
            <TableCaption className="whitespace-normal px-3 pb-2 text-xs">{caption}</TableCaption>
          )}
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={cn(c.numeric && 'text-right', c.className)}>
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row, i) => (
                <TableRow key={rowKey(row, i + current * (pageSize ?? 0))}>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn(c.numeric && 'text-right tabular-nums', c.className)}
                    >
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pageSize && rows.length > pageSize && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            {current * pageSize + 1}–{Math.min(rows.length, (current + 1) * pageSize)} of{' '}
            {rows.length}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
