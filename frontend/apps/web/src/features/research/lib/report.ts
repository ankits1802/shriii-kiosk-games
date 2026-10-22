/**
 * Scientific report assembly: turns one snapshot's engine results into report tables with N, CI,
 * exclusions and provenance on every row, plus the flat evidence export (one row per statistic).
 * Pure functions; the page renders and exports what these return.
 */
import type { ExportColumn } from '@/lib/export';
import type { RunOut } from '../api/types';
import { asRecord, asString, type DatasetOut, type DeviationRow } from '../api/types';
import { cvComparisons, holdoutComparisons, incrementalSummary } from './models';
import {
  compositeReliabilityRows,
  constructsWithEvidence,
  criterionCorrelations,
  difRows,
  type EvidenceRow,
  exclusionCount,
  invarianceSummaries,
  provenanceOf,
  retestRows,
  subgroupLanguage,
  traitGateDecisions,
} from './results';

export type Cell = string | number | null;

export interface ReportTable {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}

export interface ReportSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly tables: readonly ReportTable[];
}

export const SECTION_IDS = [
  'sample',
  'reliability',
  'validity',
  'structure',
  'fairness',
  'prediction',
  'gates',
  'deviations',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_TITLES: Record<SectionId, string> = {
  sample: 'Sample, matching and exclusions',
  reliability: 'Reliability',
  validity: 'Convergent and discriminant validity',
  structure: 'Construct structure',
  fairness: 'Fairness and measurement equivalence',
  prediction: 'Predictive validity',
  gates: 'Gate status (evaluate-only)',
  deviations: 'Protocol deviations',
};

const r3 = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const ci = (lo: number | null | undefined, hi: number | null | undefined): string =>
  lo === null || lo === undefined || hi === null || hi === undefined
    ? '—'
    : `[${r3(lo)}, ${r3(hi)}]`;
const group = (r: EvidenceRow) => subgroupLanguage(r) ?? 'pooled';

export interface ReportInput {
  readonly snapshot: DatasetOut;
  readonly rows: readonly EvidenceRow[];
  readonly runs: readonly RunOut[];
  readonly gateRun: RunOut | null;
  readonly deviations: readonly DeviationRow[];
  readonly names: ReadonlyMap<string, string>;
}

export function buildReport(input: ReportInput, include: readonly SectionId[]): ReportSection[] {
  const { snapshot, rows, names } = input;
  const constructs = constructsWithEvidence(rows);
  const name = (c: string) => names.get(c) ?? c;
  const out: ReportSection[] = [];
  const want = (id: SectionId) => include.includes(id);

  if (want('sample')) {
    const ex = asRecord(snapshot.exclusions);
    const byReason = asRecord(ex.by_reason);
    out.push({
      id: 'sample',
      title: SECTION_TITLES.sample,
      text: `The analysis snapshot ${snapshot.name} (v${snapshot.version}, ${snapshot.status}) holds ${snapshot.row_count ?? '—'} participant × occasion rows from ${snapshot.n_participants ?? '—'} participants; ${String(ex.total ?? 0)} matched records were excluded before analysis.`,
      tables: [
        {
          id: 'exclusions',
          title: 'Exclusions by reason',
          columns: ['Reason', 'Records'],
          rows: Object.entries(byReason).map(([k, v]) => [k.replaceAll('_', ' '), Number(v)]),
        },
      ],
    });
  }

  if (want('reliability')) {
    const rel = constructs.flatMap((c) => [
      ...retestRows(rows, c),
      ...compositeReliabilityRows(rows, c),
    ]);
    out.push({
      id: 'reliability',
      title: SECTION_TITLES.reliability,
      text: 'Test–retest ICC(A,1) on participants measured on both occasions and composite internal consistency (omega total), pooled and by language, with 95% confidence intervals. Thresholds are research targets from gates.yaml, not validity declarations.',
      tables: [
        {
          id: 'reliability',
          title: 'Reliability by construct and group',
          columns: [
            'Construct',
            'Statistic',
            'Group',
            'Estimate',
            '95% CI',
            'N',
            'Excluded',
            'Target',
            'Meets target',
          ],
          rows: rel.map((r) => [
            name(r.subject),
            r.metric,
            group(r),
            r3(r.estimate),
            ci(r.ci_low, r.ci_high),
            r.n,
            exclusionCount(r) ?? null,
            r3(r.threshold),
            r.passed === null ? '—' : r.passed ? 'yes' : 'no',
          ]),
        },
      ],
    });
  }

  if (want('validity')) {
    const corr = constructs.flatMap((c) => criterionCorrelations(rows, c).map((x) => ({ c, x })));
    out.push({
      id: 'validity',
      title: SECTION_TITLES.validity,
      text: 'Pre-registered construct–criterion correlations (observed Pearson r; disattenuated values never feed gates). Primary hypotheses are Holm-corrected; secondary and pattern families use BH-FDR.',
      tables: [
        {
          id: 'hypotheses',
          title: 'Hypothesis tests',
          columns: [
            'Hypothesis',
            'Construct',
            'Criterion',
            'Family',
            'Group',
            'r',
            '95% CI',
            'N',
            'p (adjusted)',
            'Supported',
          ],
          rows: corr.map(({ c, x }) => [
            x.hypothesisId,
            name(c),
            x.criterion,
            x.family,
            x.language ?? 'pooled',
            r3(x.row.estimate),
            ci(x.row.ci_low, x.row.ci_high),
            x.row.n,
            r3(asRecord(x.row.details).p_adjusted as number | null),
            x.row.estimate === null
              ? String(asRecord(x.row.details).status ?? 'not estimable')
              : x.row.passed
                ? 'yes'
                : 'no',
          ]),
        },
        {
          id: 'mtmm',
          title: 'MTMM validity diagonals',
          columns: ['Construct', 'Group', 'r', '95% CI', 'N', 'Campbell–Fiske criterion met'],
          rows: rows
            .filter((r) => r.analysis === 'mtmm' && r.metric === 'validity_diagonal_r')
            .map((r) => [
              name(r.subject),
              group(r),
              r3(r.estimate),
              ci(r.ci_low, r.ci_high),
              r.n,
              r.passed === null ? '—' : r.passed ? 'yes' : 'no',
            ]),
        },
      ],
    });
  }

  if (want('structure')) {
    out.push({
      id: 'structure',
      title: SECTION_TITLES.structure,
      text: 'Parallel analysis, exploratory factor analysis and one-factor CFA per construct, to judge whether the constructs are empirically distinct.',
      tables: [
        {
          id: 'structure',
          title: 'Structure results',
          columns: ['Subject', 'Statistic', 'Estimate', 'N', 'Method'],
          rows: rows
            .filter((r) => r.analysis === 'factor_structure')
            .map((r) => [
              r.subject === 'battery' ? 'battery' : name(r.subject),
              r.metric,
              r3(r.estimate),
              r.n,
              r.method,
            ]),
        },
      ],
    });
  }

  if (want('fairness')) {
    out.push({
      id: 'fairness',
      title: SECTION_TITLES.fairness,
      text: 'Multi-group CFA invariance steps, regression DIF per indicator (Jodoin–Gierl classes) and battery-level exclusion gaps. A non-significant difference is not equivalence.',
      tables: [
        {
          id: 'invariance',
          title: 'Measurement invariance',
          columns: ['Construct', 'Grouping', 'Highest level', 'N'],
          rows: constructs.flatMap((c) =>
            invarianceSummaries(rows, c).map((s) => [
              name(c),
              s.grouping,
              s.level ?? 'none',
              s.levelRow?.n ?? null,
            ]),
          ),
        },
        {
          id: 'dif',
          title: 'Differential item functioning',
          columns: ['Indicator', 'Comparison', 'ΔR²', 'Class', 'p (FDR)', 'N'],
          rows: constructs.flatMap((c) =>
            difRows(rows, c).map((r) => {
              const s = asRecord(r.subgroup);
              const d = asRecord(r.details);
              return [
                r.subject,
                `${String(s.focal ?? '')} vs ${String(s.reference ?? '')}`,
                r3(r.estimate),
                asString(d.class),
                r3(d.p_fdr as number | null),
                r.n,
              ];
            }),
          ),
        },
      ],
    });
  }

  if (want('prediction')) {
    const inc = rows.filter((r) => r.analysis === 'incremental_validity');
    const cv = cvComparisons(inc);
    const ho = holdoutComparisons(inc);
    const sum = incrementalSummary(inc);
    out.push({
      id: 'prediction',
      title: SECTION_TITLES.prediction,
      text: `Four comparisons with participant-grouped cross-validation and an untouched holdout cohort. Incremental CV R² of game features over the battery: ${r3(sum.deltaCvR2.estimate) ?? '—'} ${ci(sum.deltaCvR2.low, sum.deltaCvR2.high)}.`,
      tables: [
        {
          id: 'cv',
          title: 'Cross-validated performance',
          columns: ['Comparison', 'Model', 'CV R²', '95% CI', 'MAE', 'RMSE', 'N'],
          rows: cv.map((r) => [
            r.comparison,
            r.model,
            r3(r.r2.estimate),
            ci(r.r2.low, r.r2.high),
            r3(r.mae.estimate),
            r3(r.rmse.estimate),
            r.n,
          ]),
        },
        {
          id: 'holdout',
          title: 'Holdout cohort',
          columns: ['Comparison', 'Holdout R²', '95% CI', 'MAE', 'RMSE', 'Participants'],
          rows: ho.map((r) => [
            r.comparison,
            r3(r.r2.estimate),
            ci(r.r2.low, r.r2.high),
            r3(r.mae),
            r3(r.rmse),
            r.nGroups,
          ]),
        },
      ],
    });
  }

  if (want('gates')) {
    const decisions = traitGateDecisions(input.gateRun);
    out.push({
      id: 'gates',
      title: SECTION_TITLES.gates,
      text: 'Would-be trait statuses from the gates.yaml rules. Evaluate-only: promotion is a separate signed action, and participant reports stay disabled until the battery gate opens in at least two language groups.',
      tables: [
        {
          id: 'trait-gates',
          title: 'Trait gate evaluation',
          columns: [
            'Trait',
            'Language',
            'Pathway',
            'Evaluated status',
            'B1',
            'B2',
            'B3',
            'B4',
            'B5',
            'B6',
          ],
          rows: decisions.map((d) => [
            name(d.trait),
            d.language,
            d.pathway,
            d.evaluatedStatus,
            d.rules.B1 ?? '—',
            d.rules.B2 ?? '—',
            d.rules.B3 ?? '—',
            d.rules.B4 ?? '—',
            d.rules.B5 ?? '—',
            d.rules.B6 ?? '—',
          ]),
        },
      ],
    });
  }

  if (want('deviations')) {
    out.push({
      id: 'deviations',
      title: SECTION_TITLES.deviations,
      text: `${input.deviations.length} protocol deviation(s) recorded for the study.`,
      tables: [
        {
          id: 'deviations',
          title: 'Deviations',
          columns: ['Recorded', 'Category', 'Severity', 'Description'],
          rows: input.deviations.map((d) => [
            d.created_at.slice(0, 10),
            d.category,
            d.severity,
            d.description,
          ]),
        },
      ],
    });
  }
  return out;
}

/** Flat export of every statistic: one row per result with its provenance. */
export function evidenceExportColumns(): ExportColumn<EvidenceRow>[] {
  return [
    { key: 'analysis', header: 'analysis', value: (r) => r.analysis },
    { key: 'subject', header: 'subject', value: (r) => r.subject },
    { key: 'subject_kind', header: 'subject_kind', value: (r) => r.subject_kind },
    { key: 'metric', header: 'metric', value: (r) => r.metric },
    { key: 'group', header: 'group', value: (r) => JSON.stringify(r.subgroup) },
    { key: 'estimate', header: 'estimate', type: 'number', value: (r) => r.estimate },
    { key: 'ci_low', header: 'ci_low', type: 'number', value: (r) => r.ci_low },
    { key: 'ci_high', header: 'ci_high', type: 'number', value: (r) => r.ci_high },
    { key: 'ci_level', header: 'ci_level', type: 'number', value: (r) => r.ci_level },
    { key: 'n', header: 'n', type: 'integer', value: (r) => r.n },
    {
      key: 'excluded',
      header: 'excluded',
      type: 'integer',
      value: (r) => exclusionCount(r) ?? null,
    },
    { key: 'threshold', header: 'threshold', type: 'number', value: (r) => r.threshold },
    { key: 'passed', header: 'passed', type: 'boolean', value: (r) => r.passed },
    { key: 'hypothesis_id', header: 'hypothesis_id', value: (r) => r.hypothesis_id },
    { key: 'exploratory', header: 'exploratory', type: 'boolean', value: (r) => r.exploratory },
    {
      key: 'confirmatory_run',
      header: 'confirmatory_run',
      type: 'boolean',
      value: (r) => r.confirmatory,
    },
    { key: 'method', header: 'method', value: (r) => r.method },
    { key: 'run_id', header: 'run_id', value: (r) => r.run_id },
    { key: 'engine', header: 'engine', value: (r) => r.engine },
    { key: 'snapshot_id', header: 'snapshot_id', value: (r) => provenanceOf(r).snapshotId },
    {
      key: 'algorithm_version',
      header: 'algorithm_version',
      value: (r) => provenanceOf(r).algorithmVersion,
    },
    { key: 'inputs_sha256', header: 'inputs_sha256', value: (r) => provenanceOf(r).inputsSha256 },
    { key: 'git_sha', header: 'git_sha', value: (r) => provenanceOf(r).gitSha },
  ];
}

/** CSV of one report table (RFC 4180 quoting). */
export function tableCsv(table: ReportTable): string {
  const q = (v: Cell) => {
    const s = v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [table.columns.map(q).join(','), ...table.rows.map((r) => r.map(q).join(','))].join(
    '\r\n',
  );
}

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Standalone HTML document of the report (archivable; no scripts, no external assets). */
export function reportHtml(
  title: string,
  meta: readonly (readonly [string, string])[],
  sections: readonly ReportSection[],
  synthetic: boolean,
): string {
  const body = sections
    .map(
      (s) =>
        `<section><h2>${esc(s.title)}</h2><p>${esc(s.text)}</p>${s.tables
          .map(
            (t) =>
              `<table><caption>${esc(t.title)}</caption><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
                t.rows.length
                  ? t.rows
                      .map(
                        (r) =>
                          `<tr>${r.map((v) => `<td>${esc(v === null ? '—' : String(v))}</td>`).join('')}</tr>`,
                      )
                      .join('')
                  : `<tr><td colspan="${t.columns.length}">No results</td></tr>`
              }</tbody></table>`,
          )
          .join('')}</section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#0b0b0b}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem}table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:12px}caption{text-align:left;font-weight:600;padding:.25rem 0}th,td{border-bottom:1px solid #e1e0d9;padding:4px 6px;text-align:left}dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}dt{color:#52514e}.warn{border:1px solid #fab219;background:#fff8e6;padding:.5rem .75rem;border-radius:6px}</style></head><body><h1>${esc(title)}</h1>${
    synthetic
      ? '<p class="warn">Synthetic / demo data: simulator output, not evidence about real participants.</p>'
      : ''
  }<dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${body}</body></html>`;
}
