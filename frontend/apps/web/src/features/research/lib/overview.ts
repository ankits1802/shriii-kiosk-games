/**
 * Overview dashboard aggregates (spec section 7): participants, sessions, matched records,
 * completion/abandonment, breakdowns by language / age / literacy / education, and data-quality
 * distributions. Pure functions over API rows so the numbers are unit-tested independently of the UI.
 */
import type { EnrollmentOut, MatchedRecord, QuotaStatus, SessionOut } from '../api/types';

/** Enrollment quota-cell fields (backend services/studies.py CELL_FIELDS). */
export const CELL_FIELDS = ['language', 'age_band', 'gender', 'edu_band', 'literacy_band'] as const;
export type CellField = (typeof CELL_FIELDS)[number];

/** Parse `language=hi-IN|age_band=*|...` into a field map ('*' = any is dropped). */
export function parseCellKey(
  cellKey: string | null | undefined,
): Partial<Record<CellField, string>> {
  const out: Partial<Record<CellField, string>> = {};
  if (!cellKey) return out;
  for (const part of cellKey.split('|')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq) as CellField;
    const value = part.slice(eq + 1);
    if ((CELL_FIELDS as readonly string[]).includes(key) && value && value !== '*') {
      out[key] = value;
    }
  }
  return out;
}

export interface CountRow {
  readonly key: string;
  readonly count: number;
  readonly share: number;
}

/** Count values (null/undefined counted as "not recorded"), largest first, ties by key. */
export function countBy<T>(
  rows: readonly T[],
  key: (row: T) => string | null | undefined,
  missingLabel = 'not recorded',
): CountRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row) ?? missingLabel;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = rows.length;
  return [...counts.entries()]
    .map(([k, count]) => ({ key: k, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface SessionSummary {
  readonly total: number;
  /** Real sessions only (synthetic excluded) unless every session is synthetic. */
  readonly real: number;
  readonly synthetic: number;
  readonly completed: number;
  readonly abandoned: number;
  readonly withdrawn: number;
  readonly active: number;
  readonly other: number;
  /** completed / (completed + abandoned + withdrawn); null when nothing has ended. */
  readonly completionRate: number | null;
  readonly abandonmentRate: number | null;
  readonly validForReport: number;
  readonly linked: number;
  readonly endReasons: readonly CountRow[];
  readonly byLanguage: readonly CountRow[];
  readonly byPathway: readonly CountRow[];
  readonly byOccasion: readonly CountRow[];
  /** Events per completed session (data-quality distribution). */
  readonly eventCounts: readonly number[];
  /** Completed sessions whose received seq has a gap (max_contiguous < last received). */
  readonly seqGaps: number;
  /** Minutes from start to completion for completed sessions. */
  readonly durationsMinutes: readonly number[];
}

export function summariseSessions(sessions: readonly SessionOut[]): SessionSummary {
  let completed = 0;
  let abandoned = 0;
  let withdrawn = 0;
  let active = 0;
  let other = 0;
  let synthetic = 0;
  let validForReport = 0;
  let linked = 0;
  let seqGaps = 0;
  const eventCounts: number[] = [];
  const durations: number[] = [];
  for (const s of sessions) {
    if (s.synthetic) synthetic += 1;
    if (s.valid_for_report) validForReport += 1;
    if (s.participant_pid) linked += 1;
    switch (s.status) {
      case 'completed':
        completed += 1;
        eventCounts.push(s.event_count);
        if (
          s.last_seq_received !== null &&
          s.max_contiguous_seq !== null &&
          s.max_contiguous_seq < s.last_seq_received
        ) {
          seqGaps += 1;
        }
        if (s.completed_at) {
          const minutes = (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 60_000;
          if (Number.isFinite(minutes) && minutes >= 0)
            durations.push(Math.round(minutes * 10) / 10);
        }
        break;
      case 'abandoned':
        abandoned += 1;
        break;
      case 'withdrawn':
        withdrawn += 1;
        break;
      case 'active':
        active += 1;
        break;
      default:
        other += 1;
    }
  }
  const ended = completed + abandoned + withdrawn;
  const endedRows = sessions.filter((s) => s.status !== 'active');
  return {
    total: sessions.length,
    real: sessions.length - synthetic,
    synthetic,
    completed,
    abandoned,
    withdrawn,
    active,
    other,
    completionRate: ended ? completed / ended : null,
    abandonmentRate: ended ? abandoned / ended : null,
    validForReport,
    linked,
    endReasons: countBy(endedRows, (s) => s.end_reason),
    byLanguage: countBy(sessions, (s) => s.language),
    byPathway: countBy(sessions, (s) => (s.pathway ? `Pathway ${s.pathway}` : null)),
    byOccasion: countBy(sessions, (s) => s.occasion_id),
    eventCounts,
    seqGaps,
    durationsMinutes: durations,
  };
}

export interface EnrollmentBreakdowns {
  readonly total: number;
  readonly active: number;
  readonly withdrawn: number;
  readonly byField: Readonly<Record<CellField, readonly CountRow[]>>;
  readonly byArm: readonly CountRow[];
  readonly byCohort: readonly CountRow[];
  readonly byBlock: readonly CountRow[];
}

/** Natural order of ordinal band values; unknown values sort after, alphabetically. */
const ORDINAL: Partial<Record<CellField, readonly string[]>> = {
  age_band: ['18-24', '25-34', '35-49', '50+', '50-64', '65+'],
  literacy_band: ['low', 'medium', 'high'],
  edu_band: ['none', 'primary', 'secondary', 'tertiary'],
};

export function sortOrdinal(field: CellField, rows: readonly CountRow[]): CountRow[] {
  const order = ORDINAL[field];
  if (!order) return [...rows];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return [...rows].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

export function enrollmentBreakdowns(enrollments: readonly EnrollmentOut[]): EnrollmentBreakdowns {
  const cells = enrollments.map((e) => parseCellKey(e.cell_key));
  const byField = Object.fromEntries(
    CELL_FIELDS.map((f) => [
      f,
      sortOrdinal(
        f,
        countBy(cells, (c) => c[f]),
      ),
    ]),
  ) as Record<CellField, CountRow[]>;
  return {
    total: enrollments.length,
    active: enrollments.filter((e) => e.status !== 'withdrawn').length,
    withdrawn: enrollments.filter((e) => e.status === 'withdrawn').length,
    byField,
    byArm: countBy(enrollments, (e) => e.arm_id),
    byCohort: countBy(enrollments, (e) => e.cohort_id),
    byBlock: countBy(enrollments, (e) => e.criterion_block),
  };
}

export interface MatchSummary {
  readonly records: number;
  readonly participants: number;
  /** Participant x occasion records with both a game session and criterion scores. */
  readonly matched: number;
  readonly gameOnly: number;
  readonly criterionOnly: number;
  readonly withIssues: number;
  readonly issues: readonly CountRow[];
  readonly byOccasion: readonly { occasion: string; matched: number; records: number }[];
  /** Participants with matched records on two or more occasions (retest pairs). */
  readonly retestPairs: number;
}

export function summariseMatches(records: readonly MatchedRecord[]): MatchSummary {
  const matched = records.filter((r) => r.has_game && r.has_criterion);
  const occasions = new Map<string, { matched: number; records: number }>();
  const perPid = new Map<string, number>();
  for (const r of records) {
    const o = occasions.get(r.occasion_id) ?? { matched: 0, records: 0 };
    o.records += 1;
    if (r.has_game && r.has_criterion) {
      o.matched += 1;
      perPid.set(r.pid, (perPid.get(r.pid) ?? 0) + 1);
    }
    occasions.set(r.occasion_id, o);
  }
  const issueRows = records.flatMap((r) => r.issues.map((i) => ({ issue: i })));
  return {
    records: records.length,
    participants: new Set(records.map((r) => r.pid)).size,
    matched: matched.length,
    gameOnly: records.filter((r) => r.has_game && !r.has_criterion).length,
    criterionOnly: records.filter((r) => !r.has_game && r.has_criterion).length,
    withIssues: records.filter((r) => r.issues.length > 0).length,
    issues: countBy(issueRows, (r) => r.issue),
    byOccasion: [...occasions.entries()]
      .map(([occasion, v]) => ({ occasion, ...v }))
      .sort((a, b) => a.occasion.localeCompare(b.occasion)),
    retestPairs: [...perPid.values()].filter((n) => n >= 2).length,
  };
}

export interface QuotaProgress {
  readonly target: number;
  readonly enrolled: number;
  readonly share: number | null;
  readonly fullCells: number;
  readonly cells: number;
}

export function quotaProgress(quotas: readonly QuotaStatus[]): QuotaProgress {
  const target = quotas.reduce((a, q) => a + q.target, 0);
  // A cell cannot contribute more than its target to overall progress.
  const enrolled = quotas.reduce((a, q) => a + Math.min(q.enrolled, q.target), 0);
  return {
    target,
    enrolled,
    share: target ? enrolled / target : null,
    fullCells: quotas.filter((q) => q.full).length,
    cells: quotas.length,
  };
}

/** Human label for a quota cell (fields other than '*'). */
export function cellLabel(cell: Readonly<Record<string, string>>): string {
  const parts = CELL_FIELDS.filter((f) => cell[f] && cell[f] !== '*').map(
    (f) => `${f.replace('_band', '')} ${cell[f]}`,
  );
  return parts.length ? parts.join(' · ') : 'Any participant';
}
