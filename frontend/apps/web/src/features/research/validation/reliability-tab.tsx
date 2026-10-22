'use client';

import { useMemo } from 'react';
import { BlandAltmanPlot, ForestPlot } from '@/components/charts';
import { Section } from '@/components/data/page-header';
import { LoadingState } from '@/components/data/states';
import { formatCoefficient, formatInteger, formatNumber } from '@/lib/format';
import { useIndicatorDefinitions } from '../api/hooks';
import { useSnapshotFrame } from '../api/snapshot-frame';
import type { DatasetOut, IndicatorDefinitionOut } from '../api/types';
import { asNumber, asRecord } from '../api/types';
import { ResultTable } from '../components/result-table';
import { prov as cleanProv, EstimateCI, PassBadge, ResultProvenance } from '../components/shared';
import { pairedOccasions } from '../lib/analytics';
import {
  compositeReliabilityRows,
  type EvidenceRow,
  exclusionCount,
  indicatorRetestRows,
  retestRows,
  subgroupLanguage,
} from '../lib/results';
import type { ScienceConfig } from '../lib/science';
import { forestRows } from './convergent-tab';
import { compositeIndicators, constructColumns, directionMap, withComposite } from './frame-views';

export function ReliabilityTab({
  rows,
  construct,
  constructName,
  target,
  science,
  snapshot,
  synthetic,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly constructName: string;
  readonly target: number | null;
  readonly science: ScienceConfig;
  readonly snapshot: DatasetOut;
  readonly synthetic: boolean;
}) {
  const retest = retestRows(rows, construct);
  const indicators = indicatorRetestRows(rows, construct);
  const omega = compositeReliabilityRows(rows, construct);
  const lb = science.gates.retest.lowerBoundMin;
  const pooled = retest.find((r) => subgroupLanguage(r) === null) ?? null;
  const d = asRecord(pooled?.details);
  const ba = asRecord(d.bland_altman);
  const practice = asRecord(d.practice_effect);
  const baseProv = { snapshotId: snapshot.snapshot_id, source: 'reliability run' };
  const refs = [
    ...(target !== null
      ? [{ value: target, label: `target ${formatCoefficient(target)}`, kind: 'target' as const }]
      : []),
    ...(lb !== null
      ? [{ value: lb, label: `lower bound ${formatCoefficient(lb)}`, kind: 'null' as const }]
      : []),
  ];

  return (
    <div className="space-y-6">
      <Section
        title={`Test–retest · ${constructName}`}
        description={`ICC(A,1) (absolute agreement, McGraw & Wong) between the first two occasions, pooled and by language. At least ${formatInteger(science.gates.retest.minPairsPerCell)} pairs per cell are required; Pearson r is shown for reference only and never feeds gates.`}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {retest.length + indicators.length > 0 ? (
            <ForestPlot
              title="Retest ICC(A,1) by group and indicator"
              data={{
                rows: [
                  ...forestRows(
                    retest,
                    (r) => `Composite · ${subgroupLanguage(r) ?? 'pooled'}`,
                    () => 'composite',
                  ),
                  ...forestRows(
                    indicators,
                    (r) => r.subject.replace(`${construct}.`, ''),
                    () => 'indicator',
                  ),
                ],
                xLabel: 'ICC(A,1)',
                nullValue: 0,
                domain: [-0.2, 1],
                referenceLines: refs,
              }}
              synthetic={synthetic}
              exportName={`retest-${construct}`}
              provenance={cleanProv({
                ...baseProv,
                n: pooled?.n,
                exclusions: pooled ? exclusionCount(pooled) : undefined,
                note: 'N = participants with both occasions.',
              })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No retest result: the snapshot needs two occasions.
            </p>
          )}
          <RetestAgreement
            rows={rows}
            construct={construct}
            constructName={constructName}
            snapshot={snapshot}
            synthetic={synthetic}
            engineBa={ba}
          />
        </div>
        {pooled && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['SEM', formatNumber(asNumber(d.sem)), 'Standard error of measurement'],
              ['Smallest detectable change', formatNumber(asNumber(d.sdc)), 'SDC (95%)'],
              [
                'Practice effect d_z',
                formatNumber(asNumber(practice.d_z)),
                `mean change ${formatNumber(asNumber(practice.mean_change))}${practice.flag === true ? ' · flagged' : ''}`,
              ],
              [
                'ICC(C,1) / Pearson r',
                `${formatCoefficient(asNumber(d.icc_c1))} / ${formatCoefficient(asNumber(d.pearson_r_never_for_gates))}`,
                'consistency / reference only',
              ],
            ].map(([label, value, sub]) => (
              <div key={label} className="rounded-lg border bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{sub}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Reliability by group"
        description={`Composite internal consistency (omega total where at least three indicators; alpha otherwise) and retest ICC per language group. Gate rule B2: point ≥ ${formatCoefficient(science.gates.reliability.pointMin)}, lower bound ≥ ${formatCoefficient(science.gates.reliability.lowerBoundMin)}.`}
      >
        <ResultTable
          exportName={`reliability-by-group-${construct}`}
          studyId={snapshot.study_id}
          rows={[...omega, ...retest, ...indicators]}
          rowKey={(r, i) => `${r.metric}-${r.subject}-${subgroupLanguage(r) ?? 'pooled'}-${i}`}
          columns={[
            {
              key: 'subject',
              header: 'Measure',
              cell: (r) => <span className="font-mono text-xs">{r.subject}</span>,
              value: (r) => r.subject,
            },
            { key: 'metric', header: 'Statistic', cell: (r) => r.metric, value: (r) => r.metric },
            {
              key: 'group',
              header: 'Group',
              cell: (r) => subgroupLanguage(r) ?? 'pooled',
              value: (r) => subgroupLanguage(r) ?? 'pooled',
            },
            {
              key: 'est',
              header: 'Estimate [95% CI]',
              numeric: true,
              cell: (r) => <EstimateCI estimate={r.estimate} low={r.ci_low} high={r.ci_high} />,
              value: (r) => r.estimate,
            },
            {
              key: 'lo',
              header: 'CI low',
              numeric: true,
              cell: () => null,
              value: (r) => r.ci_low,
              className: 'hidden',
            },
            {
              key: 'hi',
              header: 'CI high',
              numeric: true,
              cell: () => null,
              value: (r) => r.ci_high,
              className: 'hidden',
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (r) => formatInteger(r.n),
              value: (r) => r.n,
            },
            {
              key: 'thr',
              header: 'Gate threshold',
              numeric: true,
              cell: (r) => formatCoefficient(r.threshold),
              value: (r) => r.threshold,
            },
            {
              key: 'pass',
              header: 'Verdict',
              cell: (r) => <PassBadge passed={r.passed} />,
              value: (r) => r.passed,
            },
          ]}
          caption={pooled ? <ResultProvenance row={pooled} /> : undefined}
        />
      </Section>
    </div>
  );
}

function RetestAgreement({
  rows,
  construct,
  constructName,
  snapshot,
  synthetic,
  engineBa,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly constructName: string;
  readonly snapshot: DatasetOut;
  readonly synthetic: boolean;
  readonly engineBa: Readonly<Record<string, unknown>>;
}) {
  const frameQ = useSnapshotFrame(snapshot);
  const defsQ = useIndicatorDefinitions();
  const reverse = useMemo(
    () => directionMap((defsQ.data ?? []) as IndicatorDefinitionOut[]),
    [defsQ.data],
  );
  const pairs = useMemo(() => {
    const frame = frameQ.data;
    if (!frame) return [];
    const occasions = [...new Set(frame.rows.map((r) => String(r.occasion_id ?? '')))]
      .filter(Boolean)
      .sort();
    if (occasions.length < 2) return [];
    const cols = constructColumns(frame, construct, reverse, compositeIndicators(rows, construct));
    const analysable = frame.rows.filter((r) => r.holdout !== true);
    const enriched = withComposite(analysable, cols).map(({ row, composite }) => ({
      ...row,
      __composite: composite,
    }));
    return pairedOccasions(
      enriched,
      '__composite',
      occasions[0] as string,
      occasions[1] as string,
    ).map((p) => ({
      id: p.id,
      first: p.first,
      second: p.second,
    }));
  }, [frameQ.data, construct, reverse, rows]);
  if (frameQ.isPending) return <LoadingState rows={3} label="Loading snapshot rows" />;
  if (pairs.length < 3) {
    return (
      <p className="text-sm text-muted-foreground">
        No paired occasions in the snapshot for a Bland–Altman plot.
      </p>
    );
  }
  const md = asNumber(engineBa.mean_difference);
  return (
    <BlandAltmanPlot
      title={`Bland–Altman · ${constructName} composite`}
      description={`Retest − test against the pair mean, with bias and 95% limits of agreement (display composite). Engine bias on the scored composite: ${formatNumber(md)} [LoA ${formatNumber(asNumber(engineBa.loa_low))}, ${formatNumber(asNumber(engineBa.loa_high))}].`}
      data={{ pairs, measure: `${constructName} composite (z)` }}
      synthetic={synthetic}
      exportName={`bland-altman-${construct}`}
      provenance={{
        n: pairs.length,
        snapshotId: snapshot.snapshot_id,
        source: 'snapshot Parquet (paired occasions, holdout cohort excluded)',
      }}
    />
  );
}
