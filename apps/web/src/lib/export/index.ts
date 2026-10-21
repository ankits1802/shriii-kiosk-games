/**
 * Export helper: CSV or Parquet from typed rows, with governance hooks.
 *
 * - Exports above a row threshold require a written justification (PRV-08 "Exports over 50 rows
 *   need a justification"); the threshold is deployment configuration
 *   (`NEXT_PUBLIC_EXPORT_JUSTIFICATION_ROWS`).
 * - Every export is reported to an {@link ExportAuditSink} with who/what/why so it can be recorded
 *   server side (see requests_outside_scope: an API endpoint for client export audit records).
 */
import { toCsv } from './csv';
import { toParquet } from './parquet';
import { type ExportColumn, exportFileName } from './tabular';

export { toCsv } from './csv';
export { toParquet } from './parquet';
export type { ExportColumn, ExportColumnType, ExportValue } from './tabular';
export { columnsFromRecords, exportFileName } from './tabular';

export type ExportFormat = 'csv' | 'parquet';

export interface ExportRecord {
  readonly dataset: string;
  readonly format: ExportFormat;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly fileName: string;
  readonly justification: string | null;
  readonly studyId: string | null;
  /** Subject of the signed-in user who exported. */
  readonly actor: string | null;
  readonly at: string;
}

export interface ExportAuditSink {
  record(entry: ExportRecord): void | Promise<void>;
}

const DEFAULT_THRESHOLD = 50;

export function justificationThreshold(): number {
  const raw = Number.parseInt(process.env.NEXT_PUBLIC_EXPORT_JUSTIFICATION_ROWS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_THRESHOLD;
}

export function needsJustification(
  rowCount: number,
  threshold = justificationThreshold(),
): boolean {
  return rowCount > threshold;
}

/** Minimum length of a justification (a sentence, not a token). */
export const MIN_JUSTIFICATION_LENGTH = 10;

export interface BuildExportInput<T> {
  readonly dataset: string;
  readonly format: ExportFormat;
  readonly rows: readonly T[];
  readonly columns: readonly ExportColumn<T>[];
  readonly justification?: string | null;
  readonly studyId?: string | null;
  readonly actor?: string | null;
  /** Provenance written into Parquet metadata (snapshot id, algorithm version, ...). */
  readonly provenance?: Readonly<Record<string, string>>;
  readonly threshold?: number;
  readonly now?: Date;
}

export class ExportJustificationError extends Error {
  override readonly name = 'ExportJustificationError';
}

/** Build the file (no I/O). Throws if a justification is required but missing. */
export function buildExport<T>(input: BuildExportInput<T>): { blob: Blob; record: ExportRecord } {
  const now = input.now ?? new Date();
  const justification = input.justification?.trim() || null;
  if (
    needsJustification(input.rows.length, input.threshold) &&
    (!justification || justification.length < MIN_JUSTIFICATION_LENGTH)
  ) {
    throw new ExportJustificationError(
      `Exports over ${input.threshold ?? justificationThreshold()} rows need a justification.`,
    );
  }
  const fileName = exportFileName(input.dataset, input.format, now);
  const blob =
    input.format === 'csv'
      ? new Blob([toCsv(input.rows, input.columns)], { type: 'text/csv;charset=utf-8' })
      : new Blob(
          [
            toParquet(input.rows, input.columns, {
              now,
              metadata: {
                'shriii.dataset': input.dataset,
                ...(input.studyId ? { 'shriii.study_id': input.studyId } : {}),
                ...(justification ? { 'shriii.justification': justification } : {}),
                ...input.provenance,
              },
            }),
          ],
          { type: 'application/vnd.apache.parquet' },
        );
  return {
    blob,
    record: {
      dataset: input.dataset,
      format: input.format,
      rowCount: input.rows.length,
      columns: input.columns.map((c) => c.key),
      fileName,
      justification,
      studyId: input.studyId ?? null,
      actor: input.actor ?? null,
      at: now.toISOString(),
    },
  };
}

/** Save a blob through a temporary object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Build, download and report an export. */
export async function exportRows<T>(
  input: BuildExportInput<T>,
  sink?: ExportAuditSink,
): Promise<ExportRecord> {
  const { blob, record } = buildExport(input);
  downloadBlob(blob, record.fileName);
  await sink?.record(record);
  return record;
}
