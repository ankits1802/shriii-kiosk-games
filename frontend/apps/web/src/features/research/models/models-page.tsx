'use client';

/**
 * Predictive validity (spec section 6.4): the four-way comparison with participant-grouped CV
 * metrics and uncertainty, untouched-holdout results, incremental validity, and the model registry
 * (experiments) with out-of-fold and holdout predictions.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { BarCiChart, ForestPlot, ScatterRegressionChart } from '@/components/charts';
import { PageHeader, Section } from '@/components/data/page-header';
import { LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/auth-context';
import { formatDate, formatInteger, formatNumber, formatP, shortId } from '@/lib/format';
import {
  researchKeys,
  useModelEvaluations,
  useModels,
  usePredictions,
  useRunDetails,
  useRuns,
  useTrainingRuns,
} from '../api/hooks';
import { columnLabel } from '../api/snapshot-frame';
import {
  asRecord,
  type EvaluationOut,
  MODEL_ALGORITHMS,
  MODEL_COMPARISONS,
  type ModelOut,
  type RunOut,
  type TrainingRunOut,
} from '../api/types';
import { Field, FormDialog, TextField } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { EstimateCI, prov, ResultProvenance, StatTile } from '../components/shared';
import { useSnapshotSelection } from '../components/snapshot-bar';
import {
  COMPARISONS,
  comparisonLabel,
  cvComparisons,
  holdoutComparisons,
  incrementalSummary,
  registryMetrics,
} from '../lib/models';
import { latestRuns } from '../lib/results';
import { useUrlState } from '../lib/url-state';

export function ModelsPage() {
  const sel = useSnapshotSelection();
  const sid = sel.snapshot?.snapshot_id ?? null;
  const runs = useRuns(sid);
  const latest = useMemo(
    () => latestRuns(runs.data ?? []).get('incremental_validity') ?? null,
    [runs.data],
  );
  const [detail] = useRunDetails(latest ? [latest.run_id] : []);
  const run = (detail?.data ?? null) as RunOut | null;
  const results = run?.results ?? [];
  const cv = cvComparisons(results);
  const holdout = holdoutComparisons(results);
  const inc = incrementalSummary(results);
  const models = [...new Set(cv.map((r) => r.model))];
  const outcome = cv.find((r) => r.comparison !== 'criterion_from_game')?.target ?? null;
  const criterion = cv.find((r) => r.comparison === 'criterion_from_game')?.target ?? null;
  const n = Math.max(0, ...cv.map((r) => r.n ?? 0));
  const baseProv = {
    snapshotId: sid ?? undefined,
    source: 'incremental_validity run',
    algorithmVersion: run?.engine ?? undefined,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description="Does the game predict criterion scores and outcomes, and does it add anything over the questionnaire battery? Splits are grouped by participant (no leakage) and a cohort is held out untouched for final confirmation."
      />
      {sel.bar}
      {sel.blocker ?? (
        <>
          {runs.isPending || detail?.isPending ? (
            <LoadingState rows={5} />
          ) : !run ? (
            <Alert>
              <AlertTitle>No four-way comparison on this snapshot</AlertTitle>
              <AlertDescription>
                Queue the incremental_validity analysis from the validation workbench (Runs tab).
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile
                  label="Incremental CV R² (game over battery)"
                  value={
                    <EstimateCI
                      estimate={inc.deltaCvR2.estimate}
                      low={inc.deltaCvR2.low}
                      high={inc.deltaCvR2.high}
                      coefficient={false}
                    />
                  }
                  sub={`outcome ${outcome ? columnLabel(outcome) : '—'} · primary model ${String(asRecord(inc.row?.details).primary_model ?? models[0] ?? '—')}`}
                />
                <StatTile
                  label="Criterion target"
                  value={
                    <span className="text-lg">{criterion ? columnLabel(criterion) : '—'}</span>
                  }
                  sub="comparison 1"
                />
                <StatTile
                  label="Participants (CV)"
                  value={formatInteger(n)}
                  sub={`${formatInteger(cv[0]?.nGroups)} participant groups · 5-fold grouped CV`}
                />
                <StatTile
                  label="Holdout participants"
                  value={formatInteger(holdout[0]?.nGroups ?? null)}
                  sub="untouched cohort, scored once"
                />
              </div>
              <Section
                title="Four-way predictive comparison"
                description="Cross-validated R² with bootstrap 95% CIs per comparison and model. Negative R² means worse than predicting the mean."
              >
                <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <BarCiChart
                    title="Grouped-CV R² by comparison"
                    data={{
                      categories: COMPARISONS.map((c) => c.label),
                      series: models.map((m) => ({
                        name: m,
                        values: COMPARISONS.map((c) => {
                          const r = cv.find((x) => x.comparison === c.key && x.model === m);
                          return r
                            ? { value: r.r2.estimate, lower: r.r2.low, upper: r.r2.high, n: r.n }
                            : { value: null };
                        }),
                      })),
                      valueLabel: 'CV R²',
                      valueStyle: 'number',
                      domain: [-0.2, 0.6],
                      // Unlabelled: the section description explains the zero (mean-only) baseline, and an
                      // in-plot label collides with the last comparison group.
                      referenceLines: [{ value: 0, label: '', kind: 'null' }],
                    }}
                    synthetic={sel.synthetic}
                    exportName="four-way-comparison"
                    provenance={prov({
                      ...baseProv,
                      n,
                      note: 'Participant-grouped 5-fold CV (research_id); hyper-parameters tuned in inner folds.',
                    })}
                  />
                  <div className="space-y-2">
                    {COMPARISONS.map((c) => (
                      <div key={c.key} className="rounded-lg border bg-card p-3">
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="text-xs text-muted-foreground">{c.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <ResultTable
                  exportName="four-way-comparison-metrics"
                  studyId={sel.study?.study_id ?? null}
                  rows={cv}
                  rowKey={(r) => `${r.comparison}-${r.model}`}
                  columns={[
                    {
                      key: 'c',
                      header: 'Comparison',
                      cell: (r) => comparisonLabel(r.comparison),
                      value: (r) => r.comparison,
                    },
                    {
                      key: 'm',
                      header: 'Model',
                      cell: (r) => (
                        <span>
                          {r.model}
                          {r.primary && (
                            <Badge variant="secondary" className="ml-1.5">
                              primary
                            </Badge>
                          )}
                        </span>
                      ),
                      value: (r) => r.model,
                    },
                    {
                      key: 't',
                      header: 'Target',
                      cell: (r) => (
                        <span className="font-mono text-xs">
                          {r.target ? columnLabel(r.target) : '—'}
                        </span>
                      ),
                      value: (r) => r.target,
                    },
                    {
                      key: 'r2',
                      header: 'CV R² [95% CI]',
                      numeric: true,
                      cell: (r) => (
                        <EstimateCI
                          estimate={r.r2.estimate}
                          low={r.r2.low}
                          high={r.r2.high}
                          coefficient={false}
                        />
                      ),
                      value: (r) => r.r2.estimate,
                    },
                    {
                      key: 'mae',
                      header: 'MAE [95% CI]',
                      numeric: true,
                      cell: (r) => (
                        <EstimateCI
                          estimate={r.mae.estimate}
                          low={r.mae.low}
                          high={r.mae.high}
                          coefficient={false}
                        />
                      ),
                      value: (r) => r.mae.estimate,
                    },
                    {
                      key: 'rmse',
                      header: 'RMSE [95% CI]',
                      numeric: true,
                      cell: (r) => (
                        <EstimateCI
                          estimate={r.rmse.estimate}
                          low={r.rmse.low}
                          high={r.rmse.high}
                          coefficient={false}
                        />
                      ),
                      value: (r) => r.rmse.estimate,
                    },
                    {
                      key: 'sd',
                      header: 'Fold SD',
                      numeric: true,
                      cell: (r) => formatNumber(r.foldSd),
                      value: (r) => r.foldSd,
                    },
                    {
                      key: 'f',
                      header: 'Features',
                      numeric: true,
                      cell: (r) => r.nFeatures,
                      value: (r) => r.nFeatures,
                    },
                    {
                      key: 'n',
                      header: 'N',
                      numeric: true,
                      cell: (r) => formatInteger(r.n),
                      value: (r) => r.n,
                    },
                  ]}
                  caption={cv[0] ? <ResultProvenance row={cv[0].row} /> : undefined}
                />
              </Section>
              <div className="grid gap-4 xl:grid-cols-2">
                <Section
                  title="Untouched holdout"
                  description="Primary model refit on all training participants and scored once on the holdout cohort."
                >
                  <ForestPlot
                    title="Holdout R²"
                    data={{
                      rows: holdout
                        .filter(
                          (h) => h.r2.estimate !== null && h.r2.low !== null && h.r2.high !== null,
                        )
                        .map((h) => ({
                          label: comparisonLabel(h.comparison),
                          estimate: h.r2.estimate as number,
                          lower: h.r2.low as number,
                          upper: h.r2.high as number,
                          ...(h.nGroups !== null ? { n: h.nGroups } : {}),
                        })),
                      xLabel: 'Holdout R²',
                      nullValue: 0,
                      valueStyle: 'number',
                    }}
                    synthetic={sel.synthetic}
                    exportName="holdout-r2"
                    provenance={prov({
                      ...baseProv,
                      n: holdout[0]?.nGroups,
                      note: 'Small holdout cohorts give wide intervals; this confirms, it does not select.',
                    })}
                  />
                </Section>
                <Section
                  title="Incremental validity"
                  description="Hierarchical regression on complete cases: battery block first, then the game block (participant-clustered bootstrap CI)."
                >
                  <ResultTable
                    exportName="hierarchical-delta-r2"
                    rows={inc.hierarchical}
                    rowKey={(h) => h.block}
                    columns={[
                      {
                        key: 'b',
                        header: 'Block added',
                        cell: (h) => h.block,
                        value: (h) => h.block,
                      },
                      {
                        key: 'd',
                        header: 'ΔR² [95% CI]',
                        numeric: true,
                        cell: (h) => (
                          <EstimateCI
                            estimate={h.deltaR2.estimate}
                            low={h.deltaR2.low}
                            high={h.deltaR2.high}
                            coefficient={false}
                          />
                        ),
                        value: (h) => h.deltaR2.estimate,
                      },
                      {
                        key: 'r2',
                        header: 'Cumulative R²',
                        numeric: true,
                        cell: (h) => formatNumber(h.r2),
                        value: (h) => h.r2,
                      },
                      {
                        key: 'p',
                        header: 'F change',
                        numeric: true,
                        cell: (h) => formatP(h.p),
                        value: (h) => h.p,
                      },
                      {
                        key: 'n',
                        header: 'N',
                        numeric: true,
                        cell: (h) => formatInteger(h.row.n),
                        value: (h) => h.row.n,
                      },
                    ]}
                  />
                  <ResultTable
                    title="Incremental CV R² by model"
                    rows={inc.byModel}
                    rowKey={(m) => m.model}
                    columns={[
                      { key: 'm', header: 'Model', cell: (m) => m.model },
                      {
                        key: 'd',
                        header: 'ΔCV R² [95% CI]',
                        numeric: true,
                        cell: (m) => (
                          <EstimateCI
                            estimate={m.delta.estimate}
                            low={m.delta.low}
                            high={m.delta.high}
                            coefficient={false}
                          />
                        ),
                      },
                    ]}
                  />
                </Section>
              </div>
            </>
          )}
          <Experiments
            snapshotId={sid}
            synthetic={sel.synthetic}
            columns={(asRecord(sel.snapshot?.manifest).columns as string[] | undefined) ?? []}
          />
        </>
      )}
    </div>
  );
}

function Experiments({
  snapshotId,
  synthetic,
  columns,
}: {
  readonly snapshotId: string | null;
  readonly synthetic: boolean;
  readonly columns: readonly string[];
}) {
  const models = useModels(snapshotId);
  const list = models.data ?? [];
  const ids = list.map((m) => m.model_id);
  const evals = useModelEvaluations(ids);
  const trainings = useTrainingRuns(ids);
  const [modelParam, setModel] = useUrlState('model');
  const selected = list.find((m) => m.model_id === modelParam) ?? list[0] ?? null;
  const metricsOf = (id: string) =>
    registryMetrics((evals[ids.indexOf(id)]?.data ?? []) as EvaluationOut[]);
  const trainingOf = (id: string) =>
    ((trainings[ids.indexOf(id)]?.data ?? []) as TrainingRunOut[])[0] ?? null;
  return (
    <Section
      title="Experiments"
      description="Registered model versions on this snapshot: each one trains with participant-grouped nested CV and is scored once on its holdout cohort."
      actions={
        snapshotId && (
          <Can all={['models.write']}>
            <RegisterModel snapshotId={snapshotId} columns={columns} />
          </Can>
        )
      }
    >
      {models.isPending ? (
        <LoadingState rows={3} />
      ) : (
        <ResultTable
          exportName="model-registry"
          rows={list}
          rowKey={(m) => m.model_id}
          empty="No models registered on this snapshot."
          columns={[
            {
              key: 'name',
              header: 'Model',
              cell: (m) => (
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => setModel(m.model_id)}
                >
                  <span className="font-medium">{m.name}</span>{' '}
                  <span className="text-xs text-muted-foreground">v{m.version}</span>
                  {selected?.model_id === m.model_id && (
                    <Badge variant="info" className="ml-1.5">
                      selected
                    </Badge>
                  )}
                </button>
              ),
              value: (m) => m.name,
            },
            {
              key: 'cmp',
              header: 'Comparison',
              cell: (m) => comparisonLabel(m.comparison),
              value: (m) => m.comparison,
            },
            {
              key: 'alg',
              header: 'Algorithm',
              cell: (m) => m.algorithm,
              value: (m) => m.algorithm,
            },
            {
              key: 't',
              header: 'Target',
              cell: (m) => <span className="font-mono text-xs">{columnLabel(m.target)}</span>,
              value: (m) => m.target,
            },
            {
              key: 'f',
              header: 'Features',
              numeric: true,
              cell: (m) => m.features.length,
              value: (m) => m.features.length,
            },
            {
              key: 'cv',
              header: 'CV R² ± SD',
              numeric: true,
              cell: (m) => {
                const r = metricsOf(m.model_id).cv.r2;
                return r ? `${formatNumber(r.value)} ± ${formatNumber(r.sd)}` : '—';
              },
              value: (m) => metricsOf(m.model_id).cv.r2?.value ?? null,
            },
            {
              key: 'ho',
              header: 'Holdout R² [95% CI]',
              numeric: true,
              cell: (m) => {
                const r = metricsOf(m.model_id).holdout.r2;
                return r ? (
                  <EstimateCI estimate={r.value} low={r.low} high={r.high} coefficient={false} />
                ) : (
                  '—'
                );
              },
              value: (m) => metricsOf(m.model_id).holdout.r2?.value ?? null,
            },
            {
              key: 'n',
              header: 'N train / holdout',
              numeric: true,
              cell: (m) => {
                const t = trainingOf(m.model_id);
                const mt = asRecord(t?.metrics);
                return `${formatInteger(mt.n_train as number)} / ${formatInteger(mt.n_holdout as number)}`;
              },
            },
            {
              key: 's',
              header: 'Status',
              cell: (m) => <StatusBadge status={trainingOf(m.model_id)?.status ?? m.status} />,
              value: (m) => m.status,
            },
            {
              key: 'at',
              header: 'Registered',
              cell: (m) => formatDate(m.created_at),
              value: (m) => m.created_at,
            },
          ]}
        />
      )}
      {selected && (
        <ModelDetail
          model={selected}
          training={trainingOf(selected.model_id)}
          evaluations={(evals[ids.indexOf(selected.model_id)]?.data ?? []) as EvaluationOut[]}
          synthetic={synthetic}
        />
      )}
    </Section>
  );
}

function ModelDetail({
  model,
  training,
  evaluations,
  synthetic,
}: {
  readonly model: ModelOut;
  readonly training: TrainingRunOut | null;
  readonly evaluations: readonly EvaluationOut[];
  readonly synthetic: boolean;
}) {
  const preds = usePredictions(model.model_id);
  const metrics = asRecord(training?.metrics);
  const provenance = asRecord(metrics.provenance);
  const points = (preds.data ?? [])
    .filter((p) => p.predicted !== null && p.observed !== null)
    .map((p) => ({
      x: p.predicted as number,
      y: p.observed as number,
      id: p.research_id,
      group: p.split === 'holdout' ? 'holdout' : 'out-of-fold',
    }));
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <ScatterRegressionChart
        title={`Observed vs predicted · ${model.name}`}
        description="Out-of-fold predictions for training participants and one-shot holdout predictions (research ids only)."
        data={{
          points,
          xLabel: `Predicted ${columnLabel(model.target)}`,
          yLabel: `Observed ${columnLabel(model.target)}`,
        }}
        synthetic={synthetic}
        exportName={`predictions-${model.name}`}
        provenance={prov({
          n: points.length,
          snapshotId: model.snapshot_id,
          source: `training run ${training ? shortId(training.run_id) : '—'}`,
          algorithmVersion: training?.engine ?? undefined,
        })}
      />
      <div className="space-y-3">
        <ResultTable
          title="Evaluation metrics"
          exportName={`evaluations-${model.name}`}
          rows={[...evaluations].sort(
            (a, b) => a.split.localeCompare(b.split) || a.metric.localeCompare(b.metric),
          )}
          rowKey={(e) => `${e.split}-${e.metric}`}
          columns={[
            { key: 's', header: 'Split', cell: (e) => e.split, value: (e) => e.split },
            {
              key: 'm',
              header: 'Metric',
              cell: (e) => e.metric.toUpperCase(),
              value: (e) => e.metric,
            },
            {
              key: 'v',
              header: 'Value [95% CI]',
              numeric: true,
              cell: (e) => (
                <EstimateCI
                  estimate={e.value}
                  low={(e.details?.ci_low as number | null | undefined) ?? null}
                  high={(e.details?.ci_high as number | null | undefined) ?? null}
                  coefficient={false}
                />
              ),
              value: (e) => e.value,
            },
            {
              key: 'sd',
              header: 'SD',
              numeric: true,
              cell: (e) => formatNumber(e.sd),
              value: (e) => e.sd,
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (e) => formatInteger(e.n),
              value: (e) => e.n,
            },
          ]}
        />
        <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
          <p>CV scheme: {describeCvScheme(metrics.cv_scheme)}</p>
          <p>Leakage check: {String(metrics.leakage_check ?? '—')}</p>
          <p>Features: {model.features.map(columnLabel).join(', ')}</p>
          <p>
            Holdout cohort: {model.holdout_cohort ?? 'none'} · frame sha{' '}
            {String(provenance.frame_sha256 ?? '').slice(0, 12)} · git{' '}
            {String(provenance.git_sha ?? '').slice(0, 8)}
          </p>
        </div>
      </div>
    </div>
  );
}

function RegisterModel({
  snapshotId,
  columns,
}: {
  readonly snapshotId: string;
  readonly columns: readonly string[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const indicatorCols = columns.filter((c) => c.startsWith('ind__'));
  const criterionCols = columns.filter((c) => c.startsWith('crit__'));
  const [form, setForm] = useState<{
    name: string;
    version: string;
    comparison: (typeof MODEL_COMPARISONS)[number];
    target: string;
    algorithm: (typeof MODEL_ALGORITHMS)[number];
    holdout: string;
    features: string[];
  }>({
    name: '',
    version: '0.1.0',
    comparison: 'game_to_criterion',
    target: criterionCols[0] ?? '',
    algorithm: 'ridge',
    holdout: 'holdout',
    features: [],
  });
  const pool =
    form.comparison === 'battery_to_outcome'
      ? criterionCols
      : form.comparison === 'game_plus_battery_to_outcome'
        ? [...indicatorCols, ...criterionCols]
        : indicatorCols;
  const register = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/models', {
          body: {
            name: form.name,
            version: form.version,
            comparison: form.comparison,
            target: form.target,
            features: form.features, // The committed generated schema predates the backend's full algorithm list (models.py).
            algorithm: form.algorithm as 'ridge',
            params: {},
            snapshot_id: snapshotId,
            holdout_cohort: form.holdout || null,
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Model registered; training queued.');
      await qc.invalidateQueries({ queryKey: researchKeys.models(snapshotId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const leak = form.features.includes(form.target);
  return (
    <FormDialog
      title="Register a model version"
      description="The target can never be a feature; splits are grouped by participant."
      wide
      trigger={
        <Button size="sm" variant="outline">
          <PlusIcon aria-hidden="true" /> Register model
        </Button>
      }
      pending={register.isPending}
      disabled={
        !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(form.name) ||
        !form.target ||
        form.features.length === 0 ||
        leak
      }
      onSubmit={async () => {
        try {
          await register.mutateAsync();
          return true;
        } catch {
          return false;
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="m-name"
          label="Name"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
          placeholder="bscs-from-game"
          hint="lower-case, digits, . _ -"
        />
        <TextField
          id="m-version"
          label="Version"
          value={form.version}
          onChange={(v) => setForm({ ...form, version: v })}
        />
        <Field id="m-cmp" label="Comparison">
          <Select
            value={form.comparison}
            onValueChange={(v) =>
              setForm({ ...form, comparison: v as typeof form.comparison, features: [] })
            }
          >
            <SelectTrigger id="m-cmp" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_COMPARISONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {comparisonLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="m-alg" label="Algorithm">
          <Select
            value={form.algorithm}
            onValueChange={(v) => setForm({ ...form, algorithm: v as typeof form.algorithm })}
          >
            <SelectTrigger id="m-alg" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_ALGORITHMS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a.replaceAll('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="m-target" label="Target">
          <Select value={form.target} onValueChange={(v) => setForm({ ...form, target: v })}>
            <SelectTrigger id="m-target" className="w-full">
              <SelectValue placeholder="criterion or outcome column" />
            </SelectTrigger>
            <SelectContent>
              {criterionCols.map((c) => (
                <SelectItem key={c} value={c}>
                  {columnLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <TextField
          id="m-holdout"
          label="Holdout cohort"
          value={form.holdout}
          onChange={(v) => setForm({ ...form, holdout: v })}
        />
        <Field
          id="m-features"
          label={`Features (${form.features.length} selected)`}
          className="sm:col-span-2"
          hint={leak ? 'The target is selected as a feature (leakage).' : undefined}
        >
          <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
            {pool.length === 0 && (
              <span className="text-xs text-muted-foreground">
                The snapshot manifest lists no matching columns.
              </span>
            )}
            {pool.map((c) => (
              <label key={c} htmlFor={`f-${c}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`f-${c}`}
                  checked={form.features.includes(c)}
                  onCheckedChange={(v) =>
                    setForm({
                      ...form,
                      features:
                        v === true ? [...form.features, c] : form.features.filter((x) => x !== c),
                    })
                  }
                />
                <span className="font-mono">{columnLabel(c)}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </FormDialog>
  );
}

/** Human-readable CV scheme, e.g. "nested group k-fold · grouped by research_id · outer 5 / inner 3". */
function describeCvScheme(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '—';
  const scheme = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof scheme.kind === 'string') parts.push(scheme.kind.replaceAll('_', ' '));
  if (scheme.groups) parts.push(`grouped by ${String(scheme.groups)}`);
  const folds = [
    scheme.outer_folds != null ? `outer ${String(scheme.outer_folds)}` : null,
    scheme.inner_folds != null ? `inner ${String(scheme.inner_folds)}` : null,
  ].filter((x): x is string => x !== null);
  if (folds.length) parts.push(folds.join(' / '));
  const known = new Set(['kind', 'groups', 'outer_folds', 'inner_folds']);
  for (const [k, v] of Object.entries(scheme)) {
    if (!known.has(k) && v != null && typeof v !== 'object')
      parts.push(`${k.replaceAll('_', ' ')} ${String(v)}`);
  }
  return parts.join(' · ') || '—';
}
