/**
 * Pure view-model for the voice-line catalogue: per-language coverage, ITC workflow transitions with
 * sign-off roles and independent-signer rules (content/i18n/translations/workflow.yaml), and the ITC
 * trail export (VOX-07 AC: "The ITC trail exports per language").
 */
import type {
  CatalogueLine,
  ContentSnapshot,
  TranslationEntry,
  Workflow,
  WorkflowStatus,
} from './content-types';

/** Recording statuses in lines.yaml, in pipeline order (voice-line-catalogue.v1). */
export const RECORDING_STATUSES = [
  'not_scripted',
  'scripted',
  'recorded',
  'audio_qc',
  'approved',
] as const;

export interface LanguageCoverage {
  readonly language: string;
  readonly isReference: boolean;
  readonly total: number;
  /** Lines routed to the speakers (voice_forbidden lines are never recorded for output). */
  readonly voiced: number;
  readonly byRecording: Readonly<Record<string, number>>;
  /** Translation workflow status counts (empty for the reference language). */
  readonly byTranslation: Readonly<Record<string, number>>;
  readonly missingTranslation: number;
  readonly stale: number;
  readonly flagged: number;
  /**
   * Lines this language records, the denominator of pack readiness. Same base as
   * `shriii_i18n.coverage` (`record: false` entries never reach the audio pack; catalogue lines with
   * no entry still count as to-be-recorded).
   */
  readonly toRecord: number;
  /**
   * Recorded lines whose translation status is eligible for each pack kind (production, pilot).
   * Stale entries are excluded: `shriii-i18n check` reports them as errors, so they cannot ship.
   */
  readonly eligible: Readonly<Record<string, number>>;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function coverage(snapshot: ContentSnapshot): LanguageCoverage[] {
  return snapshot.languages.map((language) => {
    const isReference = language === snapshot.referenceLanguage;
    const file = snapshot.translations[language];
    const byRecording: Record<string, number> = {};
    const byTranslation: Record<string, number> = {};
    const eligible: Record<string, number> = Object.fromEntries(
      Object.keys(snapshot.workflow.packEligibility).map((k) => [k, 0]),
    );
    let missing = 0;
    let stale = 0;
    let flagged = 0;
    let voiced = 0;
    let toRecord = 0;
    for (const line of snapshot.lines) {
      if (!line.voiceForbidden) voiced += 1;
      inc(byRecording, line.recording[language]?.status ?? 'not_scripted');
      if (isReference) continue;
      const entry = file?.entries[line.id];
      if (!entry) {
        missing += 1;
        toRecord += 1;
        continue;
      }
      inc(byTranslation, entry.status);
      if (entry.stale) stale += 1;
      if (entry.status === 'flagged_for_revision') flagged += 1;
      if (!entry.record) continue;
      toRecord += 1;
      if (entry.stale) continue;
      for (const [pack, statuses] of Object.entries(snapshot.workflow.packEligibility)) {
        if (statuses.includes(entry.status)) eligible[pack] = (eligible[pack] ?? 0) + 1;
      }
    }
    return {
      language,
      isReference,
      total: snapshot.lines.length,
      voiced,
      byRecording,
      byTranslation,
      missingTranslation: isReference ? 0 : missing,
      stale,
      flagged,
      toRecord: isReference ? voiced : toRecord,
      eligible,
    };
  });
}

export function statusById(workflow: Workflow): ReadonlyMap<string, WorkflowStatus> {
  return new Map(workflow.statuses.map((s) => [s.id, s]));
}

/** Workflow statuses ordered by rank, unranked (flagged) last. */
export function orderedStatuses(workflow: Workflow): WorkflowStatus[] {
  return [...workflow.statuses].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
}

export interface TransitionOption {
  readonly to: WorkflowStatus;
  /** Role that must sign (`*` = any reviewer). */
  readonly signoffRole: string;
  /** Required fields that the entry does not have yet. */
  readonly missing: readonly string[];
  /** People who may not sign this step (independent-signer pairs). */
  readonly barredSigners: readonly string[];
  /** A comment is mandatory (flagging for revision). */
  readonly commentRequired: boolean;
}

const FIELD_PRESENT: Record<string, (e: TranslationEntry | undefined) => boolean> = {
  text: (e) => Boolean(e?.text),
  back_translation: (e) => Boolean(e?.backTranslation),
  // The comment is entered with the sign-off itself.
  review_comment: () => true,
};

/** Who signed the most recent entry into `status` (from the entry history). */
export function lastSignerOf(entry: TranslationEntry | undefined, status: string): string | null {
  const events = entry?.history ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev && ev.toStatus === status) return ev.by;
  }
  return null;
}

/** Next allowed ITC steps for one translation entry. */
export function transitionOptions(
  workflow: Workflow,
  entry: TranslationEntry | undefined,
): TransitionOption[] {
  const current = entry?.status ?? workflow.initialStatus;
  const byId = statusById(workflow);
  return (workflow.transitions[current] ?? []).flatMap((toId) => {
    const to = byId.get(toId);
    if (!to) return [];
    const missing = to.requires.filter((r) => !(FIELD_PRESENT[r]?.(entry) ?? true));
    const barred = workflow.independentSigners
      .filter(([, later]) => later === toId)
      .map(([earlier]) => lastSignerOf(entry, earlier))
      .filter((s): s is string => s !== null);
    return [
      {
        to,
        signoffRole: to.signoffRole ?? '*',
        missing,
        barredSigners: [...new Set(barred)],
        commentRequired: to.requires.includes('review_comment'),
      },
    ];
  });
}

/** Rank of a status as a fraction of the approved rank (0 machine draft … 1 approved). */
export function progressFraction(workflow: Workflow, status: string): number | null {
  const ranks = workflow.statuses.map((s) => s.rank).filter((r): r is number => r !== null);
  const max = Math.max(...ranks, 0);
  const s = statusById(workflow).get(status);
  if (!s || s.rank === null || max === 0) return null;
  return s.rank / max;
}

/** Type alias (not an interface) so rows satisfy Record<string, unknown> for export helpers. */
export type TrailRow = {
  readonly line_id: string;
  readonly language: string;
  readonly status: string;
  readonly from_status: string;
  readonly to_status: string;
  readonly by: string;
  readonly role: string;
  readonly date: string;
  readonly comment: string;
  readonly source: string;
};

/** ITC trail for one language: one row per sign-off, plus the current status of untouched lines. */
export function itcTrail(snapshot: ContentSnapshot, language: string): TrailRow[] {
  const file = snapshot.translations[language];
  if (!file) return [];
  const rows: TrailRow[] = [];
  for (const line of snapshot.lines) {
    const e = file.entries[line.id];
    if (!e) continue;
    if (e.history.length === 0) {
      rows.push({
        line_id: line.id,
        language,
        status: e.status,
        from_status: '',
        to_status: e.status,
        by: '',
        role: '',
        date: '',
        comment: 'no sign-off yet',
        source: '',
      });
    }
    for (const h of e.history) {
      rows.push({
        line_id: line.id,
        language,
        status: e.status,
        from_status: h.fromStatus,
        to_status: h.toStatus,
        by: h.by,
        role: h.role,
        date: h.date,
        comment: h.comment,
        source: h.source,
      });
    }
  }
  return rows;
}

/** Filter predicate for the line table. */
export function matchesLine(line: CatalogueLine, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    line.id.toLowerCase().includes(q) ||
    line.referenceText.toLowerCase().includes(q) ||
    line.category.includes(q) ||
    (line.moduleId ?? '').includes(q)
  );
}
