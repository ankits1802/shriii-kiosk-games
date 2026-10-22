'use client';

import { useMemo, useState } from 'react';
import { ForestPlot, type ForestRow, ScatterRegressionChart } from '@/components/charts';
import { ChartFrame, type Provenance } from '@/components/charts/chart-frame';
import { Section } from '@/components/data/page-header';
import { LoadingState } from '@/components/data/states';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCoefficient, formatInteger, formatP } from '@/lib/format';
import { useIndicatorDefinitions } from '../api/hooks';
import { columnLabel, useSnapshotFrame } from '../api/snapshot-frame';
import type { DatasetOut, IndicatorDefinitionOut } from '../api/types';
import { asNumber } from '../api/types';
import { MtmmHeatmap } from '../components/mtmm-heatmap';
import { ResultTable } from '../components/result-table';
import { prov as cleanProv, EstimateCI, PassBadge, ResultProvenance } from '../components/shared';
import {
  criterionCorrelations,
  detail,
  type EvidenceRow,
  exclusionCount,
  indicatorCriterionRows,
  mtmmLabel,
  mtmmMatrices,
  ownVersusDiscriminant,
} from '../lib/results';
import type { ScienceConfig } from '../lib/science';
import { compositeIndicators, constructColumns, directionMap, withComposite } from './frame-views';
import type { LanguageView } from './workbench-page';

export function forestRows(
  rows: readonly EvidenceRow[],
  label: (r: EvidenceRow) => string,
  group?: (r: EvidenceRow) => string,
): ForestRow[] {
  return rows
    .filter((r) => r.estimate !== null && r.ci_low !== null && r.ci_high !== null)
    .map((r) => ({
      label: label(r),
      estimate: r.estimate as number,
      lower: r.ci_low as number,
      upper: r.ci_high as number,
      ...(r.n !== null ? { n: r.n } : {}),
      ...(group ? { group: group(r) } : {}),
    }));
}

export function ConvergentTab({
  rows,
  construct,
  constructName,
  language,
  science,
  snapshot,
  synthetic,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly constructName: string;
  readonly language: LanguageView;
  readonly science: ScienceConfig;
  readonly snapshot: DatasetOut;
  readonly synthetic: boolean;
}) {
  const corr = criterionCorrelations(rows, construct);
  const withEstimates = corr.filter((c) => c.row.estimate !== null);
  const r0 = science.hypotheses.r0;
  const baseProv = { snapshotId: snapshot.snapshot_id, source: 'construct_validity run' };
  const matrices = mtmmMatrices(rows);
  const matrix =
    matrices.find((m) => (language === 'pooled' ? m.language === null : m.language === language)) ??
    matrices[0] ??
    null;
  const ovd = matrix ? ownVersusDiscriminant(matrix, construct) : null;
  const indicatorRows = indicatorCriterionRows(rows, construct).filter((r) =>
    language === 'pooled'
      ? !(r.subgroup as Record<string, unknown>).language
      : (r.subgroup as Record<string, unknown>).language === language,
  );
  const insufficient = corr.filter((c) => c.row.estimate === null);

  return (
    <div className="space-y-6">
      <Section
        title={`Criterion correlations · ${constructName}`}
        description={`Pre-registered hypotheses (hypotheses.yaml), observed Pearson r with 95% CI, pooled and by language. Convergent hypotheses pass when the lower bound exceeds r0 = ${formatCoefficient(r0)} with the expected sign (Holm within the primary family).`}
      >
        {withEstimates.length > 0 ? (
          <ForestPlot
            title="Construct–criterion correlations"
            data={{
              rows: forestRows(
                withEstimates.map((c) => c.row),
                (r) => {
                  const c = withEstimates.find((x) => x.row === r);
                  return `${c?.criterion ?? r.subject} · ${c?.language ?? 'pooled'}`;
                },
                (r) => withEstimates.find((x) => x.row === r)?.relation ?? 'convergent',
              ),
              xLabel: 'Observed r',
              nullValue: 0,
              domain: [-0.6, 0.8],
              ...(r0 !== null
                ? {
                    referenceLines: [
                      { value: r0, label: `r0 ${formatCoefficient(r0)}`, kind: 'target' as const },
                    ],
                  }
                : {}),
            }}
            synthetic={synthetic}
            exportName={`criterion-correlations-${construct}`}
            provenance={{
              ...baseProv,
              n: Math.max(0, ...withEstimates.map((c) => c.row.n ?? 0)),
              exclusions: Math.max(0, ...withEstimates.map((c) => exclusionCount(c.row) ?? 0)),
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No estimable criterion correlation for this construct.
          </p>
        )}
        <ResultTable
          title="Hypothesis results"
          exportName={`hypotheses-${construct}`}
          studyId={snapshot.study_id}
          rows={corr}
          rowKey={(c, i) => `${c.row.subject}-${c.language ?? 'pooled'}-${i}`}
          columns={[
            {
              key: 'h',
              header: 'Hypothesis',
              cell: (c) => <span className="font-mono text-xs">{c.hypothesisId ?? '—'}</span>,
              value: (c) => c.hypothesisId,
            },
            {
              key: 'crit',
              header: 'Criterion',
              cell: (c) => c.criterion,
              value: (c) => c.criterion,
            },
            {
              key: 'rel',
              header: 'Relation',
              cell: (c) => <Badge variant="outline">{c.relation}</Badge>,
              value: (c) => c.relation,
            },
            {
              key: 'lang',
              header: 'Group',
              cell: (c) => c.language ?? 'pooled',
              value: (c) => c.language ?? 'pooled',
            },
            {
              key: 'r',
              header: 'r [95% CI]',
              numeric: true,
              cell: (c) => (
                <EstimateCI estimate={c.row.estimate} low={c.row.ci_low} high={c.row.ci_high} />
              ),
              value: (c) => c.row.estimate,
            },
            {
              key: 'lo',
              header: 'CI low',
              numeric: true,
              cell: () => null,
              value: (c) => c.row.ci_low,
              className: 'hidden',
            },
            {
              key: 'hi',
              header: 'CI high',
              numeric: true,
              cell: () => null,
              value: (c) => c.row.ci_high,
              className: 'hidden',
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (c) => formatInteger(c.row.n),
              value: (c) => c.row.n,
            },
            {
              key: 'p',
              header: 'p (adj.)',
              numeric: true,
              cell: (c) =>
                formatP(asNumber(detail(c.row, 'p_adjusted')) ?? asNumber(detail(c.row, 'p'))),
              value: (c) => asNumber(detail(c.row, 'p_adjusted')),
            },
            {
              key: 'pass',
              header: 'Verdict',
              cell: (c) =>
                c.row.estimate === null ? (
                  <Badge variant="secondary">
                    {String(detail(c.row, 'status') ?? 'insufficient')}
                  </Badge>
                ) : (
                  <PassBadge
                    passed={c.row.passed}
                    labels={['supported', 'not supported', 'not evaluated']}
                  />
                ),
              value: (c) => (c.row.passed === null ? null : c.row.passed),
            },
          ]}
          caption={
            insufficient.length > 0
              ? `${insufficient.length} hypothesis row(s) could not be estimated (missing indicators or criteria in this snapshot).`
              : undefined
          }
        />
      </Section>

      {matrix && (
        <Section
          title="Multitrait–multimethod"
          description="Campbell–Fiske: the validity diagonal (game × self-report for the same construct) should exceed the heterotrait values in its row and column."
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <MtmmHeatmap
              matrix={matrix}
              focus={construct}
              synthetic={synthetic}
              provenance={cleanProv({ ...baseProv, source: 'mtmm run', n: matrix.n })}
            />
            {ovd && (ovd.own !== null || ovd.discriminant.length > 0) && (
              <OwnVsDiscriminant
                construct={construct}
                constructName={constructName}
                own={ovd.own}
                discriminant={ovd.discriminant}
                synthetic={synthetic}
                provenance={cleanProv({ ...baseProv, source: 'mtmm run', n: matrix.n })}
              />
            )}
          </div>
        </Section>
      )}

      <ScatterSection
        rows={rows}
        construct={construct}
        constructName={constructName}
        language={language}
        snapshot={snapshot}
        synthetic={synthetic}
        defaultCriterion={
          withEstimates.find((c) => c.family === 'primary')?.criterion ??
          withEstimates[0]?.criterion ??
          null
        }
      />

      <ResultTable
        title="Indicator × criterion correlations (exploratory)"
        exportName={`indicator-criterion-${construct}`}
        studyId={snapshot.study_id}
        rows={indicatorRows}
        rowKey={(r, i) => `${r.subject}-${i}`}
        columns={[
          {
            key: 'pair',
            header: 'Indicator ~ criterion',
            cell: (r) => <span className="font-mono text-xs">{r.subject}</span>,
            value: (r) => r.subject,
          },
          {
            key: 'r',
            header: 'Pearson r [95% CI]',
            numeric: true,
            cell: (r) => <EstimateCI estimate={r.estimate} low={r.ci_low} high={r.ci_high} />,
            value: (r) => r.estimate,
          },
          {
            key: 'rho',
            header: 'Spearman ρ',
            numeric: true,
            cell: (r) => formatCoefficient(asNumber(detail(r, 'spearman_rho'))),
            value: (r) => asNumber(detail(r, 'spearman_rho')),
          },
          {
            key: 'n',
            header: 'N',
            numeric: true,
            cell: (r) => formatInteger(r.n),
            value: (r) => r.n,
          },
          {
            key: 'ex',
            header: 'Excluded',
            numeric: true,
            cell: (r) => formatInteger(exclusionCount(r)),
            value: (r) => exclusionCount(r) ?? null,
          },
          {
            key: 'p',
            header: 'p',
            numeric: true,
            cell: (r) => formatP(asNumber(detail(r, 'p'))),
            value: (r) => asNumber(detail(r, 'p')),
          },
        ]}
        caption={indicatorRows[0] ? <ResultProvenance row={indicatorRows[0]} /> : undefined}
      />
    </div>
  );
}

function ScatterSection({
  rows,
  construct,
  constructName,
  language,
  snapshot,
  synthetic,
  defaultCriterion,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly constructName: string;
  readonly language: LanguageView;
  readonly snapshot: DatasetOut;
  readonly synthetic: boolean;
  readonly defaultCriterion: string | null;
}) {
  const frameQ = useSnapshotFrame(snapshot);
  const defsQ = useIndicatorDefinitions();
  const frame = frameQ.data;
  const [criterionChoice, setCriterion] = useState<string | null>(null);
  const [xChoice, setX] = useState<string>('composite');
  const criterionCols = frame?.criterionColumns ?? [];
  const criterion =
    criterionChoice ??
    (defaultCriterion && criterionCols.includes(`crit__${defaultCriterion}`)
      ? `crit__${defaultCriterion}`
      : (criterionCols[0] ?? null));
  const reverse = useMemo(
    () => directionMap((defsQ.data ?? []) as IndicatorDefinitionOut[]),
    [defsQ.data],
  );
  const used = compositeIndicators(rows, construct);
  const cols = frame ? constructColumns(frame, construct, reverse, used) : [];
  const points = useMemo(() => {
    if (!frame || !criterion) return [];
    const baseline = frame.rows.filter(
      (r) =>
        (r.occasion_id === 'T1' || !frame.columns.includes('occasion_id')) &&
        r.holdout !== true &&
        (language === 'pooled' || r.language === language),
    );
    const enriched =
      xChoice === 'composite'
        ? withComposite(baseline, cols)
        : baseline.map((row) => ({ row, composite: null }));
    return enriched
      .map(({ row, composite }) => ({
        x: xChoice === 'composite' ? composite : (row[xChoice] as number | null),
        y: row[criterion] as number | null,
        id: String(row.research_id ?? ''),
        group: String(row.language ?? ''),
      }))
      .filter(
        (p): p is { x: number; y: number; id: string; group: string } =>
          typeof p.x === 'number' &&
          Number.isFinite(p.x) &&
          typeof p.y === 'number' &&
          Number.isFinite(p.y),
      );
  }, [frame, criterion, xChoice, cols, language]);

  return (
    <Section
      title="Scatter with regression"
      description="Participants from the snapshot's baseline occasion (holdout cohort excluded), OLS line with 95% confidence band. The composite is a display-only unit-weighted z mean of the indicators the engine used."
    >
      {frameQ.isPending ? (
        <LoadingState rows={3} label="Loading the de-identified snapshot (download is audited)" />
      ) : frameQ.isError || !frame ? (
        <p className="text-sm text-muted-foreground">
          The snapshot file could not be loaded for row-level figures (
          {String((frameQ.error as Error | null)?.message ?? 'unavailable')}).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="scatter-x">
                x
              </Label>
              <Select value={xChoice} onValueChange={setX}>
                <SelectTrigger id="scatter-x" size="sm" className="min-w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="composite">{constructName} composite (display)</SelectItem>
                  {cols.map((c) => (
                    <SelectItem key={c.column} value={c.column}>
                      {columnLabel(c.column)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="scatter-y">
                y (criterion)
              </Label>
              <Select value={criterion ?? ''} onValueChange={setCriterion}>
                <SelectTrigger id="scatter-y" size="sm" className="min-w-56">
                  <SelectValue placeholder="Criterion" />
                </SelectTrigger>
                <SelectContent>
                  {criterionCols.map((c) => (
                    <SelectItem key={c} value={c}>
                      {columnLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {points.length >= 3 && criterion ? (
            <ScatterRegressionChart
              title={`${xChoice === 'composite' ? `${constructName} composite` : columnLabel(xChoice)} vs ${columnLabel(criterion)}`}
              data={{
                points,
                xLabel:
                  xChoice === 'composite' ? `${constructName} composite (z)` : columnLabel(xChoice),
                yLabel: columnLabel(criterion),
              }}
              synthetic={synthetic}
              exportName={`scatter-${construct}`}
              provenance={{
                n: points.length,
                exclusions: frame.rows.length - points.length,
                snapshotId: snapshot.snapshot_id,
                source: 'snapshot Parquet (research ids only)',
                note: 'Excluded = other occasion, holdout cohort, other language, or a missing value.',
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Not enough complete pairs for a scatter plot.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Convergent-vs-discriminant comparison as labelled meters: the validity diagonal first, then the
 * heterotrait correlations involving the construct, by absolute size. Long MTMM labels stay legible.
 */
function OwnVsDiscriminant({
  construct,
  constructName,
  own,
  discriminant,
  synthetic,
  provenance,
}: {
  readonly construct: string;
  readonly constructName: string;
  readonly own: number | null;
  readonly discriminant: readonly { label: string; r: number; kind: string }[];
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}) {
  const rows = [
    { label: 'Own: validity diagonal (game × self-report)', r: own, kind: 'validity' },
    ...discriminant.slice(0, 10).map((d) => ({
      label:
        d.label
          .split(' × ')
          .map(mtmmLabel)
          .filter((l) => !l.endsWith(construct))
          .join(' × ') || d.label.split(' × ').map(mtmmLabel).join(' × '),
      r: d.r,
      kind: d.kind,
    })),
  ];
  const maxDisc = Math.max(0, ...discriminant.map((d) => Math.abs(d.r)));
  const table = {
    columns: [
      { key: 'label', header: 'Correlation' },
      { key: 'kind', header: 'Block' },
      { key: 'r', header: 'r', numeric: true },
    ],
    rows: rows.map((r) => ({ label: r.label, kind: r.kind, r: r.r })),
  };
  return (
    <ChartFrame
      title={`Own vs discriminant · ${constructName}`}
      description={
        own === null
          ? 'No validity diagonal for this construct.'
          : `Validity diagonal |r| = ${formatCoefficient(Math.abs(own))} against the largest discriminant |r| = ${formatCoefficient(maxDisc)} (${Math.abs(own) > maxDisc ? 'pattern holds' : 'pattern does not hold'}).`
      }
      table={table}
      exportName={`own-vs-discriminant-${construct}`}
      provenance={provenance}
      {...(synthetic ? { synthetic: true } : {})}
    >
      {(aria) => (
        <ul aria-label={aria} className="space-y-2 py-1">
          {rows.map((r) => (
            <li
              key={r.label}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
            >
              <span
                className={
                  r.kind === 'validity'
                    ? 'text-sm font-medium'
                    : 'truncate text-xs text-muted-foreground'
                }
                title={r.label}
              >
                {r.label}
              </span>
              <span className="text-right text-xs tabular-nums">{formatCoefficient(r.r)}</span>
              <span className="col-span-2 h-2 overflow-hidden rounded-full bg-muted">
                <span
                  className={
                    r.kind === 'validity'
                      ? 'block h-full rounded-full bg-[var(--series-1)]'
                      : 'block h-full rounded-full bg-muted-foreground/40'
                  }
                  style={{ width: `${Math.min(100, Math.abs(r.r ?? 0) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </ChartFrame>
  );
}
