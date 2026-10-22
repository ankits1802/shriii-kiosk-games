'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Can } from '@/components/auth/can';
import { TimeStamp } from '@/components/data/audit-stamp';
import { DataTable, dataColumnHelper } from '@/components/data/data-table';
import { Section } from '@/components/data/page-header';
import { EmptyState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { ApprovalDialog, Hash, useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';

type ContentVersion = Schema<'ContentVersionOut'>;
const col = dataColumnHelper<ContentVersion>();

/** Hash-stamped content versions (games, instruments, dictionary, gates, hypotheses) with two-person approval. */
export function ContentVersions() {
  const api = useApi();
  const versions = useQuery({
    queryKey: adminKeys.contentVersions(),
    queryFn: () => unwrap(api.GET('/api/v1/admin/content-versions')),
  });
  const sync = useAdminMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/admin/content-versions/sync')),
    invalidate: [adminKeys.contentVersions()],
    success: (rows: ContentVersion[]) => `Stamped ${rows.length} content version(s)`,
  });
  const [target, setTarget] = useState<ContentVersion | null>(null);
  const approve = useAdminMutation({
    mutationFn: ({ id, approvers }: { id: string; approvers: string[] }) =>
      unwrap(
        api.POST('/api/v1/admin/content-versions/{version_id}/approve', {
          params: { path: { version_id: id } },
          body: { approvers },
        }),
      ),
    invalidate: [adminKeys.contentVersions()],
    success: (v: ContentVersion) => `${v.kind} ${v.version} approved`,
  });

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('kind', { header: 'Kind' }),
        col.accessor('version', {
          header: 'Version',
          cell: (c) => <code className="font-mono text-xs">{c.getValue()}</code>,
        }),
        col.accessor('sha256', {
          header: 'sha256',
          cell: (c) => <Hash value={c.getValue()} length={16} />,
          meta: { mono: true },
        }),
        col.accessor('status', {
          header: 'Status',
          cell: (c) => <StatusBadge status={c.getValue()} />,
        }),
        col.accessor((r) => r.approved_by.join(', '), { id: 'approved_by', header: 'Approved by' }),
        col.accessor('created_at', {
          header: 'Stamped',
          cell: (c) => <TimeStamp value={c.getValue()} />,
          sortFn: 'datetime',
        }),
        col.display({
          id: 'actions',
          header: '',
          cell: (c) =>
            c.row.original.status !== 'approved' ? (
              <Can all={['admin.content']}>
                <Button size="sm" variant="outline" onClick={() => setTarget(c.row.original)}>
                  <ShieldCheckIcon aria-hidden="true" />
                  Approve
                </Button>
              </Can>
            ) : null,
          meta: { noExport: true },
        }),
      ]),
    [],
  );

  return (
    <Section
      title="Content versions"
      description="Hash stamps of games, instruments, dictionary, gates and hypotheses. Sessions record the stamp they ran under (PLT-03)."
      actions={
        <Can all={['admin.content']}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sync.mutate(undefined)}
            disabled={sync.isPending}
          >
            <RefreshCwIcon className={cn(sync.isPending && 'animate-spin')} aria-hidden="true" />
            Stamp current content
          </Button>
        </Can>
      }
    >
      <DataTable
        data={versions.data}
        columns={columns}
        getRowId={(r) => r.id}
        isLoading={versions.isPending}
        error={versions.error}
        onRetry={() => void versions.refetch()}
        initialSort={{ id: 'created_at', desc: true }}
        pageSize={10}
        exportName="content-versions"
        empty={
          <EmptyState
            title="No content versions stamped yet"
            description="Stamp current content to record hashes for review and approval."
          />
        }
      />
      <ApprovalDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) {
            setTarget(null);
            approve.reset();
          }
        }}
        title="Approve content version"
        description="Content approval needs two different named people (two-person rule, enforced by the API)."
        subject={target ? `${target.kind} ${target.version} · ${target.sha256.slice(0, 16)}` : ''}
        pending={approve.isPending}
        error={approve.error}
        onApprove={(approvers) =>
          target &&
          approve.mutate({ id: target.id, approvers }, { onSuccess: () => setTarget(null) })
        }
      />
    </Section>
  );
}
