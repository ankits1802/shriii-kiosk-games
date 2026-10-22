/**
 * Predictive validity (spec section 6.4): the four comparisons, (1) criterion from game features,
 * (2) outcome from battery, (3) outcome from game, (4) outcome from game + battery (incremental),
 * with participant-grouped cross-validation and the untouched holdout cohort.
 *
 * Sources: the `incremental_validity` validation run (all four comparisons on one snapshot) and the
 * model registry (`/models`, one comparison per registered model version).
 */
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type EvaluationOut,
  type ResultOut,
} from '../api/types';

export const COMPARISONS = [
  {
    key: 'criterion_from_game',
    registry: 'game_to_criterion',
    label: '1 · Criterion from game',
    description: 'Criterion scale scores predicted from game features alone.',
  },
  {
    key: 'outcome_from_battery',
    registry: 'battery_to_outcome',
    label: '2 · Outcome from battery',
    description: 'External outcome predicted from the questionnaire battery alone.',
  },
  {
    key: 'outcome_from_game',
    registry: 'game_to_outcome',
    label: '3 · Outcome from game',
    description: 'External outcome predicted from game features alone.',
  },
  {
    key: 'outcome_from_game_and_battery',
    registry: 'game_plus_battery_to_outcome',
    label: '4 · Outcome from game + battery',
    description: 'Incremental validity: what the game adds over the battery (most important).',
  },
] as const;
export type ComparisonKey = (typeof COMPARISONS)[number]['key'];

export interface MetricCI {
  readonly estimate: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

export interface ComparisonModelRow {
  readonly comparison: ComparisonKey;
  readonly model: string;
  readonly primary: boolean;
  readonly target: string | null;
  readonly r2: MetricCI;
  readonly mae: MetricCI;
  readonly rmse: MetricCI;
  readonly foldSd: number | null;
  readonly n: number | null;
  readonly nGroups: number | null;
  readonly nFeatures: number;
  readonly row: ResultOut;
}

function metricFrom(value: unknown): MetricCI {
  const r = asRecord(value);
  return {
    estimate: asNumber(r.estimate),
    low: asNumber(r.ci_low),
    high: asNumber(r.ci_high),
  };
}

const isComparison = (s: string): s is ComparisonKey => COMPARISONS.some((c) => c.key === s);

/** Grouped-CV rows of the incremental_validity run, one per comparison × model. */
export function cvComparisons(rows: readonly ResultOut[]): ComparisonModelRow[] {
  return rows
    .filter((r) => r.metric === 'cv_r2' && isComparison(r.subject))
    .map((r) => {
      const d = asRecord(r.details);
      return {
        comparison: r.subject as ComparisonKey,
        model: asString(d.model) ?? 'primary',
        primary: d.primary_model === true,
        target: asString(d.target),
        r2: { estimate: r.estimate, low: r.ci_low, high: r.ci_high },
        mae: metricFrom(d.mae),
        rmse: metricFrom(d.rmse),
        foldSd: asNumber(d.fold_sd),
        n: r.n,
        nGroups: asNumber(d.n_groups),
        nFeatures: asArray(d.features).length,
        row: r,
      };
    });
}

export interface HoldoutRow {
  readonly comparison: ComparisonKey;
  readonly r2: MetricCI;
  readonly mae: number | null;
  readonly rmse: number | null;
  readonly nGroups: number | null;
  readonly target: string | null;
  readonly row: ResultOut;
}

export function holdoutComparisons(rows: readonly ResultOut[]): HoldoutRow[] {
  return rows
    .filter((r) => r.metric === 'holdout_r2' && isComparison(r.subject))
    .map((r) => {
      const d = asRecord(r.details);
      return {
        comparison: r.subject as ComparisonKey,
        r2: { estimate: r.estimate, low: r.ci_low, high: r.ci_high },
        mae: asNumber(d.mae),
        rmse: asNumber(d.rmse),
        nGroups: asNumber(d.n_groups) ?? r.n,
        target: asString(d.target),
        row: r,
      };
    });
}

export interface IncrementalSummary {
  readonly deltaCvR2: MetricCI;
  readonly byModel: readonly { model: string; delta: MetricCI }[];
  readonly hierarchical: readonly {
    block: string;
    deltaR2: MetricCI;
    r2: number | null;
    p: number | null;
    row: ResultOut;
  }[];
  readonly row: ResultOut | null;
}

export function incrementalSummary(rows: readonly ResultOut[]): IncrementalSummary {
  const inc = rows.find((r) => r.metric === 'incremental_cv_r2') ?? null;
  const byModel = Object.entries(asRecord(asRecord(inc?.details).by_model)).map(([model, v]) => {
    const r = asRecord(v);
    return {
      model,
      delta: {
        estimate: asNumber(r.delta_cv_r2),
        low: asNumber(r.ci_low),
        high: asNumber(r.ci_high),
      },
    };
  });
  return {
    deltaCvR2: {
      estimate: inc?.estimate ?? null,
      low: inc?.ci_low ?? null,
      high: inc?.ci_high ?? null,
    },
    byModel,
    hierarchical: rows
      .filter((r) => r.metric === 'delta_r2')
      .map((r) => {
        const d = asRecord(r.details);
        return {
          block: asString(d.block) ?? r.subject.replace(/^block:/, ''),
          deltaR2: { estimate: r.estimate, low: r.ci_low, high: r.ci_high },
          r2: asNumber(d.r2),
          p: asNumber(d.p_F_change),
          row: r,
        };
      }),
    row: inc,
  };
}

export interface RegistryMetrics {
  readonly cv: Readonly<
    Record<
      string,
      {
        value: number | null;
        sd: number | null;
        n: number | null;
        low: number | null;
        high: number | null;
      }
    >
  >;
  readonly holdout: Readonly<
    Record<
      string,
      { value: number | null; n: number | null; low: number | null; high: number | null }
    >
  >;
}

/** Group a registered model's evaluations into CV and holdout metric maps. */
export function registryMetrics(evaluations: readonly EvaluationOut[]): RegistryMetrics {
  const cv: Record<
    string,
    {
      value: number | null;
      sd: number | null;
      n: number | null;
      low: number | null;
      high: number | null;
    }
  > = {};
  const holdout: Record<
    string,
    { value: number | null; n: number | null; low: number | null; high: number | null }
  > = {};
  for (const e of evaluations) {
    const d = asRecord(e.details);
    const ci = asArray(d.ci);
    const low = asNumber(d.ci_low) ?? asNumber(ci[0]);
    const high = asNumber(d.ci_high) ?? asNumber(ci[1]);
    if (e.split === 'holdout') holdout[e.metric] = { value: e.value, n: e.n, low, high };
    else cv[e.metric] = { value: e.value, sd: e.sd, n: e.n, low, high };
  }
  return { cv, holdout };
}

export function comparisonLabel(key: string): string {
  return (
    COMPARISONS.find((c) => c.key === key || c.registry === key)?.label ?? key.replaceAll('_', ' ')
  );
}
