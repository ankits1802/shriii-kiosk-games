'use client';

/**
 * Building blocks shared by the research pages: estimate + CI cells, evidence stat cards that always
 * carry N / CI / exclusions / provenance, the synthetic-data notice, stat tiles, and the study and
 * snapshot pickers.
 */
import { DatabaseIcon, FlaskConicalIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Provenance } from '@/components/charts/chart-frame';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatCoefficient,
  formatDateTime,
  formatEstimateCI,
  formatInteger,
  formatNumber,
  shortId,
} from '@/lib/format';
import { useStudyScope } from '@/lib/study-scope';
import { cn } from '@/lib/utils';
import type { DatasetOut, ResultOut, StudyOut } from '../api/types';
import { asRecord } from '../api/types';
import { exclusionCount, provenanceOf } from '../lib/results';

export function EstimateCI({
  estimate,
  low,
  high,
  digits = 2,
  coefficient = true,
  className,
}: {
  readonly estimate: number | null | undefined;
  readonly low?: number | null | undefined;
  readonly high?: number | null | undefined;
  readonly digits?: number;
  readonly coefficient?: boolean;
  readonly className?: string;
}) {
  const f = coefficient ? formatCoefficient : formatNumber;
  if (low === undefined && high === undefined) {
    return <span className={cn('tabular-nums', className)}>{f(estimate, digits)}</span>;
  }
  return (
    <span className={cn('tabular-nums', className)}>
      <span className="font-medium">{f(estimate, digits)}</span>{' '}
      <span className="text-muted-foreground">
        [{f(low, digits)}, {f(high, digits)}]
      </span>
    </span>
  );
}

/** Pass / fail / not evaluated, always with an icon and a word. */
export function PassBadge({
  passed,
  labels = ['meets target', 'below target', 'not evaluated'],
}: {
  readonly passed: boolean | null | undefined;
  readonly labels?: readonly [string, string, string];
}) {
  if (passed === true) return <StatusBadge status="passed" tone="good" label={labels[0]} />;
  if (passed === false) return <StatusBadge status="failed" tone="serious" label={labels[1]} />;
  return <StatusBadge status="pending" tone="neutral" label={labels[2]} />;
}

/** One-line N · CI level · exclusions · provenance for a result row. */
export function ResultProvenance({
  row,
  className,
}: {
  readonly row: Pick<ResultOut, 'n' | 'ci_level' | 'exclusions' | 'provenance' | 'method'>;
  readonly className?: string;
}) {
  const p = provenanceOf(row);
  const excluded = exclusionCount(row);
  const parts = [
    `N = ${formatInteger(row.n)}`,
    row.ci_level ? `${Math.round(row.ci_level * 100)}% CI` : null,
    excluded !== undefined ? `${formatInteger(excluded)} excluded` : null,
    row.method,
    p.algorithmVersion ? `engine ${p.algorithmVersion}` : null,
    p.snapshotId ? `snapshot ${shortId(p.snapshotId)}` : null,
  ].filter(Boolean);
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {parts.join(' · ')}
      {p.inputsSha256 && (
        <span className="font-mono" title={`inputs sha256 ${p.inputsSha256}`}>
          {' '}
          · inputs {p.inputsSha256.slice(0, 10)}
        </span>
      )}
    </p>
  );
}

/** Evidence card: label, estimate [CI], target, verdict and the provenance line. */
export function EvidenceStat({
  label,
  row,
  target,
  targetLabel,
  hint,
  coefficient = true,
  className,
}: {
  readonly label: string;
  readonly row: ResultOut | null | undefined;
  readonly target?: number | null;
  readonly targetLabel?: string;
  readonly hint?: ReactNode;
  readonly coefficient?: boolean;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border bg-card p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {row && <PassBadge passed={row.passed} />}
      </div>
      {row ? (
        <>
          <p className="text-2xl font-semibold tabular-nums tracking-tight">
            {coefficient ? formatCoefficient(row.estimate) : formatNumber(row.estimate)}
            {row.ci_low !== null && row.ci_high !== null && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                [{coefficient ? formatCoefficient(row.ci_low) : formatNumber(row.ci_low)},{' '}
                {coefficient ? formatCoefficient(row.ci_high) : formatNumber(row.ci_high)}]
              </span>
            )}
          </p>
          {(target ?? row.threshold) !== null && (target ?? row.threshold) !== undefined && (
            <p className="text-xs text-muted-foreground">
              {targetLabel ?? 'Target'} {formatCoefficient(target ?? row.threshold)}
            </p>
          )}
          <ResultProvenance row={row} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No result in the selected snapshot yet.</p>
      )}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** KPI tile: one headline number with context (never a chart). */
export function StatTile({
  label,
  value,
  sub,
  icon,
  className,
  testId,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('flex flex-col gap-1 rounded-lg border bg-card px-4 py-3', className)}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Figure provenance without undefined/null members (exactOptionalPropertyTypes). */
export function prov(
  p: { readonly [K in keyof Provenance]?: Provenance[K] | null | undefined },
): Provenance {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => v !== undefined && v !== null),
  ) as Provenance;
}

/** Share formatted as a percentage with one decimal. */
export function pct(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  return `${(share * 100).toFixed(digits)}%`;
}

export function isSyntheticSnapshot(snapshot: Pick<DatasetOut, 'spec'> | null | undefined) {
  return asRecord(snapshot?.spec).include_synthetic === true;
}

/** Shown wherever figures come from simulator / demo-pipeline data. */
export function SyntheticNotice({
  show,
  what = 'This snapshot includes simulator data',
}: {
  readonly show: boolean;
  readonly what?: string;
}) {
  if (!show) return null;
  return (
    <Alert variant="warning" data-testid="synthetic-notice">
      <FlaskConicalIcon aria-hidden="true" />
      <AlertTitle>Synthetic / demo data</AlertTitle>
      <AlertDescription>
        {what} (demo pipeline, known simulated traits). Use it to check the pipeline and the
        displays; it is not evidence about real participants and never opens a gate.
      </AlertDescription>
    </Alert>
  );
}

/** Study the page focuses on: the top-bar selection, else the first study in scope. */
export function useFocusStudy(): {
  study: StudyOut | null;
  studies: readonly StudyOut[];
  isLoading: boolean;
  explicit: boolean;
  setStudyId: (id: string | null) => void;
} {
  const { study, studies, isLoading, setStudyId } = useStudyScope();
  return {
    study: study ?? studies[0] ?? null,
    studies,
    isLoading,
    explicit: study !== null,
    setStudyId,
  };
}

export function StudySelect({
  value,
  studies,
  onChange,
}: {
  readonly value: string | null;
  readonly studies: readonly StudyOut[];
  readonly onChange: (id: string) => void;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label="Study" className="min-w-56">
        <SelectValue placeholder="Choose a study" />
      </SelectTrigger>
      <SelectContent>
        {studies.map((s) => (
          <SelectItem key={s.study_id} value={s.study_id}>
            <span className="font-mono text-xs text-muted-foreground">{s.code}</span> {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Default snapshot: the newest frozen one, else the newest ready one. */
export function defaultSnapshot(datasets: readonly DatasetOut[]): DatasetOut | null {
  const sorted = [...datasets].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    sorted.find((d) => d.status === 'frozen') ?? sorted.find((d) => d.status === 'ready') ?? null
  );
}

export function SnapshotSelect({
  datasets,
  value,
  onChange,
}: {
  readonly datasets: readonly DatasetOut[];
  readonly value: string | null;
  readonly onChange: (id: string) => void;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label="Dataset snapshot" className="min-w-64">
        <SelectValue placeholder="Choose a snapshot" />
      </SelectTrigger>
      <SelectContent>
        {datasets.map((d) => (
          <SelectItem key={d.snapshot_id} value={d.snapshot_id}>
            {`${d.name} · v${d.version} · ${d.status}${isSyntheticSnapshot(d) ? ' · synthetic' : ''}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Snapshot provenance: id, hash, rows, participants, exclusions, science-file hashes. */
export function SnapshotProvenance({ snapshot }: { readonly snapshot: DatasetOut }) {
  const m = asRecord(snapshot.manifest);
  const ex = asRecord(snapshot.exclusions);
  const byReason = asRecord(ex.by_reason);
  const dict = asRecord(m.dictionary_sha256);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <DatabaseIcon className="size-3.5" aria-hidden="true" />
        <span className="font-mono" title={snapshot.snapshot_id}>
          {shortId(snapshot.snapshot_id)}
        </span>
      </span>
      <StatusBadge status={snapshot.status} />
      {isSyntheticSnapshot(snapshot) && <Badge variant="warning">Synthetic</Badge>}
      <span>
        {formatInteger(snapshot.row_count)} rows · {formatInteger(snapshot.n_participants)}{' '}
        participants
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <InfoIcon className="size-3.5" aria-hidden="true" />
            {formatInteger(typeof ex.total === 'number' ? ex.total : 0)} excluded
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {Object.keys(byReason).length === 0
            ? 'No exclusions'
            : Object.entries(byReason)
                .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${String(v)}`)
                .join(' · ')}
        </TooltipContent>
      </Tooltip>
      {snapshot.sha256 && (
        <span className="font-mono" title={`parquet sha256 ${snapshot.sha256}`}>
          sha {snapshot.sha256.slice(0, 10)}
        </span>
      )}
      {typeof m.gates_sha256 === 'string' && (
        <span className="font-mono" title={`gates.yaml sha256 ${m.gates_sha256}`}>
          gates {m.gates_sha256.slice(0, 8)}
        </span>
      )}
      {Object.keys(dict).length > 0 && (
        <span className="font-mono" title={JSON.stringify(dict)}>
          dictionary{' '}
          {Object.values(dict)
            .map((v) => String(v).slice(0, 6))
            .join('/')}
        </span>
      )}
      {snapshot.frozen_at && <span>frozen {formatDateTime(snapshot.frozen_at)}</span>}
    </div>
  );
}

export function KeyValues({
  items,
  className,
}: {
  readonly items: readonly (readonly [string, ReactNode])[];
  readonly className?: string;
}) {
  return (
    <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm', className)}>
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export { formatEstimateCI };
