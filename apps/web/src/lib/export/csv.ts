/**
 * RFC 4180 CSV writer with spreadsheet formula-injection protection (OWASP CSV injection): text
 * cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'`. Numbers are
 * never altered, so negative values stay numeric.
 */
import type { ExportColumn, ExportValue } from './tabular';

export interface CsvOptions {
  /** Prepend a UTF-8 BOM so Excel opens Devanagari/Tamil text correctly (default true). */
  readonly bom?: boolean;
  /** Line ending (default CRLF per RFC 4180). */
  readonly newline?: '\r\n' | '\n';
  /** Header row source (default `header ?? key`). */
  readonly headers?: 'header' | 'key';
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: ExportValue): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  options: CsvOptions = {},
): string {
  const newline = options.newline ?? '\r\n';
  const head = columns
    .map((c) => csvCell(options.headers === 'key' ? c.key : (c.header ?? c.key)))
    .join(',');
  const lines = [head];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  const body = lines.join(newline) + newline;
  return (options.bom ?? true) ? `﻿${body}` : body;
}
