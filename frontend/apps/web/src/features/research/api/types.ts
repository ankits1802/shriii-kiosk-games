/**
 * Research-console API shapes.
 *
 * Typed responses come from the generated OpenAPI schema (`@/lib/api/types`). Several research
 * endpoints return `dict[str, Any]` in FastAPI and are untyped in OpenAPI; their shapes are written
 * out here from `backend/api/src/shriii_api/api/v1/*.py` so every page reads one definition.
 */
import type { Schema } from '@/lib/api/types';

export type StudyOut = Schema<'StudyOut'>;
export type StudyIn = Schema<'StudyIn'>;
export type ParticipantOut = Schema<'ParticipantOut'>;
export type ParticipantDetail = Schema<'ParticipantDetail'>;
export type ConsentOut = Schema<'ConsentOut'>;
export type LinkOut = Schema<'LinkOut'>;
export type ErasureOut = Schema<'ErasureOut'>;
export type WithdrawOut = Schema<'WithdrawOut'>;
export type SessionOut = Schema<'SessionOut'>;
export type InstrumentOut = Schema<'InstrumentOut'>;
export type InstrumentVersionDetail = Schema<'InstrumentVersionDetail'>;
export type PermissionOut = Schema<'PermissionOut'>;
export type ImportOut = Schema<'ImportOut'>;
export type ImportRowOut = Schema<'ImportRowOut'>;
export type SubmissionOut = Schema<'SubmissionOut'>;
export type ScaleScoreOut = Schema<'ScaleScoreOut'>;
export type IndicatorValueOut = Schema<'IndicatorValueOut'>;
export type IndicatorDefinitionOut = Schema<'IndicatorDefinitionOut'>;
export type ConstructOut = Schema<'ConstructOut'>;
export type DatasetOut = Schema<'DatasetOut'>;
/**
 * Statistical result row. `exclusions` and `provenance` are served by the API (backend ResultOut)
 * but missing from the committed generated schema until it is regenerated, so they are added here.
 */
export type ResultOut = Schema<'ResultOut'> & {
  readonly exclusions?: Readonly<Record<string, unknown>>;
  readonly provenance?: Readonly<Record<string, unknown>>;
};
export type RunOut = Omit<Schema<'RunOut'>, 'results'> & {
  readonly results?: readonly ResultOut[] | null;
};
export type ModelOut = Schema<'ModelOut'>;
export type TrainingRunOut = Schema<'TrainingRunOut'>;
export type EvaluationOut = Schema<'EvaluationOut'> & {
  readonly details?: Readonly<Record<string, unknown>>;
};
export type EnrollmentOut = Schema<'EnrollmentOut'>;
export type EnrollOut = Schema<'EnrollOut'>;
export type NormTableOut = Schema<'NormTableOut'>;
export type ContentVersionOut = Schema<'ContentVersionOut'>;
export type JobRef = Schema<'JobRef'>;

/** GET /studies/{id}/quotas and the `quotas` member of GET /studies/{id}. */
export interface QuotaStatus {
  readonly cell_key: string;
  readonly cell: Readonly<Record<string, string>>;
  readonly target: number;
  readonly enrolled: number;
  readonly full: boolean;
}

export interface ProtocolVersionRow {
  readonly version: string;
  readonly document_sha256: string;
  readonly summary: string | null;
  readonly effective_from: string;
  readonly approved_by: readonly string[];
}

export interface CohortRow {
  readonly cohort_id: string;
  readonly name: string;
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly holdout: boolean;
}

export interface ArmRow {
  readonly arm_id: string;
  readonly ratio: number;
  readonly description: string | null;
}

export interface OccasionRow {
  readonly occasion_id: string;
  readonly wave: number;
  readonly label: string;
  readonly sequence: number;
  readonly offset_days_min: number | null;
  readonly offset_days_max: number | null;
  readonly instruments: readonly string[];
  readonly game_required: boolean;
}

export interface AnalysisPlanRow {
  readonly plan_id: string;
  readonly version: string;
  readonly prereg_id: string | null;
  readonly hypotheses_sha256: string;
  readonly gates_sha256: string;
  readonly registered_at: string;
}

/** GET /studies/{study_id}. */
export interface StudyDesign {
  readonly study: StudyOut;
  readonly protocols: readonly ProtocolVersionRow[];
  readonly cohorts: readonly CohortRow[];
  readonly arms: readonly ArmRow[];
  readonly occasions: readonly OccasionRow[];
  readonly quotas: readonly QuotaStatus[];
  readonly analysis_plans: readonly AnalysisPlanRow[];
}

/** GET /studies/{id}/deviations. */
export interface DeviationRow {
  readonly id: number;
  readonly category: string;
  readonly severity: 'minor' | 'major' | 'critical' | string;
  readonly description: string;
  readonly reported_by: string;
  readonly created_at: string;
}

/** POST /studies/{id}/retests. */
export interface RetestScheduleResult {
  readonly scheduled: readonly {
    readonly pid: string;
    readonly occasion_id: string;
    readonly window_start: string;
    readonly window_end: string;
    readonly status: string;
  }[];
  readonly refused: readonly unknown[];
}

/** POST /studies/{id}/freeze. */
export interface StudyFreezeResult {
  readonly study_id: string;
  readonly frozen_at: string | null;
  readonly snapshot_ids: readonly string[];
}

/** POST /studies/{id}/analysis-plans. */
export interface AnalysisPlanResult {
  readonly plan_id: string;
  readonly study_id: string;
  readonly version: string;
  readonly hypotheses_sha256: string;
  readonly gates_sha256: string;
}

/** GET /validation/matched-records. */
export interface MatchedRecord {
  readonly pid: string;
  readonly occasion_id: string;
  readonly session_ids: readonly string[];
  readonly has_game: boolean;
  readonly has_criterion: boolean;
  readonly instrument_versions: Readonly<Record<string, string>>;
  readonly game_versions: Readonly<Record<string, string>>;
  readonly issues: readonly string[];
  readonly algorithm_version: string;
}

/** GET /features/feature-definitions. */
export interface FeatureDefinition {
  readonly indicator_id: string;
  readonly pathway: string;
  readonly dictionary_version: string;
  readonly algorithm: string | null;
  readonly direction: string | null;
  readonly min_valid_trials: number | null;
  readonly event_inputs: readonly string[] | null;
  readonly exclusions: readonly string[] | null;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** GET /features/group-indicators (not yet in the generated client). */
export interface GroupIndicator {
  readonly study_id: string;
  readonly pathway: string;
  readonly partition: Readonly<Record<string, unknown>>;
  readonly indicator_id: string;
  readonly construct_id: string | null;
  readonly estimate: number | null;
  readonly ci_low: number | null;
  readonly ci_high: number | null;
  readonly n_participants: number;
  readonly n_reports: number;
  readonly suppressed: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly algorithm_version: string;
  readonly scoring_run_id: string | null;
  readonly computed_at: string;
}

/** GET /models/{id}/predictions. */
export interface PredictionRow {
  readonly research_id: string;
  readonly occasion_id: string | null;
  readonly fold: number | null;
  readonly split: string;
  readonly predicted: number | null;
  readonly observed: number | null;
}

/** One gate row of GET /admin/gates. */
export interface GateRow {
  readonly id: number;
  readonly status: string;
  readonly evidence_ids: readonly string[];
  readonly approvers: readonly string[];
  readonly effective_from: string;
  readonly gates_version: string;
  readonly note: string | null;
  readonly recorded_by: string;
  readonly created_at: string;
  readonly language: string;
  readonly pathway: string;
  readonly trait?: string;
  readonly site_mode?: string;
}

/** GET /admin/gates. */
export interface GatesState {
  readonly gates_version: string;
  readonly battery: readonly GateRow[];
  readonly traits: readonly GateRow[];
  readonly battery_history?: readonly GateRow[];
  readonly trait_history?: readonly GateRow[];
}

/** Trait statuses accepted by POST /admin/gates/trait. */
export const TRAIT_STATUSES = [
  'unvalidated',
  'research_only',
  'validated_broad_style',
  'validated_banded',
  'withheld',
] as const;
export type TraitStatus = (typeof TRAIT_STATUSES)[number];

/** A construct mapping row of GET /features/constructs. */
export interface ConstructMapping {
  readonly relation: string;
  readonly pathway: string | null;
  readonly indicator_id: string | null;
  readonly criterion_ref: string | null;
  readonly expected_sign: string | null;
  readonly expected_r_low: number | null;
  readonly expected_r_high: number | null;
}

/** Arms the API accepts (studies.py ArmIn). */
export const ARM_IDS = ['B_fixed', 'A_narrative', 'B_adaptive', 'A_D', 'C'] as const;
/** Study codes the API accepts (studies.py StudyCode). */
export const STUDY_CODES = ['S1', 'S1b', 'S2', 'S3', 'S2-D', 'S4u', 'S5'] as const;
/** Criterion blocks (planned-missing design). */
export const BLOCKS = ['A', 'B', 'C'] as const;
export type Block = (typeof BLOCKS)[number];

/** Analyses the validation engine runs (validation adapter STATIC_ANALYSES order). */
export const ANALYSES = [
  'descriptives',
  'reliability',
  'construct_validity',
  'mtmm',
  'factor_structure',
  'measurement_invariance',
  'dif',
  'fairness',
  'incremental_validity',
] as const;

export const MODEL_COMPARISONS = [
  'game_to_criterion',
  'battery_to_outcome',
  'game_to_outcome',
  'game_plus_battery_to_outcome',
] as const;
export type ModelComparison = (typeof MODEL_COMPARISONS)[number];

export const MODEL_ALGORITHMS = [
  'ridge',
  'elastic_net',
  'random_forest',
  'xgboost',
  'gradient_boosting',
] as const;

export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
