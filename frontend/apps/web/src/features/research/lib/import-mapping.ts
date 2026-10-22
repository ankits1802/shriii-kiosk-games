/**
 * CSV/XLSX import of historical questionnaire data (spec section 5): column mapping and the client-side
 * pre-check before the file is staged. The API re-validates every row and sends ambiguous rows to the
 * manual-review queue (POST /assessment-responses/imports); this only catches mapping mistakes early.
 *
 * Mapping keys follow the API's ImportSpec: `pid`, `item:<response id>`, `expected:<response id>`.
 */
import type { PlanItem, ResponseScale } from './administration';

export interface CsvPreview {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
  readonly delimiter: ',' | ';' | '\t';
}

function detectDelimiter(line: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch] += 1;
  }
  const best = (Object.entries(counts) as [',' | ';' | '\t', number][]).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF), enough for preview and checks. */
export function parseCsv(text: string, maxRows = 200): CsvPreview {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let total = 0;
  const push = () => {
    record.push(field);
    field = '';
  };
  const end = () => {
    push();
    if (record.length > 1 || record[0] !== '') {
      total += 1;
      if (records.length <= maxRows) records.push(record);
    }
    record = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) push();
    else if (ch === '\n') end();
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      end();
    } else field += ch;
  }
  if (field !== '' || record.length > 0) end();
  const [headers = [], ...rows] = records;
  return {
    headers: headers.map((h) => h.trim()),
    rows,
    totalRows: Math.max(0, total - 1),
    delimiter,
  };
}

const PID_PATTERNS = [
  /^pid$/i,
  /^participant[_ ]?(id|pid)?$/i,
  /^p[_ ]?id$/i,
  /^research[_ ]?pid$/i,
];

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-.]+/g, '');
}

/**
 * Suggest a mapping from file headers: the pid column, each response id by exact id or by item
 * number (`Q3`, `item3`, `i03`, `3`), and `expected_<id>` / `<id>_expected` key columns.
 */
export function suggestMapping(
  headers: readonly string[],
  items: readonly PlanItem[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  const pid = headers.find((h) => PID_PATTERNS.some((p) => p.test(h.trim())));
  if (pid) {
    mapping.pid = pid;
    used.add(pid);
  }
  const byNorm = new Map(headers.map((h) => [normaliseHeader(h), h]));
  for (const item of items) {
    const candidates = [
      item.responseId,
      item.measure ? `${item.number}.${item.measure}` : null,
      item.measure ? `p${item.number}${item.measure}` : null,
      item.measure ? null : `q${item.number}`,
      item.measure ? null : `item${item.number}`,
      item.measure ? null : `i${String(item.number).padStart(2, '0')}`,
      item.measure ? null : `i${item.number}`,
      item.measure ? null : String(item.number),
    ].filter((c): c is string => c !== null);
    for (const c of candidates) {
      const h = byNorm.get(normaliseHeader(c));
      if (h && !used.has(h)) {
        mapping[`item:${item.responseId}`] = h;
        used.add(h);
        break;
      }
    }
    if (item.attentionCheck || item.needsKey) {
      for (const c of [`expected_${item.responseId}`, `${item.responseId}_expected`]) {
        const h = byNorm.get(normaliseHeader(c));
        if (h && !used.has(h)) {
          mapping[`expected:${item.responseId}`] = h;
          used.add(h);
          break;
        }
      }
    }
  }
  return mapping;
}

export type CheckSeverity = 'error' | 'warning';

export interface MappingCheck {
  readonly severity: CheckSeverity;
  readonly message: string;
  readonly row?: number;
  readonly column?: string;
}

/** Mapping and value checks over the preview rows (row numbers are 1-based data rows). */
export function checkImport(
  preview: CsvPreview,
  mapping: Readonly<Record<string, string>>,
  items: readonly PlanItem[],
  scale: ResponseScale,
): MappingCheck[] {
  const checks: MappingCheck[] = [];
  const col = new Map(preview.headers.map((h, i) => [h, i]));
  if (!mapping.pid)
    checks.push({ severity: 'error', message: 'Map the participant id (pid) column.' });
  const seen = new Map<string, string>();
  for (const [key, column] of Object.entries(mapping)) {
    if (!column) continue;
    if (!col.has(column))
      checks.push({ severity: 'error', message: `Column "${column}" is not in the file.`, column });
    const prev = seen.get(column);
    if (prev)
      checks.push({
        severity: 'error',
        message: `Column "${column}" is mapped twice (${prev}, ${key}).`,
        column,
      });
    seen.set(column, key);
  }
  const mappedItems = items.filter((i) => mapping[`item:${i.responseId}`]);
  if (mappedItems.length === 0)
    checks.push({ severity: 'error', message: 'Map at least one item column.' });
  const unmapped = items.filter((i) => !mapping[`item:${i.responseId}`]);
  if (unmapped.length > 0 && mappedItems.length > 0)
    checks.push({
      severity: 'warning',
      message: `${unmapped.length} item(s) are not mapped and will be stored as missing: ${unmapped
        .slice(0, 6)
        .map((i) => i.responseId)
        .join(', ')}${unmapped.length > 6 ? '…' : ''}`,
    });
  for (const i of mappedItems) {
    if (i.needsKey && !mapping[`expected:${i.responseId}`])
      checks.push({
        severity: 'error',
        message: `${i.responseId} needs an expected (minimum moves) column from the administration file.`,
      });
  }
  const unused = preview.headers.filter((h) => !seen.has(h));
  if (unused.length)
    checks.push({
      severity: 'warning',
      message: `${unused.length} column(s) are not mapped and will be ignored: ${unused.slice(0, 6).join(', ')}${unused.length > 6 ? '…' : ''}`,
    });
  const pidIdx = mapping.pid ? col.get(mapping.pid) : undefined;
  const pids = new Map<string, number>();
  preview.rows.forEach((row, r) => {
    const rowNo = r + 1;
    if (pidIdx !== undefined) {
      const pid = (row[pidIdx] ?? '').trim();
      if (!pid)
        checks.push({
          severity: 'warning',
          message: 'Empty participant id (goes to manual review).',
          row: rowNo,
        });
      else if (pids.has(pid))
        checks.push({
          severity: 'warning',
          message: `Participant ${pid} also appears on row ${pids.get(pid)} (duplicate goes to manual review).`,
          row: rowNo,
        });
      else pids.set(pid, rowNo);
    }
    for (const i of mappedItems) {
      const idx = col.get(mapping[`item:${i.responseId}`] ?? '');
      if (idx === undefined) continue;
      const raw = (row[idx] ?? '').trim();
      if (raw === '' || /^(na|n\/a|\.|-)$/i.test(raw)) continue;
      const v = Number(raw);
      const bad =
        !Number.isFinite(v) ||
        (i.measure === null &&
          ((scale.min !== null && v < scale.min) || (scale.max !== null && v > scale.max)));
      if (bad)
        checks.push({
          severity: 'warning',
          message: `${i.responseId} = "${raw}" is outside the response scale (row goes to manual review).`,
          row: rowNo,
          column: mapping[`item:${i.responseId}`] ?? '',
        });
    }
  });
  return checks;
}

export function hasErrors(checks: readonly MappingCheck[]): boolean {
  return checks.some((c) => c.severity === 'error');
}
