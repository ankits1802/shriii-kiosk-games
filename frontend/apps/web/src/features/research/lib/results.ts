/**
 * Reading validation results (layer 4 evidence) for the Trait Validation Workbench.
 *
 * The API returns `statistical_results` rows per run (analysis, subject, metric, estimate, CI, N,
 * subgroup, details, exclusions, provenance). These helpers pick the latest succeeded run per
 * analysis (as the gate evaluation does, services/gate_evaluation.py `latest_results`) and slice
 * the rows by construct. Nothing here computes a statistic: every number comes from the engine.
 */
import { asArray, asNumber, asRecord, asString, type ResultOut, type RunOut } from '../api/types';

export interface EvidenceRow extends ResultOut {
  readonly analysis: string;
  readonly run_id: string;
  readonly run_finished_at: string | null;
  readonly confirmatory: boolean;
  readonly engine: string | null;
}

/** Latest succeeded run per analysis (gate evaluations are kept separately). */
export function latestRuns(runs: readonly RunOut[]): Map<string, RunOut> {
  const out = new Map<string, RunOut>();
  for (const run of runs) {
    if (run.status !== 'succeeded') continue;
    const prev = out.get(run.analysis);
    const at = run.finished_at ?? run.created_at;
    const prevAt = prev ? (prev.finished_at ?? prev.created_at) : '';
    if (!prev || at > prevAt) out.set(run.analysis, run);
  }
  return out;
}

export function flattenResults(runs: Iterable<RunOut>): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const run of runs) {
    for (const r of run.results ?? []) {
      rows.push({
        ...r,
        analysis: run.analysis,
        run_id: run.run_id,
        run_finished_at: run.finished_at,
        confirmatory: run.confirmatory,
        engine: run.engine,
      });
    }
  }
  return rows;
}

export function subgroupLanguage(row: Pick<ResultOut, 'subgroup'>): string | null {
  return asString(asRecord(row.subgroup).language);
}

/** Rows without a language subgroup (pooled estimate). */
export function isPooled(row: Pick<ResultOut, 'subgroup'>): boolean {
  return subgroupLanguage(row) === null;
}

export function detail(row: Pick<ResultOut, 'details'>, key: string): unknown {
  return asRecord(row.details)[key];
}

/** Constructs that have any evidence row. */
export function constructsWithEvidence(rows: readonly EvidenceRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const c = constructOf(r);
    if (c) out.add(c);
  }
  return [...out].sort();
}

/**
 * The construct a row is about: construct rows by subject, indicators by their `<construct>.` prefix,
 * hypotheses and indicator-criterion pairs by `details.construct`.
 */
export function constructOf(row: EvidenceRow): string | null {
  const fromDetails = asString(detail(row, 'construct'));
  if (fromDetails) return fromDetails;
  if (row.subject_kind === 'construct') return row.subject;
  if (row.subject_kind === 'indicator') return row.subject.split('.')[0] ?? null;
  if (row.subject_kind === 'trait_gate') return row.subject;
  if (row.subject.includes('~')) return row.subject.split('~')[0]?.split('.')[0] ?? null;
  return null;
}

export type Relation = 'convergent' | 'discriminant' | 'nomological' | 'exploratory';

export interface CriterionCorrelation {
  readonly criterion: string;
  readonly hypothesisId: string | null;
  readonly family: string | null;
  readonly relation: Relation;
  readonly language: string | null;
  readonly row: EvidenceRow;
}

function relationOf(row: EvidenceRow): Relation {
  const family = asString(detail(row, 'family'));
  const kind = asString(detail(row, 'kind'));
  if (family === 'nomological' || kind === 'nomological') return 'nomological';
  if (family === 'discriminant_pattern' || kind === 'discriminant') return 'discriminant';
  if (family === 'exploratory') return 'exploratory';
  return 'convergent';
}

/**
 * Pre-registered construct-criterion correlations (construct_validity `hypothesis` rows with a
 * correlation metric), pooled and by language.
 */
export function criterionCorrelations(
  rows: readonly EvidenceRow[],
  construct: string,
): CriterionCorrelation[] {
  return rows
    .filter(
      (r) =>
        r.analysis === 'construct_validity' &&
        r.subject_kind === 'hypothesis' &&
        (r.metric === 'pearson_r' || r.metric === 'spearman_rho') &&
        constructOf(r) === construct,
    )
    .map((r) => ({
      criterion: asString(detail(r, 'criterion')) ?? r.subject.split('~')[1] ?? r.subject,
      hypothesisId: r.hypothesis_id,
      family: asString(detail(r, 'family')),
      relation: relationOf(r),
      language: subgroupLanguage(r),
      row: r,
    }));
}

/** Indicator-level correlations with each criterion (exploratory matrix rows). */
export function indicatorCriterionRows(
  rows: readonly EvidenceRow[],
  construct: string,
): EvidenceRow[] {
  return rows.filter(
    (r) =>
      r.analysis === 'construct_validity' &&
      r.subject_kind === 'indicator_criterion' &&
      constructOf(r) === construct,
  );
}

/** Retest ICC(A,1) for the construct composite: pooled first, then languages. */
export function retestRows(rows: readonly EvidenceRow[], construct: string): EvidenceRow[] {
  return sortPooledFirst(
    rows.filter(
      (r) =>
        r.analysis === 'reliability' &&
        r.metric === 'icc_a1' &&
        r.subject_kind === 'construct' &&
        r.subject === construct,
    ),
  );
}

/** Retest ICC(A,1) for each indicator of the construct (pooled only). */
export function indicatorRetestRows(
  rows: readonly EvidenceRow[],
  construct: string,
): EvidenceRow[] {
  return rows.filter(
    (r) =>
      r.analysis === 'reliability' &&
      r.metric === 'icc_a1' &&
      r.subject_kind === 'indicator' &&
      r.subject.startsWith(`${construct}.`) &&
      isPooled(r),
  );
}

/** Composite internal consistency (omega or alpha) pooled and by language. */
export function compositeReliabilityRows(
  rows: readonly EvidenceRow[],
  construct: string,
): EvidenceRow[] {
  return sortPooledFirst(
    rows.filter(
      (r) =>
        r.analysis === 'reliability' &&
        (r.metric === 'omega_total' || r.metric === 'alpha') &&
        r.subject_kind === 'construct' &&
        r.subject === construct,
    ),
  );
}

function sortPooledFirst<T extends Pick<ResultOut, 'subgroup'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const la = subgroupLanguage(a);
    const lb = subgroupLanguage(b);
    if (la === lb) return 0;
    if (la === null) return -1;
    if (lb === null) return 1;
    return la.localeCompare(lb);
  });
}

export interface MtmmMatrix {
  readonly variables: readonly string[];
  readonly traits: Readonly<Record<string, string>>;
  readonly methods: Readonly<Record<string, string>>;
  readonly values: readonly (readonly (number | null)[])[];
  readonly n: number | null;
  readonly language: string | null;
  readonly row: EvidenceRow;
}

export type MtmmCellKind =
  | 'reliability'
  | 'validity'
  | 'heterotrait_monomethod'
  | 'heterotrait_heteromethod';

/** The Campbell–Fiske block a cell belongs to. */
export function mtmmCellKind(matrix: MtmmMatrix, i: number, j: number): MtmmCellKind {
  const a = matrix.variables[i] ?? '';
  const b = matrix.variables[j] ?? '';
  if (i === j) return 'reliability';
  const sameTrait = matrix.traits[a] !== undefined && matrix.traits[a] === matrix.traits[b];
  const sameMethod = matrix.methods[a] !== undefined && matrix.methods[a] === matrix.methods[b];
  if (sameTrait && !sameMethod) return 'validity';
  if (sameMethod) return 'heterotrait_monomethod';
  return 'heterotrait_heteromethod';
}

/** The mtmm_matrix rows (pooled first). */
export function mtmmMatrices(rows: readonly EvidenceRow[]): MtmmMatrix[] {
  return sortPooledFirst(rows.filter((r) => r.analysis === 'mtmm' && r.metric === 'mtmm_matrix'))
    .map((r) => {
      const d = asRecord(r.details);
      const variables = asArray(d.variables).filter((v): v is string => typeof v === 'string');
      const matrix = asRecord(d.matrix);
      const values = variables.map((a) => {
        const row = asRecord(matrix[a]);
        return variables.map((b) => asNumber(row[b]));
      });
      return {
        variables,
        traits: asRecord(d.traits) as Record<string, string>,
        methods: asRecord(d.methods) as Record<string, string>,
        values,
        n: r.n,
        language: subgroupLanguage(r),
        row: r,
      };
    })
    .filter((m) => m.variables.length > 0);
}

/**
 * For one construct: its own validity-diagonal r versus every discriminant (heterotrait) r in its
 * MTMM row/column, for the convergent-vs-discriminant comparison bars.
 */
export function ownVersusDiscriminant(
  matrix: MtmmMatrix,
  construct: string,
): { own: number | null; discriminant: { label: string; r: number; kind: MtmmCellKind }[] } {
  let own: number | null = null;
  const discriminant: { label: string; r: number; kind: MtmmCellKind }[] = [];
  matrix.variables.forEach((a, i) => {
    if (matrix.traits[a] !== construct) return;
    matrix.variables.forEach((b, j) => {
      const r = matrix.values[i]?.[j] ?? null;
      if (r === null || i === j) return;
      const kind = mtmmCellKind(matrix, i, j);
      if (kind === 'validity') own = r;
      else discriminant.push({ label: `${a} × ${b}`, r, kind });
    });
  });
  discriminant.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return { own, discriminant };
}

/** Short display label for an MTMM variable `game:self_control` / `self_report:bscs.total`. */
export function mtmmLabel(variable: string): string {
  const [method, name] = variable.includes(':') ? variable.split(':', 2) : ['', variable];
  const m = method === 'game' ? 'Game' : method === 'self_report' ? 'Self-report' : method;
  return m ? `${m} · ${name}` : (name ?? variable);
}

export function difRows(rows: readonly EvidenceRow[], construct: string): EvidenceRow[] {
  return rows.filter(
    (r) => r.analysis === 'dif' && r.subject_kind === 'indicator' && constructOf(r) === construct,
  );
}

export interface InvarianceSummary {
  readonly grouping: string;
  readonly level: string | null;
  readonly steps: readonly EvidenceRow[];
  readonly levelRow: EvidenceRow | null;
}

const INVARIANCE_ORDER = ['cfi_configural', 'cfi_metric', 'cfi_scalar', 'cfi_strict'];

export function invarianceSummaries(
  rows: readonly EvidenceRow[],
  construct: string,
): InvarianceSummary[] {
  const own = rows.filter(
    (r) =>
      r.analysis === 'measurement_invariance' &&
      r.subject_kind === 'construct' &&
      r.subject === construct,
  );
  const groupings = [...new Set(own.map((r) => asString(asRecord(r.subgroup).grouping) ?? '—'))];
  return groupings.map((grouping) => {
    const mine = own.filter((r) => (asString(asRecord(r.subgroup).grouping) ?? '—') === grouping);
    const levelRow = mine.find((r) => r.metric === 'invariance_level') ?? null;
    return {
      grouping,
      level: levelRow ? asString(detail(levelRow, 'level')) : null,
      levelRow,
      steps: mine
        .filter((r) => INVARIANCE_ORDER.includes(r.metric))
        .sort((a, b) => INVARIANCE_ORDER.indexOf(a.metric) - INVARIANCE_ORDER.indexOf(b.metric)),
    };
  });
}

export function fairnessRows(rows: readonly EvidenceRow[], construct: string): EvidenceRow[] {
  return rows.filter((r) => r.analysis === 'fairness' && constructOf(r) === construct);
}

/** Battery-level fairness / DIF / invariance rows (not tied to a construct). */
export function batteryRows(rows: readonly EvidenceRow[], analysis: string): EvidenceRow[] {
  return rows.filter((r) => r.analysis === analysis && r.subject_kind === 'battery');
}

export interface TraitGateDecision {
  readonly trait: string;
  readonly language: string;
  readonly pathway: string;
  readonly evaluatedStatus: string;
  readonly rules: Readonly<Record<string, string>>;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

/** Trait-gate decisions recorded by a `gate_evaluation` run (evaluate-only). */
export function traitGateDecisions(run: RunOut | null | undefined): TraitGateDecision[] {
  if (!run) return [];
  return (run.results ?? [])
    .filter((r) => r.metric === 'trait_gate_status')
    .map((r) => {
      const d = asRecord(r.details);
      const rules = asRecord(d.rules);
      return {
        trait: asString(d.trait) ?? r.subject,
        language: asString(d.language) ?? asString(asRecord(r.subgroup).language) ?? '—',
        pathway: asString(d.pathway) ?? asString(asRecord(r.subgroup).pathway) ?? '—',
        evaluatedStatus: asString(d.evaluated_status) ?? 'unvalidated',
        rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, String(v)])),
        reasons: asArray(d.reasons).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
        evidenceIds: asArray(d.evidence_ids ?? d.evidence).map(String),
        details: d,
      };
    });
}

export interface BatteryGateDecision {
  readonly language: string;
  readonly pathway: string;
  readonly siteMode: string;
  readonly status: string;
  readonly rules: Readonly<Record<string, string>>;
  readonly reasons: readonly string[];
}

export function batteryGateDecisions(run: RunOut | null | undefined): BatteryGateDecision[] {
  if (!run) return [];
  return (run.results ?? [])
    .filter((r) => r.metric === 'battery_gate_status')
    .map((r) => {
      const d = asRecord(r.details);
      const sub = asRecord(r.subgroup);
      return {
        language: asString(d.language) ?? asString(sub.language) ?? '—',
        pathway: asString(d.pathway) ?? asString(sub.pathway) ?? '—',
        siteMode: asString(d.site_mode) ?? asString(sub.site_mode) ?? '—',
        status: asString(d.status) ?? 'closed',
        rules: Object.fromEntries(
          Object.entries(asRecord(d.rules)).map(([k, v]) => [k, String(v)]),
        ),
        reasons: asArray(d.reasons).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
      };
    });
}

/** Latest gate-evaluation run (they are recorded as validation runs with analysis `gate_evaluation`). */
export function latestGateEvaluation(runs: readonly RunOut[]): RunOut | null {
  return (
    latestRuns(runs.filter((r) => r.analysis === 'gate_evaluation')).get('gate_evaluation') ?? null
  );
}

/** Exclusions summary of a result row (`rows_available`, `rows_used`, `rows_excluded_missing`). */
export function exclusionCount(row: Pick<ResultOut, 'exclusions'>): number | undefined {
  const e = asRecord(row.exclusions);
  const missing = asNumber(e.rows_excluded_missing);
  if (missing !== null) return missing;
  const avail = asNumber(e.rows_available);
  const used = asNumber(e.rows_used);
  return avail !== null && used !== null ? Math.max(0, avail - used) : undefined;
}

/** Provenance strings of a result row (snapshot, algorithm, inputs hash). */
export function provenanceOf(row: Pick<ResultOut, 'provenance'>): {
  snapshotId: string | null;
  algorithmVersion: string | null;
  analysis: string | null;
  inputsSha256: string | null;
  frameSha256: string | null;
  gitSha: string | null;
  dictionarySha: string | null;
} {
  const p = asRecord(row.provenance);
  const dict = p.dictionary_sha256;
  return {
    snapshotId: asString(p.snapshot_id),
    algorithmVersion: asString(p.algorithm_version),
    analysis: asString(p.analysis),
    inputsSha256: asString(p.inputs_sha256),
    frameSha256: asString(p.frame_sha256),
    gitSha: asString(p.git_sha),
    dictionarySha:
      typeof dict === 'string'
        ? dict
        : Object.values(asRecord(dict))
            .map(String)
            .map((s) => s.slice(0, 12))
            .join(', ') || null,
  };
}
