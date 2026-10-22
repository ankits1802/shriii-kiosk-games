'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheckIcon, ClipboardListIcon, FileUpIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { PageHeader } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/auth-context';
import { researchKeys, useInstruments } from '../api/hooks';
import { ResultTable } from '../components/result-table';
import { StatTile } from '../components/shared';

export function licenceTone(status: string | undefined) {
  if (status === 'granted' || status === 'not_required') return 'good' as const;
  if (status === 'denied') return 'critical' as const;
  if (status === 'requested') return 'info' as const;
  return 'warning' as const;
}

export function InstrumentsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const instruments = useInstruments();
  const sync = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/instruments/sync')),
    onSuccess: async () => {
      toast.success('Registry synchronised from content/instruments.');
      await qc.invalidateQueries({ queryKey: researchKeys.instruments() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = instruments.data ?? [];
  const blocked = rows.filter((i) => (i.licensing_warnings ?? []).length > 0);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Instruments"
        description="The criterion battery: registry with licensing metadata, versions, items and scoring keys, CSV/XLSX import with column mapping and manual review, and researcher-administered tablet mode. Administered in supervised pilots only, never on the public kiosk."
        actions={
          <div className="flex flex-wrap gap-2">
            <Can all={['imports.write']}>
              <Button asChild size="sm" variant="outline">
                <Link href="/research/instruments/imports">
                  <FileUpIcon aria-hidden="true" /> Import responses
                </Link>
              </Button>
            </Can>
            <Can all={['instruments.write']}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
              >
                <RefreshCwIcon aria-hidden="true" /> Sync registry
              </Button>
            </Can>
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          icon={<ClipboardListIcon className="size-3.5" aria-hidden="true" />}
          label="Instruments"
          value={rows.length}
          sub={`${rows.filter((i) => i.kind === 'questionnaire').length} questionnaires · ${rows.filter((i) => i.kind !== 'questionnaire').length} other`}
        />
        <StatTile
          label="Licence cleared"
          value={rows.length - blocked.length}
          sub="granted or not required"
        />
        <StatTile
          label="Awaiting permission"
          value={blocked.length}
          sub="administration blocked by the API"
        />
      </div>
      {blocked.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Licensing open for {blocked.length} instrument(s)</AlertTitle>
          <AlertDescription>
            Item wording is never stored in the registry; it is loaded at administration time from
            the licensed source file. Administration is refused until permission is recorded.
          </AlertDescription>
        </Alert>
      )}
      {instruments.isPending ? (
        <LoadingState rows={8} />
      ) : instruments.isError ? (
        <ErrorState error={instruments.error} onRetry={() => void instruments.refetch()} />
      ) : (
        <ResultTable
          exportName="instrument-registry"
          rows={rows}
          rowKey={(i) => i.instrument_id}
          columns={[
            {
              key: 'name',
              header: 'Instrument',
              cell: (i) => (
                <Link
                  href={`/research/instruments/${encodeURIComponent(i.instrument_id)}`}
                  className="hover:underline"
                >
                  <span className="font-medium">{i.short_name}</span>{' '}
                  <span className="text-muted-foreground">{i.name}</span>
                </Link>
              ),
              value: (i) => i.name,
            },
            { key: 'kind', header: 'Kind', cell: (i) => i.kind, value: (i) => i.kind },
            {
              key: 'constructs',
              header: 'Constructs',
              cell: (i) => (
                <div className="flex w-72 flex-wrap gap-1">
                  {i.constructs_measured.map((c) => (
                    <Badge key={c} variant="outline">
                      {c.replaceAll('_', ' ')}
                    </Badge>
                  ))}
                </div>
              ),
              value: (i) => i.constructs_measured.join(' '),
              className: 'whitespace-normal',
            },
            {
              key: 'version',
              header: 'Version',
              cell: (i) => <span className="font-mono text-xs">{i.current_version}</span>,
              value: (i) => i.current_version,
            },
            {
              key: 'licence',
              header: 'Licence',
              cell: (i) => (
                <StatusBadge
                  status={i.licensing?.permission_status ?? 'unknown'}
                  tone={licenceTone(i.licensing?.permission_status)}
                />
              ),
              value: (i) => i.licensing?.permission_status,
            },
            {
              key: 'holder',
              header: 'Holder',
              cell: (i) => <span className="text-xs">{i.licensing?.holder ?? '—'}</span>,
              value: (i) => i.licensing?.holder,
              className: 'max-w-44 truncate',
            },
            {
              key: 'act',
              header: '',
              cell: (i) => (
                <Can all={['responses.write']}>
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/research/instruments/${encodeURIComponent(i.instrument_id)}/administer`}
                    >
                      <ClipboardCheckIcon aria-hidden="true" /> Administer
                    </Link>
                  </Button>
                </Can>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
