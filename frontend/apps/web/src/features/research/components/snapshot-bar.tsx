'use client';

/**
 * Study + dataset-snapshot selection shared by the validation, models, analytics and reports pages.
 * Every statistic on those pages comes from one snapshot, named in the bar with its provenance.
 */
import { DatabaseIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/data/states';
import { Button } from '@/components/ui/button';
import { useDatasets } from '../api/hooks';
import type { DatasetOut, StudyOut } from '../api/types';
import { useUrlState } from '../lib/url-state';
import {
  defaultSnapshot,
  isSyntheticSnapshot,
  SnapshotProvenance,
  SnapshotSelect,
  StudySelect,
  SyntheticNotice,
  useFocusStudy,
} from './shared';

export interface SnapshotSelection {
  readonly study: StudyOut | null;
  readonly snapshot: DatasetOut | null;
  readonly datasets: readonly DatasetOut[];
  readonly synthetic: boolean;
  readonly bar: ReactNode;
  /** Loading / error / empty state to render instead of the page body, if any. */
  readonly blocker: ReactNode | null;
}

export function useSnapshotSelection(): SnapshotSelection {
  const { study, studies, isLoading, setStudyId } = useFocusStudy();
  const datasets = useDatasets(study?.study_id ?? null);
  const [snapshotParam, setSnapshotParam] = useUrlState('snapshot');
  const list = datasets.data ?? [];
  const readable = list.filter((d) => d.status === 'ready' || d.status === 'frozen');
  const snapshot =
    readable.find((d) => d.snapshot_id === snapshotParam) ?? defaultSnapshot(list) ?? null;
  const synthetic = isSyntheticSnapshot(snapshot);

  let blocker: ReactNode | null = null;
  if (isLoading || (study && datasets.isPending)) blocker = <LoadingState rows={4} />;
  else if (!study)
    blocker = (
      <EmptyState
        title="No study in scope"
        description="Create a study (or ask for access to one) to see its validation evidence."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/research/studies">Go to studies</Link>
          </Button>
        }
      />
    );
  else if (datasets.isError)
    blocker = <ErrorState error={datasets.error} onRetry={() => void datasets.refetch()} />;
  else if (!snapshot)
    blocker = (
      <EmptyState
        icon={DatabaseIcon}
        title="No analysis snapshot yet"
        description="Build a matched participant × occasion snapshot in Studies → Datasets, then run the analyses. Statistics are only ever computed from a snapshot."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={`/research/studies/${encodeURIComponent(study.study_id)}?tab=datasets`}>
              Open datasets
            </Link>
          </Button>
        }
      />
    );

  const bar = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {studies.length > 1 && (
          <StudySelect
            value={study?.study_id ?? null}
            studies={studies}
            onChange={(id) => {
              setStudyId(id);
              setSnapshotParam(null);
            }}
          />
        )}
        {readable.length > 0 && (
          <SnapshotSelect
            datasets={readable}
            value={snapshot?.snapshot_id ?? null}
            onChange={(id) => setSnapshotParam(id)}
          />
        )}
      </div>
      {snapshot && <SnapshotProvenance snapshot={snapshot} />}
      <SyntheticNotice show={synthetic} />
    </div>
  );
  return { study, snapshot, datasets: list, synthetic, bar, blocker };
}
