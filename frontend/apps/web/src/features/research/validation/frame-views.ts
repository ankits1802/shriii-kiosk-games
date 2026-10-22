/**
 * Row-level views of the snapshot frame for the workbench figures (scatter, Bland–Altman).
 * Display-only composites; every estimate shown next to them is the engine's.
 */
import type { FrameRow, SnapshotFrame } from '../api/snapshot-frame';
import type { IndicatorDefinitionOut } from '../api/types';
import { keyedComposite } from '../lib/analytics';
import type { EvidenceRow } from '../lib/results';

/** indicator id -> reverse? (`direction: higher_less` means more of the construct is lower). */
export function directionMap(defs: readonly IndicatorDefinitionOut[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const d of defs) {
    const dir = (d.definition as Record<string, unknown>).direction;
    out.set(d.indicator_id, dir === 'higher_less');
  }
  return out;
}

/** The construct's indicator columns present in the frame, keyed by direction. */
export function constructColumns(
  frame: SnapshotFrame,
  construct: string,
  reverse: ReadonlyMap<string, boolean>,
  only?: readonly string[],
): { column: string; reverse: boolean }[] {
  return frame.indicatorColumns
    .filter((c) => c.startsWith(`ind__${construct}.`))
    .filter((c) => !only || only.includes(c.slice(5)))
    .map((c) => ({ column: c, reverse: reverse.get(c.slice(5)) ?? false }));
}

/** Indicators the engine used for the construct's composite (from the omega/alpha row). */
export function compositeIndicators(
  rows: readonly EvidenceRow[],
  construct: string,
): string[] | undefined {
  const row = rows.find(
    (r) =>
      r.analysis === 'reliability' &&
      r.subject_kind === 'construct' &&
      r.subject === construct &&
      (r.metric === 'omega_total' || r.metric === 'alpha'),
  );
  const list = (row?.details as Record<string, unknown> | undefined)?.indicators;
  return Array.isArray(list) ? list.map(String) : undefined;
}

export interface CompositeRow {
  readonly row: FrameRow;
  readonly composite: number | null;
}

export function withComposite(
  rows: readonly FrameRow[],
  columns: readonly { column: string; reverse: boolean }[],
): CompositeRow[] {
  const values = keyedComposite(rows, columns);
  return rows.map((row, i) => ({ row, composite: values[i] ?? null }));
}
