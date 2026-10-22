'use client';

import { Section } from '@/components/data/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatCoefficient, formatInteger, formatNumber, formatP } from '@/lib/format';
import { asNumber, asRecord, asString } from '../api/types';
import { ResultTable } from '../components/result-table';
import { EstimateCI, PassBadge, ResultProvenance } from '../components/shared';
import {
  batteryRows,
  detail,
  difRows,
  type EvidenceRow,
  fairnessRows,
  invarianceSummaries,
} from '../lib/results';
import type { ScienceConfig } from '../lib/science';

function groupLabel(r: EvidenceRow): string {
  const s = asRecord(r.subgroup);
  const grouping = asString(s.grouping) ?? '';
  if (s.focal && s.reference) return `${grouping}: ${String(s.focal)} vs ${String(s.reference)}`;
  if (s.language) return `${grouping} = ${String(s.language)}`;
  return grouping || 'all';
}

export function FairnessTab({
  rows,
  construct,
  science,
  studyId,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly science: ScienceConfig;
  readonly studyId: string | null;
}) {
  const invariance = invarianceSummaries(rows, construct);
  const dif = difRows(rows, construct);
  const fair = fairnessRows(rows, construct);
  const tost = fair.filter((r) => r.metric === 'mean_difference_tost');
  const missing = fair.filter((r) => r.metric === 'missing_rate_difference_pp');
  const prediction = fair.filter(
    (r) => r.metric === 'slope_difference' || r.metric === 'calibration_slope',
  );
  const battery = [
    ...batteryRows(rows, 'measurement_invariance'),
    ...batteryRows(rows, 'dif'),
    ...batteryRows(rows, 'fairness'),
  ];
  const required = science.gates.invariance.requiredGroupings;
  const tested = new Set(invariance.map((i) => i.grouping));
  const untested = required.filter((g) => !tested.has(g));

  return (
    <div className="space-y-6">
      <Alert variant="info">
        <AlertTitle>A non-significant difference is not equivalence</AlertTitle>
        <AlertDescription>
          Equivalence is shown by TOST bounds and invariance steps, and needs adequate samples.
          Cells below {formatInteger(science.gates.fairnessCellMinN)} participants are suppressed.
          {untested.length > 0 && (
            <span className="block">
              Not yet tested for gate rule B4:{' '}
              {untested.map((g) => g.replaceAll('_', ' ')).join(', ')}.
            </span>
          )}
        </AlertDescription>
      </Alert>

      <Section
        title="Measurement invariance"
        description={`Multi-group CFA steps (configural → metric → scalar) with ΔCFI (Chen, 2007). At most ${formatCoefficient(science.gates.invariance.maxFreedParameterShare)} of parameters may be freed (partial invariance).`}
      >
        <ResultTable
          exportName={`invariance-${construct}`}
          studyId={studyId}
          rows={invariance.flatMap((s) => s.steps.map((step) => ({ s, step })))}
          rowKey={(x, i) => `${x.s.grouping}-${x.step.metric}-${i}`}
          columns={[
            { key: 'g', header: 'Grouping', cell: (x) => x.s.grouping, value: (x) => x.s.grouping },
            {
              key: 'step',
              header: 'Step',
              cell: (x) => x.step.metric.replace('cfi_', ''),
              value: (x) => x.step.metric,
            },
            {
              key: 'cfi',
              header: 'CFI',
              numeric: true,
              cell: (x) => formatNumber(x.step.estimate, 3),
              value: (x) => x.step.estimate,
            },
            {
              key: 'dcfi',
              header: 'ΔCFI',
              numeric: true,
              cell: (x) => formatNumber(asNumber(detail(x.step, 'delta_CFI')), 3),
              value: (x) => asNumber(detail(x.step, 'delta_CFI')),
            },
            {
              key: 'rmsea',
              header: 'RMSEA',
              numeric: true,
              cell: (x) => formatNumber(asNumber(detail(x.step, 'RMSEA')), 3),
              value: (x) => asNumber(detail(x.step, 'RMSEA')),
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (x) => formatInteger(x.step.n),
              value: (x) => x.step.n,
            },
            {
              key: 'groups',
              header: 'Group sizes',
              cell: (x) =>
                Object.entries(asRecord(detail(x.step, 'group_sizes')))
                  .map(([k, v]) => `${k} ${String(v)}`)
                  .join(' · '),
            },
            {
              key: 'pass',
              header: 'Holds',
              cell: (x) => (
                <PassBadge
                  passed={x.step.passed}
                  labels={['holds', 'does not hold', 'not evaluated']}
                />
              ),
              value: (x) => x.step.passed,
            },
          ]}
          caption={
            invariance.length > 0
              ? invariance
                  .map((s) => `${s.grouping}: highest level reached = ${s.level ?? 'none'}`)
                  .join(' · ')
              : 'No invariance results for this construct.'
          }
        />
      </Section>

      <Section
        title="Differential item functioning"
        description="Regression DIF per indicator (nested models, BH-FDR), matched on the criterion. Jodoin–Gierl ΔR² classes: A negligible, B moderate, C large."
      >
        <ResultTable
          exportName={`dif-${construct}`}
          studyId={studyId}
          rows={dif}
          rowKey={(r, i) => `${r.subject}-${i}`}
          columns={[
            {
              key: 'ind',
              header: 'Indicator',
              cell: (r) => <span className="font-mono text-xs">{r.subject}</span>,
              value: (r) => r.subject,
            },
            {
              key: 'grp',
              header: 'Comparison',
              cell: (r) => groupLabel(r),
              value: (r) => groupLabel(r),
            },
            {
              key: 'r2',
              header: 'ΔR²',
              numeric: true,
              cell: (r) => formatNumber(r.estimate, 4),
              value: (r) => r.estimate,
            },
            {
              key: 'class',
              header: 'Class',
              cell: (r) => (
                <Badge variant={asString(detail(r, 'class')) === 'C' ? 'destructive' : 'outline'}>
                  {asString(detail(r, 'class')) ?? '—'}
                </Badge>
              ),
              value: (r) => asString(detail(r, 'class')),
            },
            {
              key: 'p',
              header: 'p (FDR)',
              numeric: true,
              cell: (r) => formatP(asNumber(detail(r, 'p_fdr'))),
              value: (r) => asNumber(detail(r, 'p_fdr')),
            },
            {
              key: 'shift',
              header: 'Uniform shift (SD)',
              numeric: true,
              cell: (r) => {
                const ci = detail(r, 'uniform_shift_sd_ci');
                const arr = Array.isArray(ci) ? ci : [];
                return (
                  <EstimateCI
                    estimate={asNumber(detail(r, 'uniform_shift_sd'))}
                    low={asNumber(arr[0])}
                    high={asNumber(arr[1])}
                    coefficient={false}
                  />
                );
              },
              value: (r) => asNumber(detail(r, 'uniform_shift_sd')),
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (r) => formatInteger(r.n),
              value: (r) => r.n,
            },
            {
              key: 'match',
              header: 'Matching',
              cell: (r) => (
                <span className="text-xs">{asString(detail(r, 'matching')) ?? '—'}</span>
              ),
            },
            {
              key: 'pass',
              header: 'Verdict',
              cell: (r) => (
                <PassBadge
                  passed={r.passed}
                  labels={['no large DIF', 'large DIF', 'not evaluated']}
                />
              ),
              value: (r) => r.passed,
            },
          ]}
        />
      </Section>

      <Section
        title="Group equivalence and differential prediction"
        description="Welch TOST on indicator means (equivalence bound in SD units), missingness gaps, and Cleary differential prediction / calibration by group."
      >
        <div className="grid gap-4">
          <ResultTable
            title="Mean equivalence (TOST)"
            exportName={`tost-${construct}`}
            studyId={studyId}
            rows={tost}
            rowKey={(r, i) => `${r.subject}-${i}`}
            columns={[
              {
                key: 'ind',
                header: 'Indicator',
                cell: (r) => (
                  <span className="font-mono text-xs">
                    {r.subject.replace(`${construct}.`, '')}
                  </span>
                ),
                value: (r) => r.subject,
              },
              {
                key: 'grp',
                header: 'Comparison',
                cell: (r) => groupLabel(r),
                value: (r) => groupLabel(r),
              },
              {
                key: 'd',
                header: 'Difference [90% CI]',
                numeric: true,
                cell: (r) => (
                  <EstimateCI
                    estimate={r.estimate}
                    low={r.ci_low}
                    high={r.ci_high}
                    coefficient={false}
                  />
                ),
                value: (r) => r.estimate,
              },
              {
                key: 'b',
                header: 'Bound (d)',
                numeric: true,
                cell: (r) => formatNumber(asNumber(detail(r, 'bound_d'))),
                value: (r) => asNumber(detail(r, 'bound_d')),
              },
              {
                key: 'n',
                header: 'N',
                numeric: true,
                cell: (r) => formatInteger(r.n),
                value: (r) => r.n,
              },
              {
                key: 'eq',
                header: 'Equivalent',
                cell: (r) => (
                  <PassBadge
                    passed={detail(r, 'equivalent') as boolean | null}
                    labels={['equivalent', 'not shown', 'not evaluated']}
                  />
                ),
                value: (r) => detail(r, 'equivalent') as boolean | null,
              },
            ]}
          />
          <ResultTable
            title="Differential prediction and calibration"
            exportName={`differential-prediction-${construct}`}
            studyId={studyId}
            rows={prediction}
            rowKey={(r, i) => `${r.subject}-${r.metric}-${i}`}
            columns={[
              {
                key: 'h',
                header: 'Relation',
                cell: (r) => <span className="font-mono text-xs">{r.subject}</span>,
                value: (r) => r.subject,
              },
              {
                key: 'm',
                header: 'Statistic',
                cell: (r) => r.metric.replaceAll('_', ' '),
                value: (r) => r.metric,
              },
              {
                key: 'grp',
                header: 'Group',
                cell: (r) => groupLabel(r),
                value: (r) => groupLabel(r),
              },
              {
                key: 'e',
                header: 'Estimate [95% CI]',
                numeric: true,
                cell: (r) => (
                  <EstimateCI
                    estimate={r.estimate}
                    low={r.ci_low}
                    high={r.ci_high}
                    coefficient={false}
                  />
                ),
                value: (r) => r.estimate,
              },
              {
                key: 'n',
                header: 'N',
                numeric: true,
                cell: (r) => formatInteger(r.n),
                value: (r) => r.n,
              },
              {
                key: 'c',
                header: 'Conclusion',
                cell: (r) => (
                  <span className="text-xs">
                    {(asString(detail(r, 'conclusion')) ?? '').replaceAll('_', ' ') || '—'}
                  </span>
                ),
                value: (r) => asString(detail(r, 'conclusion')),
              },
            ]}
          />
        </div>
        <ResultTable
          title="Missingness gaps between groups"
          exportName={`missingness-${construct}`}
          studyId={studyId}
          rows={missing}
          rowKey={(r, i) => `${r.subject}-${i}`}
          columns={[
            {
              key: 'ind',
              header: 'Indicator',
              cell: (r) => <span className="font-mono text-xs">{r.subject}</span>,
              value: (r) => r.subject,
            },
            {
              key: 'grp',
              header: 'Grouping',
              cell: (r) => groupLabel(r),
              value: (r) => groupLabel(r),
            },
            {
              key: 'pp',
              header: 'Max gap (pp)',
              numeric: true,
              cell: (r) => formatNumber(r.estimate, 1),
              value: (r) => r.estimate,
            },
            {
              key: 'rates',
              header: 'Missing rates',
              cell: (r) =>
                Object.entries(asRecord(detail(r, 'rates')))
                  .map(([k, v]) => `${k} ${formatNumber(Number(v) * 100, 1)}%`)
                  .join(' · '),
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (r) => formatInteger(r.n),
              value: (r) => r.n,
            },
            {
              key: 'pass',
              header: 'Within tolerance',
              cell: (r) => <PassBadge passed={r.passed} />,
              value: (r) => r.passed,
            },
          ]}
        />
      </Section>

      <Section title="Battery-level checks" description="Inputs to battery gate rule A3.">
        <ResultTable
          exportName="battery-fairness"
          studyId={studyId}
          rows={battery}
          rowKey={(r, i) => `${r.analysis}-${r.metric}-${i}`}
          columns={[
            {
              key: 'a',
              header: 'Analysis',
              cell: (r) => r.analysis.replaceAll('_', ' '),
              value: (r) => r.analysis,
            },
            {
              key: 'm',
              header: 'Check',
              cell: (r) => r.metric.replaceAll('_', ' '),
              value: (r) => r.metric,
            },
            {
              key: 'e',
              header: 'Value',
              numeric: true,
              cell: (r) => formatNumber(r.estimate),
              value: (r) => r.estimate,
            },
            {
              key: 't',
              header: 'Threshold',
              numeric: true,
              cell: (r) => formatNumber(r.threshold),
              value: (r) => r.threshold,
            },
            {
              key: 'n',
              header: 'N',
              numeric: true,
              cell: (r) => formatInteger(r.n),
              value: (r) => r.n,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (r) =>
                r.passed === null ? (
                  <span className="text-xs text-muted-foreground">
                    {asString(detail(r, 'reason')) ?? asString(detail(r, 'status')) ?? '—'}
                  </span>
                ) : (
                  <PassBadge passed={r.passed} />
                ),
              value: (r) => r.passed,
            },
          ]}
          caption={battery[0] ? <ResultProvenance row={battery[0]} /> : undefined}
        />
      </Section>
    </div>
  );
}
