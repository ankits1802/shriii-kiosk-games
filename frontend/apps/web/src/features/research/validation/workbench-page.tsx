'use client';

/**
 * Trait Validation Workbench (spec sections 6 and 7): construct selector, criterion r with CI, retest
 * ICC with CI against a configurable display target (the gate itself uses gates.yaml), MTMM with
 * own-vs-discriminant highlighting, scatter with regression + CI, Bland–Altman, reliability by group,
 * DIF / invariance / fairness tables, and gate status with evidence and the sign-off workflow.
 * Every number is an engine result from one snapshot and carries N, CI, exclusions and provenance.
 */
import { useMemo, useState } from 'react';
import { BarCiChart, type BarCiInput } from '@/components/charts';
import { PageHeader } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCoefficient } from '@/lib/format';
import { useConstructs, useRunDetails, useRuns } from '../api/hooks';
import type { RunOut } from '../api/types';
import { EvidenceStat, PassBadge } from '../components/shared';
import { useSnapshotSelection } from '../components/snapshot-bar';
import {
  compositeReliabilityRows,
  constructsWithEvidence,
  criterionCorrelations,
  type EvidenceRow,
  flattenResults,
  invarianceSummaries,
  latestGateEvaluation,
  latestRuns,
  retestRows,
  subgroupLanguage,
  traitGateDecisions,
} from '../lib/results';
import type { ScienceConfig } from '../lib/science';
import { useUrlState } from '../lib/url-state';
import { ConvergentTab } from './convergent-tab';
import { FairnessTab } from './fairness-tab';
import { GatesPanel } from './gates-panel';
import { ReliabilityTab } from './reliability-tab';
import { RunsPanel } from './runs-panel';

/** Pre-registered sign of a hypothesis row (1, -1; 'negative' -> -1), default positive. */
export function expectedSign(row: EvidenceRow): number {
  const v = (row.details as Record<string, unknown>).expected_sign;
  return v === -1 || v === 'negative' ? -1 : 1;
}

export type LanguageView = 'pooled' | string;

export function pickLanguage(rows: readonly EvidenceRow[], view: LanguageView): EvidenceRow[] {
  return rows.filter((r) =>
    view === 'pooled' ? subgroupLanguage(r) === null : subgroupLanguage(r) === view,
  );
}

export function ValidationWorkbenchPage({ science }: { readonly science: ScienceConfig }) {
  const sel = useSnapshotSelection();
  const runsQ = useRuns(sel.snapshot?.snapshot_id ?? null);
  const runs = runsQ.data ?? [];
  const latest = useMemo(
    () => latestRuns(runs.filter((r) => r.analysis !== 'gate_evaluation')),
    [runs],
  );
  const gateRunRef = useMemo(() => latestGateEvaluation(runs), [runs]);
  const detailIds = useMemo(
    () => [
      ...[...latest.values()].map((r) => r.run_id),
      ...(gateRunRef ? [gateRunRef.run_id] : []),
    ],
    [latest, gateRunRef],
  );
  const details = useRunDetails(detailIds);
  const detailRuns = details.map((d) => d.data).filter((d): d is RunOut => Boolean(d));
  const evidenceRuns = detailRuns.filter((r) => r.analysis !== 'gate_evaluation');
  const gateRun = detailRuns.find((r) => r.analysis === 'gate_evaluation') ?? null;
  const rows = useMemo(() => flattenResults(evidenceRuns), [evidenceRuns]);
  const constructsQ = useConstructs();
  const names = useMemo(
    () => new Map((constructsQ.data ?? []).map((c) => [c.construct_id, c.name])),
    [constructsQ.data],
  );
  const withEvidence = useMemo(() => constructsWithEvidence(rows), [rows]);
  const [constructParam, setConstruct] = useUrlState('construct');
  const construct =
    (constructParam && withEvidence.includes(constructParam) ? constructParam : null) ??
    withEvidence.find((c) => c === 'self_control') ??
    withEvidence[0] ??
    null;
  const languages = useMemo(
    () => [...new Set(rows.map(subgroupLanguage).filter((l): l is string => l !== null))].sort(),
    [rows],
  );
  const [langParam, setLang] = useUrlState('lang');
  const language: LanguageView = langParam && languages.includes(langParam) ? langParam : 'pooled';
  const gateTarget = science.gates.retest.pointMin;
  const [targetText, setTargetText] = useState<string>(
    gateTarget === null ? '' : String(gateTarget),
  );
  const target =
    Number.isFinite(Number(targetText)) && targetText !== '' ? Number(targetText) : gateTarget;
  const name = (id: string) => names.get(id) ?? id.replaceAll('_', ' ');

  const detailsLoading = details.some((d) => d.isPending);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trait validation workbench"
        description="Reliability, convergent and discriminant validity, structure and fairness evidence per construct, from the validation engine's results on one frozen snapshot. Thresholds come from gates.yaml; nothing here promotes a gate."
        meta={
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono">
              gates.yaml v{science.gates.version} · {science.gates.sha256.slice(0, 8)}
            </Badge>
            <Badge variant="outline" className="font-mono">
              hypotheses.yaml v{science.hypotheses.version} ·{' '}
              {science.hypotheses.sha256.slice(0, 8)}
            </Badge>
            <Badge variant="secondary">{science.gates.status}</Badge>
          </div>
        }
      />
      {sel.bar}
      {sel.blocker ?? (
        <>
          {runsQ.isError && <ErrorState error={runsQ.error} onRetry={() => void runsQ.refetch()} />}
          {runsQ.isPending || detailsLoading ? (
            <LoadingState rows={6} label="Loading validation results" />
          ) : rows.length === 0 ? (
            <RunsPanel
              snapshot={sel.snapshot}
              runs={runs}
              science={science}
              intro="No analyses have finished on this snapshot yet. Queue them below; results appear when the worker finishes."
            />
          ) : (
            <>
              <fieldset className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
                <legend className="sr-only">Workbench controls</legend>
                <div className="space-y-1">
                  <Label htmlFor="construct-select" className="text-xs">
                    Construct
                  </Label>
                  <Select value={construct ?? ''} onValueChange={(v) => setConstruct(v)}>
                    <SelectTrigger id="construct-select" size="sm" className="min-w-56">
                      <SelectValue placeholder="Choose a construct" />
                    </SelectTrigger>
                    <SelectContent>
                      {withEvidence.map((c) => (
                        <SelectItem key={c} value={c}>
                          {name(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="language-select" className="text-xs">
                    Language group
                  </Label>
                  <Select
                    value={language}
                    onValueChange={(v) => setLang(v === 'pooled' ? null : v)}
                  >
                    <SelectTrigger id="language-select" size="sm" className="min-w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pooled">Pooled</SelectItem>
                      {languages.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="retest-target" className="text-xs">
                    Retest display target
                  </Label>
                  <Input
                    id="retest-target"
                    type="number"
                    inputMode="decimal"
                    step="0.05"
                    min="0"
                    max="1"
                    value={targetText}
                    onChange={(e) => setTargetText(e.target.value)}
                    className="h-8 w-24"
                  />
                </div>
                <p className="max-w-md text-xs text-muted-foreground">
                  The display target only moves the reference lines. Gate rule B1 stays at ICC(A,1)
                  ≥ {formatCoefficient(gateTarget)} with lower bound ≥{' '}
                  {formatCoefficient(science.gates.retest.lowerBoundMin)} (gates.yaml; pooled across
                  languages ≥ {formatCoefficient(science.gates.retest.pooledLanguagePointMin)}).
                </p>
              </fieldset>

              {construct && (
                <HeadlineEvidence
                  rows={rows}
                  construct={construct}
                  language={language}
                  target={target}
                  science={science}
                  gateRun={gateRun}
                />
              )}

              <CrossConstruct
                rows={rows}
                constructs={withEvidence}
                name={name}
                target={target}
                science={science}
                synthetic={sel.synthetic}
                snapshotId={sel.snapshot?.snapshot_id}
              />

              {construct && sel.snapshot && (
                <Tabs defaultValue="convergent">
                  <TabsList className="flex-wrap">
                    <TabsTrigger value="convergent">Convergent &amp; discriminant</TabsTrigger>
                    <TabsTrigger value="reliability">Reliability</TabsTrigger>
                    <TabsTrigger value="fairness">Fairness &amp; invariance</TabsTrigger>
                    <TabsTrigger value="gates">Gates &amp; sign-off</TabsTrigger>
                    <TabsTrigger value="runs">Runs</TabsTrigger>
                  </TabsList>
                  <TabsContent value="convergent">
                    <ConvergentTab
                      rows={rows}
                      construct={construct}
                      constructName={name(construct)}
                      language={language}
                      science={science}
                      snapshot={sel.snapshot}
                      synthetic={sel.synthetic}
                    />
                  </TabsContent>
                  <TabsContent value="reliability">
                    <ReliabilityTab
                      rows={rows}
                      construct={construct}
                      constructName={name(construct)}
                      target={target}
                      science={science}
                      snapshot={sel.snapshot}
                      synthetic={sel.synthetic}
                    />
                  </TabsContent>
                  <TabsContent value="fairness">
                    <FairnessTab
                      rows={rows}
                      construct={construct}
                      science={science}
                      studyId={sel.study?.study_id ?? null}
                    />
                  </TabsContent>
                  <TabsContent value="gates">
                    <GatesPanel
                      construct={construct}
                      constructName={name(construct)}
                      gateRun={gateRun}
                      latest={latest}
                      science={science}
                      snapshot={sel.snapshot}
                      languages={languages}
                    />
                  </TabsContent>
                  <TabsContent value="runs">
                    <RunsPanel snapshot={sel.snapshot} runs={runs} science={science} />
                  </TabsContent>
                </Tabs>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function HeadlineEvidence({
  rows,
  construct,
  language,
  target,
  science,
  gateRun,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly construct: string;
  readonly language: LanguageView;
  readonly target: number | null;
  readonly science: ScienceConfig;
  readonly gateRun: RunOut | null;
}) {
  const corr = criterionCorrelations(rows, construct).filter((c) =>
    language === 'pooled' ? c.language === null : c.language === language,
  );
  const primary =
    corr.find((c) => c.family === 'primary' && c.row.estimate !== null) ??
    corr.find((c) => c.relation === 'convergent' && c.row.estimate !== null) ??
    null;
  const retest = pickLanguage(retestRows(rows, construct), language)[0] ?? null;
  const omega = pickLanguage(compositeReliabilityRows(rows, construct), language)[0] ?? null;
  const invariance = invarianceSummaries(rows, construct);
  const decisions = traitGateDecisions(gateRun).filter((d) => d.trait === construct);
  const lb = science.gates.retest.lowerBoundMin;
  const meetsDisplay =
    retest && target !== null && retest.estimate !== null
      ? retest.estimate >= target && (lb === null || (retest.ci_low ?? -1) >= lb)
      : null;
  return (
    <section aria-label="Headline evidence" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <EvidenceStat
        label={`Criterion r · ${primary?.criterion ?? 'no primary criterion'}`}
        row={primary?.row}
        targetLabel="Lower bound must exceed r0 ="
        target={science.hypotheses.r0}
        hint={
          primary ? (
            <span>
              {primary.hypothesisId ?? 'exploratory'} · {primary.family ?? '—'} family · observed r
              (never disattenuated)
            </span>
          ) : undefined
        }
      />
      <EvidenceStat
        label="Retest ICC(A,1)"
        row={retest}
        target={target}
        targetLabel="Display target"
        hint={
          retest ? (
            <span className="flex flex-wrap items-center gap-1.5">
              Against display target: <PassBadge passed={meetsDisplay} />
            </span>
          ) : undefined
        }
      />
      <EvidenceStat
        label={`Composite reliability (${omega?.metric === 'alpha' ? 'alpha' : 'omega'})`}
        row={omega}
        target={science.gates.reliability.pointMin}
        targetLabel="Gate B2 point target"
      />
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground">Invariance &amp; gate status</p>
        {invariance.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invariance result.</p>
        ) : (
          invariance.map((s) => (
            <p key={s.grouping} className="text-sm">
              By {s.grouping}: <span className="font-medium">{s.level ?? 'none'}</span>
              {s.levelRow && (
                <span className="text-xs text-muted-foreground"> · N = {s.levelRow.n ?? '—'}</span>
              )}
            </p>
          ))
        )}
        <div className="flex flex-wrap gap-1.5">
          {decisions.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No gate evaluation on this snapshot.
            </span>
          ) : (
            decisions.map((d) => (
              <Badge key={`${d.language}-${d.pathway}`} variant="outline">
                {d.language} · {d.evaluatedStatus.replaceAll('_', ' ')}
              </Badge>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Evaluate-only: promotions are a separate signed action.
        </p>
      </div>
    </section>
  );
}

function CrossConstruct({
  rows,
  constructs,
  name,
  target,
  science,
  synthetic,
  snapshotId,
}: {
  readonly rows: readonly EvidenceRow[];
  readonly constructs: readonly string[];
  readonly name: (id: string) => string;
  readonly target: number | null;
  readonly science: ScienceConfig;
  readonly synthetic: boolean;
  readonly snapshotId: string | undefined;
}) {
  const data = useMemo<BarCiInput | null>(() => {
    const items = constructs
      .map((c) => {
        const corr = criterionCorrelations(rows, c).filter((x) => x.language === null);
        const primary =
          corr.find((x) => x.family === 'primary' && x.row.estimate !== null) ??
          corr.find((x) => x.relation === 'convergent' && x.row.estimate !== null);
        const retest = retestRows(rows, c).find((r) => subgroupLanguage(r) === null);
        return { c, primary: primary?.row ?? null, retest: retest ?? null };
      })
      .filter((x) => x.primary || x.retest);
    if (items.length === 0) return null;
    const bar = (r: EvidenceRow | null) =>
      r ? { value: r.estimate, lower: r.ci_low, upper: r.ci_high, n: r.n } : { value: null };
    // Criterion r is shown keyed to the pre-registered direction, so a supported negative relation
    // (e.g. decisiveness vs GDMS avoidant) reads as positive evidence; the table keeps the raw sign.
    const keyed = (r: EvidenceRow | null) => {
      if (!r) return { value: null };
      const sign = expectedSign(r);
      return sign < 0
        ? {
            value: r.estimate === null ? null : -r.estimate,
            lower: r.ci_high === null ? null : -r.ci_high,
            upper: r.ci_low === null ? null : -r.ci_low,
            n: r.n,
          }
        : bar(r);
    };
    return {
      categories: items.map((x) => name(x.c)),
      series: [
        {
          name: 'Criterion r (primary, keyed to expected sign)',
          values: items.map((x) => keyed(x.primary)),
        },
        { name: 'Retest ICC(A,1)', values: items.map((x) => bar(x.retest)) },
      ],
      valueLabel: 'Coefficient',
      domain: [-0.2, 1] as const,
      referenceLines: [
        ...(target !== null
          ? [
              {
                value: target,
                label: `retest target ${formatCoefficient(target)}`,
                kind: 'target' as const,
              },
            ]
          : []),
        ...(science.hypotheses.r0 !== null
          ? [
              {
                value: science.hypotheses.r0,
                label: `r0 ${formatCoefficient(science.hypotheses.r0)}`,
                kind: 'null' as const,
              },
            ]
          : []),
      ],
    };
  }, [rows, constructs, name, target, science.hypotheses.r0]);
  if (!data) return null;
  const n = Math.max(
    0,
    ...rows.filter((r) => r.analysis === 'construct_validity').map((r) => r.n ?? 0),
  );
  return (
    <BarCiChart
      title="Cross-construct comparison"
      description="Pooled primary criterion correlation (sign-keyed to the pre-registered direction) and retest ICC per construct, with 95% CIs. Literature expects r ≈ .20–.40; that is an expectation, not an acceptance threshold."
      data={data}
      height={340}
      synthetic={synthetic}
      exportName="cross-construct-evidence"
      provenance={{
        n,
        source: 'construct_validity + reliability runs',
        ...(snapshotId ? { snapshotId } : {}),
        note: 'Each bar carries its own N in the table view; retest N counts participants with both occasions.',
      }}
    />
  );
}
