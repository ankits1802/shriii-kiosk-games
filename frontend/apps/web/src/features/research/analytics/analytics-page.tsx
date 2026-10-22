'use client';

/**
 * Exploratory and longitudinal analytics over one de-identified snapshot: feature distributions and
 * outliers, group and game-version comparisons, and retest trajectories. All of it is exploratory
 * (labelled as such); confirmatory evidence lives in the validation workbench.
 */
import { useMemo, useState } from 'react';
import { BarCiChart, DistributionChart, ScatterRegressionChart } from '@/components/charts';
import { PageHeader } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatInteger, formatNumber } from '@/lib/format';
import { mean, sd } from '@/lib/stats/describe';
import { columnLabel, type SnapshotFrame, useSnapshotFrame } from '../api/snapshot-frame';
import { ResultTable } from '../components/result-table';
import { EstimateCI, prov } from '../components/shared';
import { useSnapshotSelection } from '../components/snapshot-bar';
import {
  groupMeans,
  levels,
  outliers,
  pairedOccasions,
  trajectorySummary,
  versionComparison,
} from '../lib/analytics';
import type { ScienceConfig } from '../lib/science';
import { useUrlState } from '../lib/url-state';

const GROUPINGS = [
  'language',
  'age_band',
  'literacy_band',
  'edu_band',
  'gender',
  'arm_id',
  'app_version',
  'cohort_id',
] as const;

function ColumnSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly string[];
  readonly onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id={id} size="sm" className="min-w-64">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {columnLabel(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AnalyticsPage({ science }: { readonly science: ScienceConfig }) {
  const sel = useSnapshotSelection();
  const frameQ = useSnapshotFrame(sel.snapshot);
  const [tab, setTab] = useUrlState('view');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Exploratory views of one snapshot: how indicators are distributed, where the outliers are, how groups and game versions differ, and how scores move between occasions. Exploratory only; nothing here is a confirmatory test."
        meta={<Badge variant="secondary">exploratory</Badge>}
      />
      {sel.bar}
      {sel.blocker ??
        (frameQ.isPending ? (
          <LoadingState rows={6} label="Loading the de-identified snapshot (download is audited)" />
        ) : frameQ.isError || !frameQ.data ? (
          <ErrorState error={frameQ.error} onRetry={() => void frameQ.refetch()} />
        ) : (
          <Tabs
            value={tab ?? 'distributions'}
            onValueChange={(v) => setTab(v === 'distributions' ? null : v)}
          >
            <TabsList>
              <TabsTrigger value="distributions">Distributions &amp; outliers</TabsTrigger>
              <TabsTrigger value="groups">Groups &amp; game versions</TabsTrigger>
              <TabsTrigger value="longitudinal">Longitudinal</TabsTrigger>
            </TabsList>
            <TabsContent value="distributions">
              <Distributions
                frame={frameQ.data}
                synthetic={sel.synthetic}
                snapshotId={sel.snapshot?.snapshot_id ?? ''}
              />
            </TabsContent>
            <TabsContent value="groups">
              <Groups
                frame={frameQ.data}
                synthetic={sel.synthetic}
                snapshotId={sel.snapshot?.snapshot_id ?? ''}
              />
            </TabsContent>
            <TabsContent value="longitudinal">
              <Longitudinal
                frame={frameQ.data}
                synthetic={sel.synthetic}
                snapshotId={sel.snapshot?.snapshot_id ?? ''}
                practiceFlag={science.gates.practiceEffectDFlag}
              />
            </TabsContent>
          </Tabs>
        ))}
    </div>
  );
}

function baseline(frame: SnapshotFrame) {
  const occ = levels(frame.rows, 'occasion_id')[0];
  return occ ? frame.rows.filter((r) => r.occasion_id === occ) : frame.rows;
}

function Distributions({
  frame,
  synthetic,
  snapshotId,
}: {
  readonly frame: SnapshotFrame;
  readonly synthetic: boolean;
  readonly snapshotId: string;
}) {
  const measures = useMemo(
    () => [...frame.indicatorColumns, ...frame.criterionColumns],
    [frame.indicatorColumns, frame.criterionColumns],
  );
  const [column, setColumn] = useState<string | null>(frame.indicatorColumns[0] ?? null);
  const [grouping, setGrouping] = useState<string>('language');
  const rows = useMemo(() => baseline(frame), [frame]);
  const summary = useMemo(
    () =>
      measures.map((c) => ({ column: c, out: outliers(rows, c) })).filter((x) => x.out !== null),
    [measures, rows],
  );
  const selected = column ? outliers(rows, column) : null;
  const groups = column
    ? levels(rows, grouping)
        .slice(0, 3)
        .map((g) => ({
          name: g,
          values: rows
            .filter((r) => String(r[grouping]) === g)
            .map((r) => (typeof r[column] === 'number' ? (r[column] as number) : null)),
        }))
    : [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <ColumnSelect
          id="dist-col"
          label="Measure"
          value={column}
          options={measures}
          onChange={setColumn}
        />
        <div className="space-y-1">
          <Label htmlFor="dist-group" className="text-xs">
            Density by
          </Label>
          <Select value={grouping} onValueChange={setGrouping}>
            <SelectTrigger id="dist-group" size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPINGS.filter((g) => frame.columns.includes(g)).map((g) => (
                <SelectItem key={g} value={g}>
                  {g.replace('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {column && selected && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <DistributionChart
            title={`Distribution · ${columnLabel(column)}`}
            description={`Baseline occasion, histogram with density overlays by ${grouping.replace('_', ' ')} (first three groups). Lines mark Tukey fences.`}
            data={{
              values: rows.map((r) =>
                typeof r[column] === 'number' ? (r[column] as number) : null,
              ),
              xLabel: columnLabel(column),
              groups,
              referenceLines: [
                { value: selected.lowerFence, label: 'lower fence', kind: 'null' },
                { value: selected.upperFence, label: 'upper fence', kind: 'null' },
              ],
            }}
            synthetic={synthetic}
            exportName={`distribution-${columnLabel(column)}`}
            provenance={prov({
              n: selected.n,
              exclusions: selected.missing,
              snapshotId,
              source: 'snapshot Parquet',
              note: 'Excluded = missing (insufficient trials, planned-missing slot, not administered).',
            })}
          />
          <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
            <p className="font-semibold">Outliers</p>
            <p>
              Tukey 1.5 × IQR: <span className="font-medium tabular-nums">{selected.tukey}</span>
            </p>
            <p>
              Robust |z| &gt; {selected.robustCutoff} (MAD):{' '}
              <span className="font-medium tabular-nums">{selected.robust}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Median {formatNumber(selected.median)} · IQR {formatNumber(selected.q1)} to{' '}
              {formatNumber(selected.q3)} · N {selected.n} · missing {selected.missing}
            </p>
            {selected.flaggedIds.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer">
                  {selected.flaggedIds.length} flagged research ids
                </summary>
                <p className="mt-1 break-all font-mono">{selected.flaggedIds.join(', ')}</p>
              </details>
            )}
            <p className="text-xs text-muted-foreground">
              Flags are for review; nothing is removed from analyses here.
            </p>
          </div>
        </div>
      )}
      <ResultTable
        title="All measures (baseline occasion)"
        exportName="measure-descriptives"
        rows={summary}
        rowKey={(s) => s.column}
        columns={[
          {
            key: 'c',
            header: 'Measure',
            cell: (s) => (
              <button
                type="button"
                className="font-mono text-xs text-primary hover:underline"
                onClick={() => setColumn(s.column)}
              >
                {columnLabel(s.column)}
              </button>
            ),
            value: (s) => s.column,
          },
          {
            key: 'layer',
            header: 'Layer',
            cell: (s) => (s.column.startsWith('ind__') ? 'indicator' : 'criterion'),
            value: (s) => (s.column.startsWith('ind__') ? 'indicator' : 'criterion'),
          },
          {
            key: 'n',
            header: 'N',
            numeric: true,
            cell: (s) => formatInteger(s.out?.n),
            value: (s) => s.out?.n ?? null,
          },
          {
            key: 'miss',
            header: 'Missing',
            numeric: true,
            cell: (s) => formatInteger(s.out?.missing),
            value: (s) => s.out?.missing ?? null,
          },
          {
            key: 'med',
            header: 'Median',
            numeric: true,
            cell: (s) => formatNumber(s.out?.median),
            value: (s) => s.out?.median ?? null,
          },
          {
            key: 'iqr',
            header: 'Q1 – Q3',
            numeric: true,
            cell: (s) => `${formatNumber(s.out?.q1)} – ${formatNumber(s.out?.q3)}`,
            value: (s) => (s.out ? s.out.q3 - s.out.q1 : null),
          },
          {
            key: 't',
            header: 'Tukey outliers',
            numeric: true,
            cell: (s) => s.out?.tukey ?? '—',
            value: (s) => s.out?.tukey ?? null,
          },
          {
            key: 'r',
            header: 'Robust outliers',
            numeric: true,
            cell: (s) => s.out?.robust ?? '—',
            value: (s) => s.out?.robust ?? null,
          },
        ]}
      />
    </div>
  );
}

function Groups({
  frame,
  synthetic,
  snapshotId,
}: {
  readonly frame: SnapshotFrame;
  readonly synthetic: boolean;
  readonly snapshotId: string;
}) {
  const measures = [...frame.indicatorColumns, ...frame.criterionColumns];
  const [column, setColumn] = useState<string | null>(frame.indicatorColumns[0] ?? null);
  const available = GROUPINGS.filter((g) => frame.columns.includes(g));
  const [grouping, setGrouping] = useState<string>(
    available.includes('app_version') ? 'app_version' : (available[0] ?? 'language'),
  );
  const rows = useMemo(() => baseline(frame), [frame]);
  const means = column ? groupMeans(rows, column, grouping) : [];
  const diffs = useMemo(
    () =>
      frame.indicatorColumns.flatMap((c) =>
        versionComparison(rows, c, grouping).map((d) => ({ column: c, ...d })),
      ),
    [frame.indicatorColumns, rows, grouping],
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <ColumnSelect
          id="grp-col"
          label="Measure"
          value={column}
          options={measures}
          onChange={setColumn}
        />
        <div className="space-y-1">
          <Label htmlFor="grp-by" className="text-xs">
            Compare by
          </Label>
          <Select value={grouping} onValueChange={setGrouping}>
            <SelectTrigger id="grp-by" size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {available.map((g) => (
                <SelectItem key={g} value={g}>
                  {g === 'app_version' ? 'game version' : g.replace('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {grouping === 'app_version' && (
        <Alert variant="info">
          <AlertTitle>Game version comparison</AlertTitle>
          <AlertDescription>
            Differences between app versions can reflect content or timing changes; a version that
            shifts an indicator should be reviewed before pooling (the scoring dictionary records
            the version of every value).
          </AlertDescription>
        </Alert>
      )}
      {column && means.length > 0 && (
        <BarCiChart
          title={`${columnLabel(column)} by ${grouping === 'app_version' ? 'game version' : grouping.replace('_', ' ')}`}
          description="Group means with 95% t confidence intervals (baseline occasion)."
          data={{
            categories: means.map((m) => m.group),
            series: [
              {
                name: 'Mean',
                values: means.map((m) => ({
                  value: m.mean,
                  lower: m.lower,
                  upper: m.upper,
                  n: m.n,
                })),
              },
            ],
            valueLabel: columnLabel(column),
            valueStyle: 'number',
          }}
          synthetic={synthetic}
          exportName={`group-means-${columnLabel(column)}-${grouping}`}
          provenance={prov({
            n: means.reduce((a, m) => a + m.n, 0),
            exclusions: rows.length - means.reduce((a, m) => a + m.n, 0),
            snapshotId,
            source: 'snapshot Parquet',
          })}
        />
      )}
      <ResultTable
        title={`Standardised differences by ${grouping === 'app_version' ? 'game version' : grouping.replace('_', ' ')} (Hedges' g vs the first group)`}
        exportName={`standardised-differences-${grouping}`}
        rows={diffs}
        rowKey={(d) => `${d.column}-${d.focal}`}
        columns={[
          {
            key: 'c',
            header: 'Indicator',
            cell: (d) => <span className="font-mono text-xs">{columnLabel(d.column)}</span>,
            value: (d) => d.column,
          },
          {
            key: 'cmp',
            header: 'Comparison',
            cell: (d) => `${d.focal} vs ${d.reference}`,
            value: (d) => `${d.focal} vs ${d.reference}`,
          },
          {
            key: 'g',
            header: 'g [95% CI]',
            numeric: true,
            cell: (d) => (
              <EstimateCI estimate={d.g} low={d.lower} high={d.upper} coefficient={false} />
            ),
            value: (d) => d.g,
          },
          {
            key: 'n',
            header: 'N (ref / focal)',
            numeric: true,
            cell: (d) => `${d.nReference} / ${d.nFocal}`,
          },
        ]}
      />
    </div>
  );
}

function Longitudinal({
  frame,
  synthetic,
  snapshotId,
  practiceFlag,
}: {
  readonly frame: SnapshotFrame;
  readonly synthetic: boolean;
  readonly snapshotId: string;
  readonly practiceFlag: number | null;
}) {
  const occasions = levels(frame.rows, 'occasion_id');
  const measures = [...frame.indicatorColumns, ...frame.criterionColumns];
  const [column, setColumn] = useState<string | null>(
    frame.criterionColumns[0] ?? frame.indicatorColumns[0] ?? null,
  );
  const [first, second] = occasions;
  if (!first || !second) {
    return (
      <Alert>
        <AlertTitle>One occasion only</AlertTitle>
        <AlertDescription>Trajectories need a snapshot with a retest occasion.</AlertDescription>
      </Alert>
    );
  }
  const pairs = column ? pairedOccasions(frame.rows, column, first, second, 'language') : [];
  const traj = trajectorySummary(pairs);
  const all = measures
    .map((c) => ({
      column: c,
      s: trajectorySummary(pairedOccasions(frame.rows, c, first, second)),
    }))
    .filter((x) => x.s.n > 1);
  const byOcc = column
    ? occasions.map((o) => {
        const v = frame.rows
          .filter((r) => r.occasion_id === o && typeof r[column] === 'number')
          .map((r) => r[column] as number);
        return { o, n: v.length, m: mean(v), s: sd(v) };
      })
    : [];
  return (
    <div className="space-y-6">
      <ColumnSelect
        id="long-col"
        label="Measure"
        value={column}
        options={measures}
        onChange={setColumn}
      />
      {column && (
        <div className="grid gap-4 xl:grid-cols-2">
          <ScatterRegressionChart
            title={`${first} vs ${second} · ${columnLabel(column)}`}
            description="Each point is one participant measured on both occasions, with the OLS line and 95% band."
            data={{
              points: pairs.map((p) => ({
                x: p.first,
                y: p.second,
                id: p.id,
                group: p.group ?? '',
              })),
              xLabel: `${columnLabel(column)} at ${first}`,
              yLabel: `${columnLabel(column)} at ${second}`,
            }}
            synthetic={synthetic}
            exportName={`trajectory-${columnLabel(column)}`}
            provenance={prov({
              n: pairs.length,
              snapshotId,
              source: 'snapshot Parquet (paired occasions)',
            })}
          />
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">Mean change [95% CI]</p>
                <p className="text-xl font-semibold">
                  <EstimateCI
                    estimate={traj.meanChange}
                    low={traj.lower}
                    high={traj.upper}
                    coefficient={false}
                  />
                </p>
                <p className="text-xs text-muted-foreground">N = {traj.n} pairs</p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">Standardised change d_z</p>
                <p className="text-xl font-semibold tabular-nums">{formatNumber(traj.dz)}</p>
                <p className="text-xs text-muted-foreground">
                  {traj.improved} up · {traj.declined} down
                </p>
              </div>
            </div>
            <BarCiChart
              title="Mean by occasion"
              data={{
                categories: byOcc.map((b) => b.o),
                series: [
                  {
                    name: 'Mean',
                    values: byOcc.map((b) => ({
                      value: Number.isFinite(b.m) ? b.m : null,
                      lower: Number.isFinite(b.s) ? b.m - (1.96 * b.s) / Math.sqrt(b.n) : null,
                      upper: Number.isFinite(b.s) ? b.m + (1.96 * b.s) / Math.sqrt(b.n) : null,
                      n: b.n,
                    })),
                  },
                ],
                valueLabel: columnLabel(column),
                valueStyle: 'number',
              }}
              height={240}
              synthetic={synthetic}
              provenance={prov({
                n: byOcc.reduce((a, b) => a + b.n, 0),
                snapshotId,
                note: 'Occasion means use everyone measured at that occasion (not only pairs).',
              })}
            />
          </div>
        </div>
      )}
      <ResultTable
        title={`Retest change for every measure (${first} → ${second})`}
        exportName="retest-trajectories"
        rows={all}
        rowKey={(a) => a.column}
        columns={[
          {
            key: 'c',
            header: 'Measure',
            cell: (a) => (
              <button
                type="button"
                className="font-mono text-xs text-primary hover:underline"
                onClick={() => setColumn(a.column)}
              >
                {columnLabel(a.column)}
              </button>
            ),
            value: (a) => a.column,
          },
          { key: 'n', header: 'Pairs', numeric: true, cell: (a) => a.s.n, value: (a) => a.s.n },
          {
            key: 'm',
            header: 'Mean change [95% CI]',
            numeric: true,
            cell: (a) => (
              <EstimateCI
                estimate={a.s.meanChange}
                low={a.s.lower}
                high={a.s.upper}
                coefficient={false}
              />
            ),
            value: (a) => a.s.meanChange,
          },
          {
            key: 'dz',
            header: 'd_z',
            numeric: true,
            cell: (a) => formatNumber(a.s.dz),
            value: (a) => a.s.dz,
          },
          {
            key: 'flag',
            header: 'Practice effect',
            cell: (a) =>
              practiceFlag !== null && a.s.dz !== null && Math.abs(a.s.dz) >= practiceFlag ? (
                <Badge variant="warning">|d_z| ≥ {formatNumber(practiceFlag)}</Badge>
              ) : (
                '—'
              ),
          },
        ]}
        caption="Practice-effect flag from gates.yaml (quality.practice_effect_d_flag)."
      />
    </div>
  );
}
