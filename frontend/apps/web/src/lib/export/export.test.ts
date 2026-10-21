import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import {
  buildExport,
  ExportJustificationError,
  exportFileName,
  needsJustification,
  toCsv,
  toParquet,
} from './index';
import { columnsFromRecords, type ExportColumn, inferType } from './tabular';

interface Row {
  readonly pid: string;
  readonly r: number | null;
  readonly n: number;
  readonly ok: boolean;
  readonly at: Date;
  readonly note: string;
}

const rows: Row[] = [
  {
    pid: 'P-1',
    r: -0.12,
    n: 120,
    ok: true,
    at: new Date('2026-10-21T10:00:00Z'),
    note: '=HYPERLINK("x")',
  },
  {
    pid: 'P-2',
    r: null,
    n: 98,
    ok: false,
    at: new Date('2026-10-20T08:30:00Z'),
    note: 'line1\nline "2", तीन',
  },
];

const columns: ExportColumn<Row>[] = [
  { key: 'pid', header: 'Participant', value: (r) => r.pid },
  { key: 'r', header: 'r', value: (r) => r.r, type: 'number' },
  { key: 'n', value: (r) => r.n },
  { key: 'ok', value: (r) => r.ok },
  { key: 'at', value: (r) => r.at },
  { key: 'note', value: (r) => r.note },
];

describe('CSV', () => {
  it('writes RFC 4180 with BOM, CRLF, quoting and formula neutralisation', () => {
    const csv = toCsv(rows, columns);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Participant,r,n,ok,at,note');
    expect(lines[1]).toBe(`P-1,-0.12,120,true,2026-10-21T10:00:00.000Z,"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('P-2,,98,false,2026-10-20T08:30:00.000Z,"line1\nline ""2"", तीन"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('can omit the BOM and use key headers', () => {
    expect(toCsv([], columns, { bom: false, headers: 'key' })).toBe('pid,r,n,ok,at,note\r\n');
  });
});

describe('Parquet', () => {
  it('round-trips typed columns and provenance metadata', async () => {
    const buffer = toParquet(rows, columns, {
      metadata: { 'shriii.snapshot_id': 'snap-1' },
      now: new Date('2026-10-21T00:00:00Z'),
    });
    const meta = parquetMetadata(buffer);
    expect(Number(meta.num_rows)).toBe(2);
    const kv = Object.fromEntries((meta.key_value_metadata ?? []).map((e) => [e.key, e.value]));
    expect(kv['shriii.snapshot_id']).toBe('snap-1');
    expect(kv['shriii.row_count']).toBe('2');
    const back = await parquetReadObjects({ file: buffer });
    expect(back[0]).toMatchObject({
      pid: 'P-1',
      r: -0.12,
      n: 120,
      ok: true,
      note: '=HYPERLINK("x")',
    });
    expect(back[1]?.r).toBeNull();
    expect(new Date(back[0]?.at as Date).toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });

  it('rejects duplicate or missing columns', () => {
    expect(() => toParquet(rows, [])).toThrow();
    expect(() =>
      toParquet(rows, [columns[0] as ExportColumn<Row>, columns[0] as ExportColumn<Row>]),
    ).toThrow(/Duplicate/);
  });
});

describe('governance', () => {
  it('requires a justification above the threshold', () => {
    expect(needsJustification(50, 50)).toBe(false);
    expect(needsJustification(51, 50)).toBe(true);
    const many = Array.from({ length: 3 }, () => rows[0] as Row);
    expect(() =>
      buildExport({ dataset: 'x', format: 'csv', rows: many, columns, threshold: 2 }),
    ).toThrow(ExportJustificationError);
    expect(() =>
      buildExport({
        dataset: 'x',
        format: 'csv',
        rows: many,
        columns,
        threshold: 2,
        justification: 'short',
      }),
    ).toThrow(ExportJustificationError);
    const { record, blob } = buildExport({
      dataset: 'Validation runs',
      format: 'parquet',
      rows: many,
      columns,
      threshold: 2,
      justification: 'Stage 2 pre-registered reliability analysis',
      actor: 'dev-researcher',
      studyId: 'S1',
      now: new Date('2026-10-21T09:05:00Z'),
    });
    expect(record).toMatchObject({
      rowCount: 3,
      fileName: 'shriii_validation-runs_20261021T0905Z.parquet',
      actor: 'dev-researcher',
      studyId: 'S1',
    });
    expect(blob.type).toBe('application/vnd.apache.parquet');
  });

  it('slugs file names', () => {
    expect(exportFileName('  ### ', 'csv', new Date('2026-01-02T03:04:00Z'))).toBe(
      'shriii_export_20260102T0304Z.csv',
    );
  });

  it('infers types and builds columns from records', () => {
    expect(inferType([null, 1, 2])).toBe('integer');
    expect(inferType([1, 2.5])).toBe('number');
    expect(inferType([new Date()])).toBe('timestamp');
    expect(inferType([undefined])).toBe('string');
    const cols = columnsFromRecords([{ a: 1, b: { nested: true } }]);
    expect(cols.map((c) => c.key)).toEqual(['a', 'b']);
    expect(cols[1]?.value({ a: 1, b: { nested: true } })).toBe('{"nested":true}');
  });
});
