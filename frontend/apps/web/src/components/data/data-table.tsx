'use client';

import {
  type ColumnHelper,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  type RowData,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  Rows3Icon,
  Rows4Icon,
  SearchIcon,
} from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ExportColumn, ExportColumnType, ExportValue } from '@/lib/export';
import { cn } from '@/lib/utils';
import { ExportMenu } from './export-menu';
import { EmptyState, ErrorState, LoadingState } from './states';

/** Per-column presentation and export metadata. */
export interface DataColumnMeta {
  /** Right-align numeric columns. */
  readonly align?: 'start' | 'end';
  /** Label in the column-visibility menu and export header (defaults to the header string). */
  readonly label?: string;
  /** Export value (defaults to the accessor value; display-only columns are skipped). */
  readonly exportValue?: (row: unknown) => ExportValue;
  readonly exportType?: ExportColumnType;
  /** Exclude from exports (e.g. action buttons). */
  readonly noExport?: boolean;
  /** Mono font (ids, hashes). */
  readonly mono?: boolean;
}

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta: metaHelper<DataColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataColumns<T extends RowData> = ReturnType<
  ColumnHelper<DataTableFeatures, T>['columns']
>;

/** Typed column helper bound to the data-table feature set. */
export function dataColumnHelper<T extends RowData>(): ColumnHelper<DataTableFeatures, T> {
  return createColumnHelper<DataTableFeatures, T>();
}

export interface DataTableProps<T extends RowData> {
  readonly data: readonly T[] | undefined;
  readonly columns: DataColumns<T>;
  readonly getRowId: (row: T) => string;
  readonly isLoading?: boolean;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  /** Shown when there are no rows at all. */
  readonly empty?: ReactNode;
  readonly searchPlaceholder?: string;
  readonly initialSort?: { readonly id: string; readonly desc: boolean };
  readonly pageSize?: number;
  readonly initialHidden?: readonly string[];
  /** Enables the export menu (exports the filtered + sorted rows, all pages, visible columns). */
  readonly exportName?: string;
  readonly studyId?: string | null;
  readonly toolbar?: ReactNode;
  readonly onRowClick?: (row: T) => void;
  readonly caption?: string;
  readonly className?: string;
}

const EMPTY: readonly never[] = [];

/** Data-dense research table: sort, search, column visibility, density, pagination, export. */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  isLoading,
  error,
  onRetry,
  empty,
  searchPlaceholder = 'Search…',
  initialSort,
  pageSize = 25,
  initialHidden,
  exportName,
  studyId = null,
  toolbar,
  onRowClick,
  caption,
  className,
}: DataTableProps<T>) {
  const rows = (data ?? EMPTY) as T[];
  const [dense, setDense] = useState(true);
  const searchId = useId();
  const initialState = useMemo(
    () => ({
      sorting: initialSort ? [{ ...initialSort }] : [],
      pagination: { pageIndex: 0, pageSize },
      columnVisibility: Object.fromEntries((initialHidden ?? []).map((id) => [id, false])),
      globalFilter: '',
    }),
    [initialSort, pageSize, initialHidden],
  );
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: rows,
    getRowId: (row: T) => getRowId(row),
    initialState,
    globalFilterFn: 'includesString',
    enableSortingRemoval: true,
  });

  const globalFilter = (table.state.globalFilter as string | undefined) ?? '';
  const filteredRows = table.getSortedRowModel().rows;

  // Recomputed each render so it follows column visibility (cheap: one entry per column).
  const exportColumns: ExportColumn<T>[] = !exportName
    ? []
    : table
        .getVisibleLeafColumns()
        .filter(
          (c) => !c.columnDef.meta?.noExport && (c.accessorFn || c.columnDef.meta?.exportValue),
        )
        .map((c) => {
          const meta = c.columnDef.meta;
          const header =
            meta?.label ?? (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id);
          return {
            key: c.id,
            header,
            ...(meta?.exportType ? { type: meta.exportType } : {}),
            value: (row: T) => {
              if (meta?.exportValue) return meta.exportValue(row);
              const v = c.accessorFn?.(row, 0);
              if (v === null || v === undefined) return null;
              if (
                typeof v === 'string' ||
                typeof v === 'number' ||
                typeof v === 'boolean' ||
                v instanceof Date
              ) {
                return v;
              }
              return JSON.stringify(v);
            },
          };
        });

  if (isLoading) return <LoadingState className={className} />;
  if (error)
    return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} className={className} />;
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="No records yet" className={className} />}</>;
  }

  const pageCount = table.getPageCount();
  const { pageIndex, pageSize: size } = table.state.pagination;
  const first = filteredRows.length === 0 ? 0 : pageIndex * size + 1;
  const last = Math.min(filteredRows.length, (pageIndex + 1) * size);

  return (
    <div data-slot="data-table" className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <label htmlFor={searchId} className="sr-only">
            Search table
          </label>
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            id={searchId}
            value={globalFilter}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-8"
          />
        </div>
        {toolbar}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={dense ? 'Comfortable rows' : 'Compact rows'}
            title={dense ? 'Comfortable rows' : 'Compact rows'}
            onClick={() => setDense((d) => !d)}
          >
            {dense ? <Rows3Icon /> : <Rows4Icon />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon aria-hidden="true" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">Visible columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onCheckedChange={(v) => c.toggleVisibility(v === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {c.columnDef.meta?.label ??
                      (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {exportName && (
            <ExportMenu
              dataset={exportName}
              rows={filteredRows.map((r) => r.original)}
              columns={exportColumns}
              studyId={studyId}
            />
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(meta?.align === 'end' && 'text-right')}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            'inline-flex items-center gap-1 hover:text-foreground',
                            meta?.align === 'end' && 'flex-row-reverse',
                          )}
                        >
                          <table.FlexRender header={header} />
                          {sorted === 'asc' ? (
                            <ArrowUpIcon className="size-3" aria-hidden="true" />
                          ) : sorted === 'desc' ? (
                            <ArrowDownIcon className="size-3" aria-hidden="true" />
                          ) : (
                            <ArrowUpDownIcon className="size-3 opacity-40" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  className="py-8 text-center text-muted-foreground"
                >
                  No rows match “{globalFilter}”.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && 'cursor-pointer')}
                  {...(onRowClick
                    ? {
                        onClick: () => onRowClick(row.original),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter') onRowClick(row.original);
                        },
                        tabIndex: 0,
                      }
                    : {})}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          dense ? 'py-1' : 'py-2.5',
                          meta?.align === 'end' && 'text-right',
                          meta?.mono && 'font-mono text-xs',
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          {first}–{last} of {filteredRows.length.toLocaleString('en-IN')}
          {filteredRows.length !== rows.length &&
            ` (filtered from ${rows.length.toLocaleString('en-IN')})`}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="px-2 tabular-nums">
            Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
