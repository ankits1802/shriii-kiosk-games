'use client';

import { DownloadIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth/auth-context';
import {
  type ExportAuditSink,
  type ExportColumn,
  type ExportFormat,
  exportRows,
  justificationThreshold,
  MIN_JUSTIFICATION_LENGTH,
  needsJustification,
} from '@/lib/export';

/**
 * Where export records go. The default writes a structured console record; deployments wire a
 * sink that posts to the API audit log (see frontend/apps/web README, "Export audit").
 */
const consoleSink: ExportAuditSink = {
  record(entry) {
    console.info('[export-audit]', JSON.stringify(entry));
  },
};

const ExportAuditContext = createContext<ExportAuditSink>(consoleSink);

export function ExportAuditProvider({
  sink,
  children,
}: {
  readonly sink: ExportAuditSink;
  readonly children: ReactNode;
}) {
  return <ExportAuditContext.Provider value={sink}>{children}</ExportAuditContext.Provider>;
}

export interface ExportMenuProps<T> {
  /** Dataset name used in the file name and audit record. */
  readonly dataset: string;
  readonly rows: readonly T[];
  readonly columns: readonly ExportColumn<T>[];
  readonly studyId?: string | null;
  readonly provenance?: Readonly<Record<string, string>>;
  readonly formats?: readonly ExportFormat[];
  readonly disabled?: boolean;
  readonly size?: 'sm' | 'default';
  readonly label?: string;
}

/** CSV/Parquet export with the governance justification step for large exports. */
export function ExportMenu<T>({
  dataset,
  rows,
  columns,
  studyId = null,
  provenance,
  formats = ['csv', 'parquet'],
  disabled,
  size = 'sm',
  label = 'Export',
}: ExportMenuProps<T>) {
  const sink = useContext(ExportAuditContext);
  const { principal } = useAuth();
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [justification, setJustification] = useState('');
  const fieldId = useId();
  const threshold = justificationThreshold();
  const required = needsJustification(rows.length, threshold);

  const run = async (format: ExportFormat, why: string | null) => {
    try {
      const record = await exportRows(
        {
          dataset,
          format,
          rows,
          columns,
          studyId,
          actor: principal?.sub ?? null,
          justification: why,
          threshold,
          ...(provenance ? { provenance } : {}),
        },
        sink,
      );
      toast.success(`Exported ${record.rowCount} rows`, { description: record.fileName });
    } catch (err) {
      toast.error('Export failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const choose = (format: ExportFormat) => {
    if (required) {
      setJustification('');
      setPending(format);
    } else {
      void run(format, null);
    }
  };

  const valid = justification.trim().length >= MIN_JUSTIFICATION_LENGTH;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size={size} disabled={disabled || rows.length === 0}>
            <DownloadIcon aria-hidden="true" />
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {rows.length.toLocaleString('en-IN')} rows · {columns.length} columns
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {formats.includes('csv') && (
            <DropdownMenuItem onSelect={() => choose('csv')}>CSV (UTF-8)</DropdownMenuItem>
          )}
          {formats.includes('parquet') && (
            <DropdownMenuItem onSelect={() => choose('parquet')}>Parquet</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Why is this export needed?</DialogTitle>
            <DialogDescription>
              Exports over {threshold} rows need a justification. It is stored with the export
              record and written into the file metadata.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>Justification</Label>
            <Textarea
              id={fieldId}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="e.g. Pre-registered reliability analysis for the Stage 2 pilot (H3)."
              aria-describedby={`${fieldId}-hint`}
            />
            <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
              At least {MIN_JUSTIFICATION_LENGTH} characters.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={!valid}
              onClick={() => {
                const format = pending;
                setPending(null);
                if (format) void run(format, justification.trim());
              }}
            >
              Export {pending === 'parquet' ? 'Parquet' : 'CSV'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
