'use client';

/**
 * Validation runs on a snapshot (status, engine, provenance) and queueing new analyses. Confirmatory
 * runs need a frozen snapshot, a registered analysis plan and registered hypothesis ids (API-checked).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { Section } from '@/components/data/page-header';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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
import { formatDateTime, shortId } from '@/lib/format';
import { researchKeys } from '../api/hooks';
import { ANALYSES, asRecord, type DatasetOut, type RunOut } from '../api/types';
import { ResultTable } from '../components/result-table';
import type { ScienceConfig } from '../lib/science';

const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  measurement_invariance: { groupings: ['language'] },
  dif: { groupings: ['language'] },
  fairness: { groupings: ['language'] },
};

export function RunsPanel({
  snapshot,
  runs,
  science,
  intro,
}: {
  readonly snapshot: DatasetOut | null;
  readonly runs: readonly RunOut[];
  readonly science: ScienceConfig;
  readonly intro?: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [analysis, setAnalysis] = useState<string>('reliability');
  const [confirmatory, setConfirmatory] = useState(false);
  const primary = science.hypotheses.items.filter((h) => h.family === 'primary').map((h) => h.id);
  const frozen = snapshot?.status === 'frozen';
  const queue = useMutation({
    mutationFn: async (which: readonly string[]) => {
      for (const a of which) {
        await unwrap(
          api.POST('/api/v1/validation/runs', {
            body: {
              snapshot_id: snapshot?.snapshot_id ?? '',
              analysis: a,
              params: DEFAULT_PARAMS[a] ?? {},
              confirmatory: confirmatory && a === 'construct_validity',
              hypothesis_ids: confirmatory && a === 'construct_validity' ? primary : [],
            },
          }),
        );
      }
      return which.length;
    },
    onSuccess: async (n) => {
      toast.success(`${n} analysis run(s) queued.`);
      await qc.invalidateQueries({ queryKey: researchKeys.runs(snapshot?.snapshot_id ?? '') });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!snapshot) return null;
  return (
    <Section
      title="Validation runs"
      description={intro ?? 'Every run records its engine, inputs hash, snapshot and git sha.'}
    >
      <Can all={['validation.run']}>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor="analysis-select" className="text-xs">
              Analysis
            </Label>
            <Select value={analysis} onValueChange={setAnalysis}>
              <SelectTrigger id="analysis-select" size="sm" className="min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANALYSES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="confirmatory">
            <Checkbox
              id="confirmatory"
              checked={confirmatory}
              disabled={!frozen}
              onCheckedChange={(v) => setConfirmatory(v === true)}
            />
            Confirmatory (primary hypotheses, frozen snapshot)
          </label>
          <Button size="sm" onClick={() => queue.mutate([analysis])} disabled={queue.isPending}>
            <PlayIcon aria-hidden="true" /> Queue
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => queue.mutate(ANALYSES)}
            disabled={queue.isPending}
          >
            Queue the full plan
          </Button>
        </div>
      </Can>
      <ResultTable
        exportName="validation-runs"
        studyId={snapshot.study_id}
        rows={runs}
        rowKey={(r) => r.run_id}
        empty="No runs yet."
        columns={[
          {
            key: 'a',
            header: 'Analysis',
            cell: (r) => r.analysis.replaceAll('_', ' '),
            value: (r) => r.analysis,
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => <StatusBadge status={r.status} />,
            value: (r) => r.status,
          },
          {
            key: 'c',
            header: 'Kind',
            cell: (r) => (r.confirmatory ? 'confirmatory' : 'exploratory'),
            value: (r) => (r.confirmatory ? 'confirmatory' : 'exploratory'),
          },
          {
            key: 'e',
            header: 'Engine',
            cell: (r) => <span className="font-mono text-xs">{r.engine ?? '—'}</span>,
            value: (r) => r.engine,
          },
          {
            key: 'g',
            header: 'git',
            cell: (r) => (
              <span className="font-mono text-xs">
                {String(
                  asRecord(asRecord(r.manifest).provenance).git_sha ??
                    asRecord(r.manifest).git_sha ??
                    '—',
                ).slice(0, 8)}
              </span>
            ),
            value: (r) => String(asRecord(r.manifest).git_sha ?? ''),
          },
          {
            key: 'id',
            header: 'Run',
            cell: (r) => (
              <span className="font-mono text-xs" title={r.run_id}>
                {shortId(r.run_id)}
              </span>
            ),
            value: (r) => r.run_id,
          },
          { key: 'by', header: 'By', cell: (r) => r.created_by, value: (r) => r.created_by },
          {
            key: 'at',
            header: 'Finished',
            cell: (r) => (r.finished_at ? formatDateTime(r.finished_at) : '—'),
            value: (r) => r.finished_at,
          },
          {
            key: 'err',
            header: 'Error',
            cell: (r) => <span className="text-xs text-destructive">{r.error ?? ''}</span>,
            value: (r) => r.error,
          },
        ]}
      />
    </Section>
  );
}
